import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionState, GatewayEvent } from "../../packages/hermes-compat/src/upstream/json-rpc-gateway.ts";
import { HermesRealtimeClient } from "../../apps/web/src/hermes-realtime-client.ts";

class FakeGateway {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  connectedUrl = "";
  connectedUrls: string[] = [];
  eventHandler: ((event: GatewayEvent) => void) | null = null;
  state: ConnectionState = "idle";
  stateHandlers = new Set<(state: ConnectionState) => void>();

  async connect(url: string): Promise<void> {
    this.connectedUrl = url;
    this.connectedUrls.push(url);
    this.setState("open");
  }
  close(): void { this.setState("closed"); }
  onAny(handler: (event: GatewayEvent) => void): () => void {
    this.eventHandler = handler;
    return () => { this.eventHandler = null; };
  }
  onState(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    handler(this.state);
    return () => { this.stateHandlers.delete(handler); };
  }
  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "session.create") {
      return { session_id: "runtime-1", stored_session_id: "stored-1", messages: [], info: {} } as T;
    }
    if (method === "session.resume") {
      return { session_id: "runtime-2", stored_session_id: "stored-1", messages: [] } as T;
    }
    return { accepted: true } as T;
  }
  emit(event: GatewayEvent): void { this.eventHandler?.(event); }
  setState(state: ConnectionState): void {
    this.state = state;
    for (const handler of this.stateHandlers) handler(state);
  }
}

const location = {
  origin: "https://termes.example",
  protocol: "https:",
} as Location;

test("단일 사용 ticket으로 wss 연결하고 Hermes 원본 메서드를 호출한다", async () => {
  const gateway = new FakeGateway();
  const fetcher = async () => new Response(JSON.stringify({
    ticket: "one-time",
    expiresIn: 30,
    wsPath: "/api/hermes/ws",
  }), { status: 201, headers: { "content-type": "application/json" } });
  const client = new HermesRealtimeClient(gateway, fetcher as typeof fetch, location);

  await client.connect({ projectId: "p1", taskId: "t1" });
  assert.equal(gateway.connectedUrl, "wss://termes.example/api/hermes/ws?ticket=one-time");
  const session = await client.createSession({ cwd: "/workspace/project", title: "모바일 질문" });
  await client.submitPrompt(session.session_id, "상태를 분석해 주세요");

  assert.deepEqual(gateway.calls, [
    {
      method: "session.create",
      params: {
        cwd: "/workspace/project",
        source: "termes-mobile",
        close_on_disconnect: false,
        title: "모바일 질문",
      },
    },
    { method: "prompt.submit", params: { session_id: "runtime-1", text: "상태를 분석해 주세요" } },
  ]);
  client.close();
});

test("수신 이벤트를 세션 projection으로 만들고 도구 앞의 text를 먼저 확정한다", async () => {
  const gateway = new FakeGateway();
  const client = new HermesRealtimeClient(
    gateway,
    (async () => new Response(JSON.stringify({ ticket: "t", expiresIn: 30, wsPath: "/ws" }), { status: 201 })) as typeof fetch,
    location,
  );
  await client.connect();
  await client.createSession({ cwd: "/workspace" });
  const snapshots: string[][] = [];
  client.onStream((state) => snapshots.push(state.parts.map((part) => part.type)));

  gateway.emit({ type: "message.delta", session_id: "runtime-1", payload: { text: "설명" } });
  gateway.emit({ type: "tool.start", session_id: "runtime-1", payload: { name: "terminal", tool_id: "t1" } });

  assert.deepEqual(client.stream("runtime-1").parts.map((part) => part.type), ["text", "tool-call"]);
  assert.deepEqual(snapshots.at(-1), ["text", "tool-call"]);
  client.close();
});

test("interaction별 Hermes 응답 파라미터에서 비밀값을 projection에 저장하지 않는다", async () => {
  const gateway = new FakeGateway();
  const client = new HermesRealtimeClient(gateway, fetch as typeof fetch, location);
  await client.respond("s", { type: "secret", requestId: "r1", envVar: "TOKEN", prompt: "입력" }, "private");
  await client.respond("s", { type: "approval", command: "cmd", description: "run", allowPermanent: true }, true);

  assert.deepEqual(gateway.calls, [
    { method: "secret.respond", params: { session_id: "s", request_id: "r1", value: "private" } },
    { method: "approval.respond", params: { session_id: "s", choice: "once" } },
  ]);
  assert.equal(JSON.stringify(client.stream("s")).includes("private"), false);
});

test("연결 단절 시 새 ticket을 발급하고 stored session을 새 live id로 resume한다", async () => {
  const gateway = new FakeGateway();
  let ticketSequence = 0;
  const fetcher = async () => {
    ticketSequence += 1;
    return new Response(JSON.stringify({
      ticket: `ticket-${ticketSequence}`,
      expiresIn: 30,
      wsPath: "/api/hermes/ws",
    }), { status: 201 });
  };
  const client = new HermesRealtimeClient(gateway, fetcher as typeof fetch, location);
  await client.connect({ taskId: "task-1" });
  const session = await client.createSession({ cwd: "/workspace" });

  gateway.setState("closed");
  await client.reconnectNow();
  await client.submitPrompt(session.session_id, "재연결 이후 질문");

  assert.equal(ticketSequence, 2);
  assert.match(gateway.connectedUrls[1] || "", /ticket=ticket-2/);
  assert.deepEqual(gateway.calls.slice(-2), [
    {
      method: "session.resume",
      params: { session_id: "stored-1", cols: 96, source: "termes-mobile" },
    },
    {
      method: "prompt.submit",
      params: { session_id: "runtime-2", text: "재연결 이후 질문" },
    },
  ]);
  assert.equal(client.stream(session.session_id).sessionId, "runtime-2");
  client.close();
});

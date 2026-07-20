import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

import { HermesRoutingSpecialist } from "../../services/orchestrator/src/routing-specialist.ts";

function fastDirectDecision(answer = "네, 정상적으로 응답하고 있습니다. 무엇을 도와드릴까요?") {
  return {
    questionType: "conversation", contextType: "current-turn", domain: "general",
    professionalRequired: false, answer,
  };
}

function fastProfessionalDecision() {
  return {
    questionType: "coding", contextType: "project-state", domain: "security",
    professionalRequired: true, answer: null,
  };
}

function criticalDecision() {
  const risks = ["auth-or-secret", "production-or-deploy", "multi-account-isolation"];
  const secondary = ["operations", "software"];
  const reasonCodes = ["routing-agent-critical-auth-isolation"];
  const specialists = [
    { domain: "security", role: "OAuth Isolation Specialist", mission: "OAuth 계정 경계를 구현하고 검증한다.", toolsets: ["file", "terminal"], required: true },
    { domain: "operations", role: "Sandbox Runtime Specialist", mission: "계정별 샌드박스 경계를 구현하고 검증한다.", toolsets: ["file", "terminal"], required: true },
    { domain: "general", role: "Independent Critic", mission: "설계 반례와 누락을 독립 검토한다.", toolsets: ["file", "terminal"], required: true },
    { domain: "software", role: "Evidence Verifier", mission: "코드와 테스트 증거를 재현한다.", toolsets: ["file", "terminal"], required: true },
  ];
  return {
    intent: "implementation", route: "critical-synthesis", primaryDomain: "security", secondaryDomains: secondary, riskSignals: risks,
    contextRequirement: "project-state", action: "implement", target: "security", scope: "project-state",
    requiresMutation: true, requiresInspection: true, reasonCodes, specialists,
    capabilities: ["runner-worktree-verification"],
    directAnswer: null,
  };
}

function emitComplete(socket: import("ws").WebSocket, sessionId: string, decision: unknown): void {
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
    type: "message.complete", session_id: sessionId, payload: { text: JSON.stringify(decision) },
  } }));
}

test("Fast Routing Agent가 컨텍스트를 먼저 분류하고 전문 요청에만 Planner Agent를 실행한다", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer service");
    const url = new URL(request.url || "/", "http://localhost");
    assert.equal(url.searchParams.get("account_id"), "account-a");
    assert.equal(url.searchParams.get("workspace_id"), "workspace-a");
    assert.equal(url.searchParams.get("runtime_cell_id"), "cell-a");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let resumeCount = 0;
  let createCount = 0;
  let promptCount = 0;
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
    if (frame.method === "session.resume") {
      resumeCount += 1;
      assert.equal(frame.params.session_id, "stale-router-stored");
      assert.equal(frame.params.auto_title, false);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32004, message: "session not found" } }));
      return;
    }
    if (frame.method === "session.create") {
      createCount += 1;
      assert.equal(frame.params.model, "gpt-5.4-mini");
      assert.equal(frame.params.provider, "openai-codex");
      assert.equal(frame.params.reasoning_effort, "none");
      assert.equal(frame.params.fast, true);
      assert.equal(frame.params.auto_title, false);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "router-live", stored_session_id: "router-stored" } }));
      return;
    }
    assert.equal(frame.method, "prompt.submit");
    promptCount += 1;
    if (promptCount === 1) assert.equal(frame.params.truncate_before_user_ordinal, undefined);
    if (promptCount > 1) assert.equal(frame.params.truncate_before_user_ordinal, 0);
    if (promptCount === 3) {
      assert.match(String(frame.params.text), /Classify the context first/);
      assert.doesNotMatch(String(frame.params.text), /Specialist shape/);
    }
    if (promptCount === 4) {
      assert.match(String(frame.params.text), /Professional Planner Agent/);
      assert.match(String(frame.params.text), /"professionalRequired":true/);
    }
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
    const decision = promptCount <= 2
      ? fastDirectDecision()
      : promptCount === 3
        ? fastProfessionalDecision()
        : criticalDecision();
    emitComplete(socket, "router-live", decision);
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const router = new HermesRoutingSpecialist({
    managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    serviceToken: "service", accountId: "account-a", workspaceId: "workspace-a", runtimeCellId: "cell-a",
    cwd: "/workspace", timeoutMs: 2_000, storedSessionId: "stale-router-stored",
  });
  try {
    const screened: Array<{ professionalRequired: boolean; durationMs: number }> = [];
    const first = await router.classify("응답해볼래?", "", undefined, (decision, durationMs) => {
      screened.push({ professionalRequired: decision.professionalRequired, durationMs });
    });
    assert.equal(first.decision.route, "instant");
    assert.equal(first.decision.source, "routing-specialist");
    assert.equal(first.planningDurationMs, 0);
    const second = await router.classify("운영 OAuth 계정 격리를 구현하고 배포해", "", undefined, (decision, durationMs) => {
      screened.push({ professionalRequired: decision.professionalRequired, durationMs });
    });
    assert.equal(second.decision.route, "critical-synthesis");
    assert.ok(second.planningDurationMs >= 0);
    assert.deepEqual(second.decision.agentPlan.specialists.map((entry) => entry.role), [
      "OAuth Isolation Specialist", "Sandbox Runtime Specialist", "Independent Critic", "Evidence Verifier",
    ]);
    assert.equal(resumeCount, 1);
    assert.equal(createCount, 1);
    assert.deepEqual(screened.map((entry) => entry.professionalRequired), [false, true]);
    assert.equal(promptCount, 4);
    assert.equal(router.identity.storedSessionId, "router-stored");
  } finally {
    router.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("시간 초과된 분류 세션은 interrupt 후 폐기되어 늦은 완료 이벤트와 새 Agent 판단이 섞이지 않는다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let connectionCount = 0;
  let createCount = 0;
  let interruptCount = 0;
  wss.on("connection", (socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
      if (frame.method === "session.create") {
        createCount += 1;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: connection === 1 ? "timed-out-live" : "fresh-live",
          stored_session_id: connection === 1 ? "timed-out-stored" : "fresh-stored",
        } }));
        return;
      }
      if (frame.method === "session.interrupt") {
        interruptCount += 1;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "interrupted" } }));
        return;
      }
      assert.equal(frame.method, "prompt.submit");
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
      if (connection === 2) emitComplete(socket, "fresh-live", fastDirectDecision("두 번째 세션의 Agent 판단입니다."));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const router = new HermesRoutingSpecialist({
    managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    serviceToken: "service", accountId: "account-a", workspaceId: "workspace-a", runtimeCellId: "cell-a",
    cwd: "/workspace", timeoutMs: 40, preparationTimeoutMs: 40,
  });
  try {
    await assert.rejects(() => router.classify("첫 번째 질문", ""), /response timed out/);
    assert.equal(router.identity.ready, false);
    const recovered = await router.classify("두 번째 질문", "");
    assert.equal(recovered.decision.route, "instant");
    assert.equal(createCount, 2);
    assert.equal(interruptCount, 1);
    assert.equal(connectionCount, 2);
    assert.equal(router.identity.storedSessionId, "fresh-stored");
  } finally {
    router.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("저장 세션을 resume한 뒤 준비 턴과 실제 분류 턴 모두 과거 사용자 이력을 절단한다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const truncateValues: unknown[] = [];
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
    if (frame.method === "session.resume") {
      assert.equal(frame.params.auto_title, false);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: "resumed-live", stored_session_id: "resumed-stored" } }));
      return;
    }
    truncateValues.push(frame.params.truncate_before_user_ordinal);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
    emitComplete(socket, "resumed-live", fastDirectDecision());
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const router = new HermesRoutingSpecialist({
    managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    serviceToken: "service", accountId: "account-a", workspaceId: "workspace-a", runtimeCellId: "cell-a",
    cwd: "/workspace", timeoutMs: 2_000, storedSessionId: "resumed-stored",
  });
  try {
    await router.classify("응답해볼래?", "");
    assert.deepEqual(truncateValues, [0, 0]);
  } finally {
    router.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("live session 유실 후에는 같은 stored session을 재개하고 준비를 다시 마친 뒤 분류한다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let connections = 0;
  wss.on("connection", (socket) => {
    connections += 1;
    const connection = connections;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      if (frame.method === "session.resume") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { session_id: `live-${connection}`, stored_session_id: "stored-router" } }));
      } else if (connection === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32004, message: "session not found" } }));
      } else {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
        emitComplete(socket, `live-${connection}`, fastDirectDecision("복구된 Routing Agent 판단입니다."));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const router = new HermesRoutingSpecialist({
    managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    serviceToken: "service", accountId: "account-a", workspaceId: "workspace-a", runtimeCellId: "cell-a",
    cwd: "/workspace", timeoutMs: 2_000, storedSessionId: "stored-router",
  });
  try {
    await assert.rejects(() => router.classify("첫 질문", ""), /session not found/);
    const recovered = await router.classify("두 번째 질문", "");
    assert.equal(recovered.decision.route, "instant");
    assert.equal(connections, 2);
  } finally {
    router.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

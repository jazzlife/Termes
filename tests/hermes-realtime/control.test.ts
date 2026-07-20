import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

import type { ApiConfig } from "../../apps/api/src/config.ts";
import { requestHermesControl } from "../../apps/api/src/hermes-rpc-control.ts";

const controlScope = {
  accountId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "10000000-0000-0000-0000-000000000001",
  runtimeCellId: "20000000-0000-0000-0000-000000000001",
};

async function startControlServer(
  handle: (frame: { id: string; method: string; params: Record<string, unknown> }) => unknown,
): Promise<{ config: ApiConfig; methods: string[]; close: () => Promise<void> }> {
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://manager.test");
    if (
      url.pathname === "/internal/gateway/connection"
      && url.searchParams.get("profile") === "default"
      && url.searchParams.get("account_id") === "00000000-0000-0000-0000-000000000001"
      && url.searchParams.get("workspace_id") === "10000000-0000-0000-0000-000000000001"
      && url.searchParams.get("runtime_cell_id") === "20000000-0000-0000-0000-000000000001"
      && request.headers.authorization === "Bearer service-token"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
      return;
    }
    response.writeHead(401).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      methods.push(frame.method);
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: handle(frame) }));
      } catch (error) {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { message: error instanceof Error ? error.message : String(error) },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const managerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    config: {
      host: "127.0.0.1",
      port: 0,
      databaseUrl: "postgres://unused",
      redisUrl: "redis://unused",
      migrationsDir: "/unused",
      hermesManagerUrl: managerUrl,
      hermesManagerServiceToken: "service-token",
      deviceGatewayUrl: "http://unused",
      singleAccountId: "00000000-0000-0000-0000-000000000001",
      singleWorkspaceId: "10000000-0000-0000-0000-000000000001",
      singleRuntimeCellId: "20000000-0000-0000-0000-000000000001",
    },
    methods,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("제어 소켓은 live session을 resume하지 않고 승인 응답만 정확히 전달한다", async () => {
  const received: Array<{ method: string; params: Record<string, unknown> }> = [];
  const control = await startControlServer((frame) => {
    received.push({ method: frame.method, params: frame.params });
    return { resolved: 1 };
  });
  try {
    const result = await requestHermesControl<{ resolved: number }>(control.config, controlScope, "approval.respond", {
      choice: "once",
      session_id: "live-session-1",
    });
    assert.deepEqual(result, { resolved: 1 });
    assert.deepEqual(received, [{
      method: "approval.respond",
      params: { choice: "once", session_id: "live-session-1" },
    }]);
    assert.equal(control.methods.includes("session.resume"), false);
  } finally {
    await control.close();
  }
});

test("Hermes JSON-RPC 오류를 성공으로 취급하지 않는다", async () => {
  const control = await startControlServer(() => {
    throw new Error("no pending secret request");
  });
  try {
    await assert.rejects(
      requestHermesControl(control.config, controlScope, "secret.respond", { request_id: "secret-1", value: "redacted" }),
      /no pending secret request/,
    );
  } finally {
    await control.close();
  }
});

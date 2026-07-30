import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import websocket from "../../apps/api/node_modules/@fastify/websocket/index.js";
import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import type Redis from "ioredis";
import WebSocket, { WebSocketServer } from "../../apps/api/node_modules/ws/wrapper.mjs";
import {
  AsyncFrameMirror,
  CellFrameMirrorRegistry,
  registerHermesRealtime,
} from "../../apps/api/src/hermes-realtime";
import type { ApiConfig } from "../../apps/api/src/config";
import type { Db } from "../../apps/api/src/db";

class MemoryRedis {
  readonly values = new Map<string, string>();
  readonly mirrored: string[][] = [];
  failuresRemaining = 0;

  async set(key: string, value: string): Promise<"OK"> {
    assert.equal(this.values.has(key), false);
    this.values.set(key, value);
    return "OK";
  }

  async getdel(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }

  async xadd(...args: string[]): Promise<string> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("temporary redis failure");
    }
    this.mirrored.push(args);
    return `${this.mirrored.length}-0`;
  }
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function waitForMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket message timed out")), 3000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

const mirrorRecord = {
  accountId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "10000000-0000-0000-0000-000000000001",
  runtimeCellId: "20000000-0000-0000-0000-000000000001",
  projectId: null,
  taskId: null,
  direction: "upstream_to_client" as const,
  frame: JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "message.delta" } }),
};

const defaultPrincipal = {
  memberId: "30000000-0000-0000-0000-000000000001",
  accountId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "10000000-0000-0000-0000-000000000001",
  runtimeCellId: "20000000-0000-0000-0000-000000000001",
  email: "master@termes.local",
  displayName: "Master",
  workspaceKey: "default",
  workspaceRoot: "/workspace",
  canManageSharedOAuth: true,
  canApproveMembers: true,
};

test("mirror는 Redis 영속화 완료 전 프레임을 전달하지 않고 고정 길이 삭제를 사용하지 않는다", async () => {
  let release!: (id: string) => void;
  const persisted = new Promise<string>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const redis = { async xadd(...args: string[]) { calls.push(args); return persisted; } };
  const mirror = new AsyncFrameMirror(redis as never, { error() {} } as never);
  let delivered = false;
  assert.equal(mirror.push(mirrorRecord, () => { delivered = true; }), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered, false);
  release("1-0");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(delivered, true);
  assert.equal(calls[0]?.includes("MAXLEN"), false);
});

test("mirror 적재 한계 초과는 무음 유실 대신 명시적인 backpressure를 반환한다", () => {
  const redis = { async xadd() { return new Promise<string>(() => {}); } };
  const mirror = new AsyncFrameMirror(redis as never, { error() {} } as never);
  for (let index = 0; index < 512; index += 1) {
    assert.equal(mirror.push(mirrorRecord, () => {}), true);
  }
  assert.equal(mirror.push(mirrorRecord, () => {}), false);
});

test("한 Account Cell의 Redis 지연은 다른 Cell 프레임 전달을 막지 않는다", async () => {
  let releaseCellA!: (id: string) => void;
  const blockedCellA = new Promise<string>((resolve) => { releaseCellA = resolve; });
  const redis = {
    async xadd(...args: string[]) {
      const runtimeCellId = args[args.indexOf("runtime_cell_id") + 1];
      return runtimeCellId === mirrorRecord.runtimeCellId ? blockedCellA : "2-0";
    },
  };
  const registry = new CellFrameMirrorRegistry(redis as never, { error() {} } as never);
  let deliveredA = false;
  let deliveredB = false;
  registry.push(mirrorRecord, () => { deliveredA = true; });
  registry.push({
    ...mirrorRecord,
    accountId: "00000000-0000-0000-0000-000000000002",
    workspaceId: "10000000-0000-0000-0000-000000000002",
    runtimeCellId: "20000000-0000-0000-0000-000000000002",
  }, () => { deliveredB = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deliveredA, false);
  assert.equal(deliveredB, true);
  releaseCellA("1-0");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(deliveredA, true);
});

test("single-use Termes ticket relays Hermes frames unchanged and mirrors unknown events", async (t) => {
  const upstreamServer = createServer();
  const upstreamWs = new WebSocketServer({ server: upstreamServer });
  const unknownEvent = JSON.stringify({
    jsonrpc: "2.0",
    method: "event",
    params: { type: "future.event", session_id: "s-1", payload: { text: "future" } },
  });
  upstreamWs.on("connection", (socket) => {
    socket.send(unknownEvent);
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  const upstreamPort = await listen(upstreamServer);

  const managerServer = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer manager-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${upstreamPort}` }));
  });
  const managerPort = await listen(managerServer);

  const redis = new MemoryRedis();
  redis.failuresRemaining = 1;
  const db = {
    pool: {
      query: async (sql: string) => {
        if (/from account_workspaces/i.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (/from account_members/i.test(sql)) {
          return { rows: [{ auth_session_version: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    },
    close: async () => {},
  } as unknown as Db;
  const config = {
    hermesManagerUrl: `http://127.0.0.1:${managerPort}`,
    hermesManagerServiceToken: "manager-secret",
    singleAccountId: "00000000-0000-0000-0000-000000000001",
    singleWorkspaceId: "10000000-0000-0000-0000-000000000001",
    singleRuntimeCellId: "20000000-0000-0000-0000-000000000001",
  } as ApiConfig;

  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerHermesRealtime(app, {
    config,
    db,
    redis: redis as unknown as Redis,
    principalForRequest: () => defaultPrincipal,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await app.close();
    upstreamWs.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await new Promise<void>((resolve) => managerServer.close(() => resolve()));
  });

  const ticketResponse = await fetch(`${baseUrl}/api/hermes/realtime-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(ticketResponse.status, 201);
  const { ticket } = await ticketResponse.json() as { ticket: string };

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/hermes/ws?ticket=${encodeURIComponent(ticket)}`);
  const first = await waitForMessage(client);
  assert.equal(first, unknownEvent);

  const requestFrame = JSON.stringify({ jsonrpc: "2.0", id: "r1", method: "session.list", params: {} });
  client.send(requestFrame);
  assert.equal(await waitForMessage(client), requestFrame);

  const blockedFrame = JSON.stringify({
    jsonrpc: "2.0",
    id: "blocked-1",
    method: "model.save_key",
    params: { provider: "openai", key: "must-not-reach-upstream" },
  });
  client.send(blockedFrame);
  const blockedResponse = JSON.parse(await waitForMessage(client)) as {
    id: string;
    error: { code: number; message: string };
  };
  assert.equal(blockedResponse.id, "blocked-1");
  assert.equal(blockedResponse.error.code, -32001);
  assert.match(blockedResponse.error.message, /shared-account policy blocks model\.save_key/);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(redis.mirrored.some((row) => row.some((value) => value.includes("future.event"))));
  assert.equal(redis.mirrored.some((row) => row.includes("MAXLEN")), false);

  const reused = new WebSocket(`ws://127.0.0.1:${address.port}/api/hermes/ws?ticket=${encodeURIComponent(ticket)}`);
  const reusedClose = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("reused ticket close timed out")), 3000);
    reused.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(reusedClose, 4401);
  client.close();
});

test("client open 직후 보낸 첫 JSON-RPC 프레임을 manager 조회 중에도 보존한다", async (t) => {
  const upstreamServer = createServer();
  const upstreamWs = new WebSocketServer({ server: upstreamServer });
  upstreamWs.on("connection", (socket) => {
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  const upstreamPort = await listen(upstreamServer);

  const managerServer = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${upstreamPort}` }));
    }, 150);
  });
  const managerPort = await listen(managerServer);

  const redis = new MemoryRedis();
  const db = {
    pool: { query: async (sql: string) => {
      if (/from account_workspaces/i.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (/from account_members/i.test(sql)) {
        return { rows: [{ auth_session_version: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    } },
    close: async () => {},
  } as unknown as Db;
  const config = {
    hermesManagerUrl: `http://127.0.0.1:${managerPort}`,
    hermesManagerServiceToken: "manager-secret",
    singleAccountId: "00000000-0000-0000-0000-000000000001",
    singleWorkspaceId: "10000000-0000-0000-0000-000000000001",
    singleRuntimeCellId: "20000000-0000-0000-0000-000000000001",
  } as ApiConfig;
  const app = Fastify({ logger: false });
  await app.register(websocket);
  await registerHermesRealtime(app, {
    config,
    db,
    redis: redis as unknown as Redis,
    principalForRequest: () => defaultPrincipal,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");

  t.after(async () => {
    await app.close();
    upstreamWs.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
    await new Promise<void>((resolve) => managerServer.close(() => resolve()));
  });

  const ticketResponse = await fetch(`http://127.0.0.1:${address.port}/api/hermes/realtime-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const { ticket } = await ticketResponse.json() as { ticket: string };
  const requestFrame = JSON.stringify({ jsonrpc: "2.0", id: "immediate", method: "session.create", params: {} });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/hermes/ws?ticket=${encodeURIComponent(ticket)}`);
  client.once("open", () => client.send(requestFrame));

  assert.equal(await waitForMessage(client), requestFrame);
  client.close();
});

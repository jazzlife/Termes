import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  executeHermesJsonRpcRun,
  recoverLatestAssistantText,
  recoverHermesResumeEvidence,
} from "../../services/orchestrator/src/hermes-json-rpc-runner.ts";

test("direct 세션 복구는 delegation ledger 없이 최신 assistant 응답을 사용한다", () => {
  assert.equal(recoverLatestAssistantText([
    { role: "user", text: "응답해볼래?" },
    { role: "assistant", text: "네, 정상적으로 응답합니다." },
  ]), "네, 정상적으로 응답합니다.");
});

test("Hermes가 저장한 async delegation ledger에서 완료·실패와 최종 합성을 복구한다", () => {
  const evidence = recoverHermesResumeEvidence([
    { role: "user", text: "질문" },
    {
      role: "system",
      text: [
        "[ASYNC DELEGATION BATCH COMPLETE — d1]",
        "--- ✓ TASK 1/3: security (status=completed) ---",
        "ok",
        "--- ✓ TASK 2/3: runtime (status=completed) ---",
        "ok",
        "--- ✗ TASK 3/3: critic (status=failed) ---",
        "failed",
      ].join("\n"),
    },
    { role: "assistant", text: "검증 후 생성된 최종 합성" },
  ]);
  assert.deepEqual(evidence, {
    completedSpecialists: 2,
    failedSpecialists: 1,
    finalAssistantText: "검증 후 생성된 최종 합성",
    hasAuthoritativeDelegationLedger: true,
  });
});

test("오케스트레이터가 polling 없이 JSON-RPC 완료와 subagent 이벤트를 수집한다", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/hermes/realtime-ticket" && request.method === "POST") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ticket: "single-use", wsPath: "/ws", expiresIn: 30 }));
      return;
    }
    if (request.url === "/internal/gateway/connection?profile=default" && request.headers.authorization === "Bearer service") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
      return;
    }
    response.writeHead(401).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
      if (frame.method === "session.create") {
        assert.equal(frame.params.auto_title, false);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "runtime-1", stored_session_id: "stored-1", info: { model: "openai-codex/model" },
        } }));
        return;
      }
      assert.equal(frame.method, "prompt.submit");
      assert.match(String(frame.params.text), /delegate_task/);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { accepted: true } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "subagent.start", session_id: "runtime-1", payload: { id: "child-1", name: "Security Specialist" },
      } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "message.delta", session_id: "runtime-1", payload: { text: "검증된 " },
      } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "subagent.complete", session_id: "runtime-1", payload: {
          child_session_id: "child-1", status: "completed", summary: "검증 완료",
        },
      } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "message.complete", session_id: "runtime-1", payload: { text: "검증된 최종 응답", usage: { total_tokens: 10 } },
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      serviceToken: "service",
      realtimeBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      projectId: "00000000-0000-0000-0000-000000000101",
      taskId: "00000000-0000-0000-0000-000000000201",
      cwd: "/workspace",
      title: "test",
      prompt: "질문",
      coordinatorInstructions: "delegate_task tasks=[]",
      expectedSpecialists: 1,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.output, "검증된 최종 응답");
    assert.equal(result.session_id, "runtime-1");
    assert.equal(result.events.some((event) => event.type === "subagent.start"), true);
    assert.deepEqual(result.usage, { total_tokens: 10 });
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Hermes message.complete 오류는 전문 에이전트 완료를 기다리지 않고 실패 처리한다", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/hermes/realtime-ticket") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ticket: "single-use", wsPath: "/ws" }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      if (frame.method === "session.create") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "runtime-error", stored_session_id: "stored-error", info: {},
        } }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "message.complete", session_id: "runtime-error", payload: { text: "Error: authoritative startup failure" },
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: "http://unused",
      serviceToken: "service",
      realtimeBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      cwd: "/workspace",
      title: "error",
      prompt: "질문",
      coordinatorInstructions: "delegate_task tasks=[]",
      expectedSpecialists: 3,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "failed");
    assert.match(result.output, /^Error:/);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("응답 없는 개별 JSON-RPC 요청은 전체 실행 제한 전에 실패한다", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/hermes/realtime-ticket") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ticket: "single-use", wsPath: "/ws" }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => socket.on("message", () => {}));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const startedAt = Date.now();
  try {
    await assert.rejects(
      executeHermesJsonRpcRun({
        managerUrl: "http://unused",
        serviceToken: "service",
        realtimeBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        cwd: "/workspace",
        title: "rpc-timeout",
        prompt: "질문",
        coordinatorInstructions: "delegate_task tasks=[]",
        expectedSpecialists: 1,
        requestTimeoutMs: 75,
        timeoutMs: 5_000,
      }),
      /JSON-RPC request timed out: session\.create/,
    );
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("증거 필수 실행은 도구를 사용하지 않은 전문 에이전트 결과를 성공으로 인정하지 않는다", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/hermes/realtime-ticket") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ticket: "single-use", wsPath: "/ws" }));
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      if (frame.method === "session.create") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "runtime-no-evidence", stored_session_id: "stored-no-evidence", info: {},
        } }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "subagent.complete", session_id: "runtime-no-evidence", payload: {
          child_session_id: "child-no-evidence", status: "completed", tool_count: 0,
        },
      } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "message.complete", session_id: "runtime-no-evidence", payload: { text: "근거 없는 성공 주장" },
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: "http://unused",
      serviceToken: "service",
      realtimeBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      cwd: "/workspace",
      title: "evidence",
      prompt: "질문",
      coordinatorInstructions: "delegate_task tasks=[]",
      expectedSpecialists: 1,
      requireEvidence: true,
      timeoutMs: 5_000,
    });
    assert.equal(result.status, "failed");
    assert.match(result.output, /no tool evidence/);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("서버 WebSocket 단절 후 session.resume ledger로 전문 협업 결과를 복구한다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let connectionCount = 0;
  wss.on("connection", (socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      if (connection === 1 && frame.method === "session.create") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "runtime-before-drop", stored_session_id: "stored-recover", messages: [], info: {},
        } }));
      } else if (connection === 1 && frame.method === "prompt.submit") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
        socket.close(1012, "restart");
      } else if (connection === 2 && frame.method === "session.resume") {
        assert.equal((frame as { params?: Record<string, unknown> }).params?.auto_title, false);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "runtime-after-drop",
          stored_session_id: "stored-recover",
          running: false,
          messages: [
            {
              role: "system",
              text: [
                "[ASYNC DELEGATION BATCH COMPLETE — recovered]",
                "--- ✓ TASK 1/1: specialist (status=completed) ---",
                "verified",
              ].join("\n"),
            },
            { role: "assistant", text: "재접속 후 복구한 검증 응답" },
          ],
        } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      serviceToken: "service",
      cwd: "/workspace",
      title: "recover",
      prompt: "질문",
      coordinatorInstructions: "delegate_task tasks=[]",
      expectedSpecialists: 1,
      timeoutMs: 5_000,
    });
    assert.equal(connectionCount, 2);
    assert.equal(result.session_id, "runtime-after-drop");
    assert.equal(result.output, "재접속 후 복구한 검증 응답");
    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((event) => event.payload?.recovered_from === "session.resume"),
      true,
    );
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("prompt.submit의 session not found 응답도 stored session ledger로 복구한다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  let connectionCount = 0;
  wss.on("connection", (socket) => {
    connectionCount += 1;
    const connection = connectionCount;
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string };
      if (connection === 1 && frame.method === "session.create") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "evicted-live", stored_session_id: "stored-after-eviction", messages: [], info: {},
        } }));
      } else if (connection === 1 && frame.method === "prompt.submit") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32004, message: "session not found" } }));
      } else if (connection === 2 && frame.method === "session.resume") {
        assert.equal((frame as { params?: Record<string, unknown> }).params?.auto_title, false);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "resumed-live",
          stored_session_id: "stored-after-eviction",
          running: false,
          messages: [
            { role: "system", text: "[ASYNC DELEGATION BATCH COMPLETE]\n--- ✓ TASK 1/1: specialist (status=completed) ---" },
            { role: "assistant", text: "유실된 live session에서 복구한 최종 응답" },
          ],
        } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      serviceToken: "service",
      cwd: "/workspace",
      title: "session eviction recovery",
      prompt: "질문",
      coordinatorInstructions: "delegate_task tasks=[]",
      expectedSpecialists: 1,
      timeoutMs: 5_000,
    });
    assert.equal(connectionCount, 2);
    assert.equal(result.status, "completed");
    assert.equal(result.session_id, "resumed-live");
    assert.equal(result.output, "유실된 live session에서 복구한 최종 응답");
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("실행 시작 전에 삭제된 stored session은 새 세션을 만들어 같은 후속 질문을 계속한다", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws` }));
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  const methods: string[] = [];
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { id: string; method: string; params: Record<string, unknown> };
      methods.push(frame.method);
      if (frame.method === "session.resume") {
        assert.equal(frame.params.session_id, "deleted-stored-session");
        assert.equal(frame.params.auto_title, false);
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32004, message: "session not found" },
        }));
        return;
      }
      if (frame.method === "session.create") {
        assert.equal(frame.params.cwd, "/workspace/project");
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
          session_id: "replacement-live",
          stored_session_id: "replacement-stored",
          info: {},
        } }));
        return;
      }
      assert.equal(frame.method, "prompt.submit");
      assert.equal(frame.params.session_id, "replacement-live");
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { status: "streaming" } }));
      socket.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: {
        type: "message.complete",
        session_id: "replacement-live",
        payload: { text: "새 세션에서 정상 처리한 후속 응답" },
      } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let persistedStoredSessionId = "";
  try {
    const result = await executeHermesJsonRpcRun({
      managerUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      serviceToken: "service",
      cwd: "/workspace/project",
      title: "stale stored session recovery",
      prompt: "후속 질문",
      coordinatorInstructions: "Answer directly.",
      expectedSpecialists: 0,
      executionMode: "direct",
      existingStoredSessionId: "deleted-stored-session",
      timeoutMs: 5_000,
      onSessionCreated: async ({ storedSessionId }) => {
        persistedStoredSessionId = storedSessionId;
      },
    });
    assert.deepEqual(methods, ["session.resume", "session.create", "prompt.submit"]);
    assert.equal(result.status, "completed");
    assert.equal(result.output, "새 세션에서 정상 처리한 후속 응답");
    assert.equal(result.stored_session_id, "replacement-stored");
    assert.equal(persistedStoredSessionId, "replacement-stored");
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMirroredFrame,
  compareRedisStreamIds,
  gatewayEventFromFrame,
  selectSpecialistCandidate,
  settleProjectionBatch,
} from "../../services/hermes-projector/src/projector.ts";

test("unknown Hermes event를 보존하고 projection state는 변경하지 않는다", () => {
  const frame = { jsonrpc: "2.0", method: "event", params: {
    type: "future.event", session_id: "s1", payload: { future: true },
  } };
  const first = applyMirroredFrame(null, frame);
  assert.equal(first.event?.type, "future.event");
  assert.equal(first.state?.sessionId, "s1");
  assert.deepEqual(first.state?.parts, []);
});

test("subagent payload의 child session과 역할명으로 specialist assignment를 안정적으로 찾는다", () => {
  const candidates = [
    { id: "a", roleName: "Runtime Operations Specialist", status: "planned" as const, hermesSubagentId: null },
    { id: "b", roleName: "Independent Critic", status: "running" as const, hermesSubagentId: "child-b" },
  ];
  assert.equal(selectSpecialistCandidate(candidates, { child_session_id: "child-b" })?.id, "b");
  assert.equal(selectSpecialistCandidate(candidates, { goal: "[Runtime Operations Specialist] verify runtime" })?.id, "a");
});

test("mirrored delta와 tool 경계를 Hermes reducer와 동일하게 projection한다", () => {
  let state = applyMirroredFrame(null, {
    method: "event", params: { type: "message.delta", session_id: "s1", payload: { text: "앞" } },
  }).state;
  state = applyMirroredFrame(state, {
    method: "event", params: { type: "tool.start", session_id: "s1", payload: { name: "terminal", tool_id: "t1" } },
  }).state;
  assert.deepEqual(state?.parts.map((part) => part.type), ["text", "tool-call"]);
  assert.equal(settleProjectionBatch(state!).queuedAssistant, "");
});

test("JSON-RPC response frame은 event projection 대상이 아니다", () => {
  assert.equal(gatewayEventFromFrame({ jsonrpc: "2.0", id: "r1", result: { ok: true } }), null);
});

test("Redis stream ID를 문자열이 아닌 millisecond와 sequence 숫자로 비교한다", () => {
  assert.equal(compareRedisStreamIds("10-0", "9-999"), 1);
  assert.equal(compareRedisStreamIds("10-11", "10-2"), 1);
  assert.equal(compareRedisStreamIds("10-2", "10-2"), 0);
  assert.equal(compareRedisStreamIds("9-999", "10-0"), -1);
  assert.throws(() => compareRedisStreamIds("invalid", "10-0"), /Invalid Redis stream id/);
});

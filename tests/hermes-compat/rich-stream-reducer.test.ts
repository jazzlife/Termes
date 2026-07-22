import assert from "node:assert/strict";
import test from "node:test";

import {
  HERMES_STREAM_DELTA_FLUSH_MS,
  createRichStreamState,
  flushRichStreamDeltas,
  reduceHermesGatewayEvent,
} from "../../packages/hermes-compat/src/rich-stream-reducer.ts";

const apply = (
  state: ReturnType<typeof createRichStreamState>,
  type: string,
  payload: Record<string, unknown> = {},
) => reduceHermesGatewayEvent(state, { type, session_id: "session-1", payload });

test("Hermes와 같은 33ms 배치 및 도구 경계 순서를 보존한다", () => {
  let state = createRichStreamState("session-1");
  assert.equal(HERMES_STREAM_DELTA_FLUSH_MS, 33);
  state = apply(state, "message.start");
  state = apply(state, "message.delta", { text: "먼저 " });
  state = apply(state, "reasoning.delta", { text: "검토 " });
  state = apply(state, "message.delta", { text: "설명" });
  state = apply(state, "tool.start", { name: "terminal", tool_id: "tool-1", args: { command: "pwd" } });
  state = apply(state, "message.delta", { text: " 이후" });
  state = flushRichStreamDeltas(state);

  assert.deepEqual(state.parts.map((part) => part.type), ["text", "reasoning", "tool-call", "text"]);
  assert.equal(state.parts[0]?.type === "text" && state.parts[0].text, "먼저 설명");
  assert.equal(state.parts[3]?.type === "text" && state.parts[3].text, " 이후");
});

test("ID 없는 도구 시작을 늦게 도착한 안정 ID 완료 이벤트와 병합한다", () => {
  let state = createRichStreamState("session-1");
  state = apply(state, "tool.start", { name: "web_search", args: { query: "Hermes" } });
  const syntheticId = state.parts[0]?.type === "tool-call" ? state.parts[0].toolCallId : "";
  assert.match(syntheticId, /^live-tool:web_search:/);
  state = apply(state, "tool.complete", {
    name: "web_search",
    tool_id: "stable-42",
    args: { query: "Hermes" },
    result: { count: 3 },
  });

  assert.equal(state.parts.length, 1);
  assert.deepEqual(state.parts[0], {
    type: "tool-call",
    toolCallId: "stable-42",
    toolName: "web_search",
    args: { query: "Hermes" },
    result: { count: 3 },
    isError: false,
  });
});

test("완료 본문을 정본으로 삼고 도구 이력은 유지한다", () => {
  let state = createRichStreamState("session-1");
  state = apply(state, "reasoning.delta", { text: "초안 reasoning" });
  state = apply(state, "message.delta", { text: "불완전" });
  state = apply(state, "tool.complete", { name: "terminal", tool_id: "t1", result: { output: "ok" } });
  state = apply(state, "message.delta", { text: " 임시" });
  state = apply(state, "message.complete", { text: "검증된 최종 응답" });

  assert.deepEqual(state.parts.map((part) => part.type), ["reasoning", "tool-call", "text"]);
  assert.equal(state.parts.at(-1)?.type === "text" && state.parts.at(-1)?.text, "검증된 최종 응답");
  assert.equal(state.pending, false);
  assert.equal(state.busy, false);
});

test("다음 명령의 시작은 이전 응답과 진행 상태를 재사용하지 않는다", () => {
  let state = createRichStreamState("session-1");
  state = apply(state, "message.start");
  state = apply(state, "message.delta", { text: "이전 응답" });
  state = apply(state, "tool.start", { name: "terminal", tool_id: "previous-tool", args: { command: "pwd" } });
  state = apply(state, "message.complete", { text: "이전 최종 응답" });

  state = apply(state, "message.start");

  assert.deepEqual(state.parts, []);
  assert.equal(state.queuedAssistant, "");
  assert.equal(state.queuedReasoning, "");
  assert.equal(state.toolSequence, 0);
  assert.equal(state.pending, true);
  assert.equal(state.busy, true);
  assert.equal(state.needsInput, false);
  assert.equal(state.interaction, null);
  assert.equal(state.error, null);
});

test("진행 중인 명령의 중복 시작 이벤트는 현재 상태를 보존한다", () => {
  let state = createRichStreamState("session-1");
  state = apply(state, "message.start");
  state = apply(state, "message.delta", { text: "현재 응답" });
  state = apply(state, "message.start");

  assert.deepEqual(flushRichStreamDeltas(state).parts, [{ type: "text", text: "현재 응답" }]);
  assert.equal(state.pending, true);
  assert.equal(state.busy, true);
});

test("세션별 차단형 입력을 손실 없이 보존하고 완료 시 해제한다", () => {
  const cases = [
    ["clarify.request", { request_id: "c1", question: "범위는?", choices: ["전체", "일부"] }, "clarify"],
    ["approval.request", { command: "rm file", description: "삭제" }, "approval"],
    ["sudo.request", { request_id: "s1" }, "sudo"],
    ["secret.request", { request_id: "k1", env_var: "TOKEN", prompt: "토큰" }, "secret"],
  ] as const;

  for (const [type, payload, expected] of cases) {
    let state = apply(createRichStreamState("session-1"), type, payload);
    assert.equal(state.needsInput, true);
    assert.equal(state.interaction?.type, expected);
    state = apply(state, "message.complete", { text: "완료" });
    assert.equal(state.needsInput, false);
    assert.equal(state.interaction, null);
  }
});

test("다른 세션 이벤트와 spinner용 thinking.delta는 projection을 바꾸지 않는다", () => {
  const state = createRichStreamState("session-1");
  const other = reduceHermesGatewayEvent(state, {
    type: "message.delta",
    session_id: "session-2",
    payload: { text: "무시" },
  });
  assert.equal(other, state);
  assert.equal(apply(state, "thinking.delta", { text: "thinking..." }), state);
});

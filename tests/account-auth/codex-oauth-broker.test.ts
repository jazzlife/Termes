import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCodexAccountState } from "../../services/hermes-manager/src/codex-oauth-broker.ts";

test("ChatGPT OAuth 계정은 Codex 원본 플래그와 무관하게 연결 완료로 정규화한다", () => {
  const state = normalizeCodexAccountState({
    account: { type: "chatgpt", email: "master@example.invalid" },
    requiresOpenaiAuth: true,
  });

  assert.equal(state.requiresOpenaiAuth, false);
});

test("ChatGPT OAuth 계정이 없으면 인증 필요 상태를 유지한다", () => {
  assert.equal(normalizeCodexAccountState({ account: null }).requiresOpenaiAuth, true);
  assert.equal(normalizeCodexAccountState({ account: { type: "apiKey" } }).requiresOpenaiAuth, true);
});

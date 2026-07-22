import assert from "node:assert/strict";
import test from "node:test";

import { shouldSubmitChatOnEnter } from "../../apps/web/src/experiences/chat-composer.ts";

test("Enter는 메시지를 전송하고 Shift+Enter는 줄바꿈을 유지한다", () => {
  assert.equal(shouldSubmitChatOnEnter("Enter", false), true);
  assert.equal(shouldSubmitChatOnEnter("Enter", true), false);
  assert.equal(shouldSubmitChatOnEnter("a", false), false);
});

test("IME 조합 중 Enter는 전송하지 않는다", () => {
  assert.equal(shouldSubmitChatOnEnter("Enter", false, true), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import { buildMobileChatTimeline } from "../../apps/web/src/experiences/mobile/chat-timeline.ts";

test("새 후속 명령의 상태 버블은 이전 응답 뒤에 새로 추가한다", () => {
  const timeline = buildMobileChatTimeline({
    messages: [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
    ],
    progressVisible: true,
    sendingMessage: true,
    turnUserMessageId: "user-1",
  });

  assert.deepEqual(
    timeline.map((item) => item.kind === "message" ? `${item.kind}:${item.message.id}` : `${item.kind}:${item.placement}`),
    ["message:user-1", "message:assistant-1", "progress:tail"],
  );
});

test("저장된 새 turn의 상태 버블은 해당 사용자 명령과 응답 사이에 위치한다", () => {
  const timeline = buildMobileChatTimeline({
    messages: [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant" },
    ],
    progressVisible: true,
    sendingMessage: false,
    turnUserMessageId: "user-2",
  });

  assert.deepEqual(
    timeline.map((item) => item.kind === "message" ? `${item.kind}:${item.message.id}` : `${item.kind}:${item.placement}`),
    ["message:user-1", "message:assistant-1", "message:user-2", "progress:after-user-2", "message:assistant-2"],
  );
});

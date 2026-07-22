import assert from "node:assert/strict";
import test from "node:test";

import { buildMobileChatTimeline } from "../../apps/web/src/experiences/mobile/chat-timeline.ts";

test("새 후속 명령의 상태 버블은 이전 응답 뒤에 새로 추가한다", () => {
  const timeline = buildMobileChatTimeline({
    messages: [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
    ],
    progresses: [{ id: "sending-2", userMessageId: null, createdAt: "2026-07-21T00:00:02.000Z" }],
  });

  assert.deepEqual(
    timeline.map((item) => item.kind === "message" ? `${item.kind}:${item.message.id}` : `${item.kind}:${item.progress.id}:${item.placement}`),
    ["message:user-1", "message:assistant-1", "progress:sending-2:tail"],
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
    progresses: [{ id: "turn-2", userMessageId: "user-2", createdAt: "2026-07-21T00:00:02.000Z" }],
  });

  assert.deepEqual(
    timeline.map((item) => item.kind === "message" ? `${item.kind}:${item.message.id}` : `${item.kind}:${item.progress.id}:${item.placement}`),
    ["message:user-1", "message:assistant-1", "message:user-2", "progress:turn-2:after-user-2", "message:assistant-2"],
  );
});

test("각 turn 상태 버블은 고유 ID를 유지하며 해당 응답 앞에 시간순으로 놓인다", () => {
  const timeline = buildMobileChatTimeline({
    messages: [
      { id: "user-1", role: "user" },
      { id: "assistant-1", role: "assistant" },
      { id: "user-2", role: "user" },
      { id: "assistant-2", role: "assistant" },
    ],
    progresses: [
      { id: "turn-1", userMessageId: "user-1", createdAt: "2026-07-21T00:00:01.000Z" },
      { id: "turn-2", userMessageId: "user-2", createdAt: "2026-07-21T00:00:03.000Z" },
    ],
  });

  assert.deepEqual(
    timeline.map((item) => item.kind === "message" ? item.message.id : item.progress.id),
    ["user-1", "turn-1", "assistant-1", "user-2", "turn-2", "assistant-2"],
  );
});

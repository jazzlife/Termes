import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mobileChatProgress = readFileSync(
  "apps/web/src/experiences/mobile/MobileChatProgress.tsx",
  "utf8",
);
const appSource = readFileSync("apps/web/src/main.tsx", "utf8");

test("활성 응답 상태는 펼쳐진 상태 보고 UI와 라이브 상태를 렌더링한다", () => {
  assert.match(mobileChatProgress, /data-testid="mobile-chat-progress"/);
  assert.match(mobileChatProgress, /aria-live="polite"/);
  assert.match(mobileChatProgress, /open=\{progress\.active\}/);
  assert.match(mobileChatProgress, /mobileChatProgressRow/);
  assert.match(mobileChatProgress, /mobileChatProgressTimer/);
});

test("Routing과 Turn 이벤트도 선택된 대화의 상태 보고를 즉시 갱신한다", () => {
  assert.match(appSource, /event\.type === "task\.turn\.requested"/);
  assert.match(appSource, /event\.type === "routing\.started"/);
  assert.match(appSource, /event\.type === "routing\.decided"/);
  assert.match(appSource, /event\.type === "task\.turn\.completed"/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mobileSource = readFileSync("apps/web/src/experiences/mobile/MobileExperience.tsx", "utf8");
const mobileStyles = readFileSync("apps/web/src/experiences/mobile/mobile.css", "utf8");
const appSource = readFileSync("apps/web/src/main.tsx", "utf8");

test("모바일 채팅창 행은 스와이프로 이름 변경과 삭제 액션을 연다", () => {
  assert.match(mobileSource, /mobileTaskSwipeActions/);
  assert.match(mobileSource, /onPointerDown=\{\(event\) => beginTaskSwipe/);
  assert.match(mobileSource, /props\.onRenameTask\(task\)/);
  assert.match(mobileSource, /props\.onDeleteTask\(task\)/);
  assert.match(mobileSource, /suppressTaskClickRef\.current === task\.id/);
  assert.match(mobileStyles, /\.mobileTaskSwipeActions/);
  assert.match(mobileStyles, /touch-action: pan-y/);
});

test("전역 경로 오류 알림은 일정 시간이 지나면 같은 오류만 자동 해제한다", () => {
  assert.match(appSource, /if \(!error\) return;/);
  assert.match(appSource, /window\.setTimeout/);
  assert.match(appSource, /current === error \? null : current/);
  assert.match(appSource, /}, 6000\);/);
  assert.match(mobileStyles, /mobileTransientNoticeIn/);
  assert.match(mobileStyles, /pointer-events: none/);
});

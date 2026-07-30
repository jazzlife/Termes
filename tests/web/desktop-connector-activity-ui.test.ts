import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("desktop connector separates activity monitoring from the compact connected workspace", async () => {
  const [main, styles] = await Promise.all([
    source("apps/desktop-connector/src/main.tsx"),
    source("apps/desktop-connector/src/styles.css"),
  ]);

  assert.match(main, /className="activity-trigger"/);
  assert.match(main, /<ActivityMonitor activities=\{snapshot\.activities\}/);
  assert.match(main, /role="dialog"/);
  assert.match(main, /aria-modal="true"/);
  assert.match(main, /event\.key === "Escape"/);
  assert.match(main, /background\.toggleAttribute\("inert", activityOpen\)/);
  assert.match(main, /onKeyDown=\{handleKeyDown\}/);
  assert.match(main, /className="activity-list" tabIndex=\{0\}/);
  assert.match(main, /activity\.success === false \? "실패" : activity\.success \? "성공" : "정보"/);
  assert.match(main, /className=\{`activity-status \$\{tone\}`\}/);
  assert.match(main, /activityTriggerRef\.current\?\.focus\(\)/);
  assert.match(main, /className="connected-layout"/);
  assert.match(main, /className="destructive-link"/);
  assert.ok(main.indexOf("className=\"destructive-link\"") < main.indexOf("className=\"permissions-section\""));
  assert.doesNotMatch(main, /capabilities-panel|capability-chips|이 Connector가 지원하는 작업|안전 경계/);

  assert.match(styles, /\.connected-layout/);
  assert.match(styles, /\.activity-overlay/);
  assert.match(styles, /\.activity-dialog/);
  assert.doesNotMatch(styles, /\.capability-chips|\.boundary-note/);
});

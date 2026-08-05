import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("desktop connector separates activity monitoring from the compact connected workspace", async () => {
  const [main, styles, tauriConfigSource] = await Promise.all([
    source("apps/desktop-connector/src/main.tsx"),
    source("apps/desktop-connector/src/styles.css"),
    source("apps/desktop-connector/src-tauri/tauri.conf.json"),
  ]);
  const tauriConfig = JSON.parse(tauriConfigSource);

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
  assert.match(main, /checked=\{snapshot\.settings\?\.autoObserve \?\? true\}/);
  assert.match(main, /checked=\{snapshot\.settings\?\.autoControl \?\? true\}/);
  assert.match(main, /invokeSnapshot\("set_auto_control", \{ enabled \}\)/);
  assert.match(main, /제어 작업 자동 허용/);
  assert.match(main, /신뢰하는 PC에서만 켜세요/);
  assert.match(main, /className="destructive-link"/);
  assert.ok(main.indexOf("className=\"destructive-link\"") < main.indexOf("className=\"permissions-section\""));
  assert.ok(main.indexOf("className=\"activity-trigger\"") < main.indexOf("className={`connection-pill phase-${snapshot.phase}`}"));
  assert.ok(main.indexOf("className={`connection-pill phase-${snapshot.phase}`}") > main.indexOf("className=\"connection-section\""));
  assert.doesNotMatch(main, /platform-badge|\? "macOS" : "Windows"/);
  assert.match(main, /className="mono connector-id">\{snapshot\.settings\?\.connectorId\}/);
  assert.match(main, /snapshot\.settings\?\.accountLoginId \?\? snapshot\.settings\?\.accountEmail \?\? snapshot\.settings\?\.accountId/);
  assert.match(main, /snapshot\.settings\?\.accountLoginId && snapshot\.settings\?\.accountEmail && snapshot\.settings\.accountEmail !== snapshot\.settings\.accountLoginId/);
  assert.doesNotMatch(main, /className="mono connector-id">\{snapshot\.settings\?\.accountId\}/);
  assert.doesNotMatch(main, /connectorId\.slice/);
  assert.doesNotMatch(main, /permission\.description|UI Automation|현재 데스크톱을 캡처|로컬 승인 후 제한된 클릭|제한된 시스템 로그/);
  assert.doesNotMatch(main, /capabilities-panel|capability-chips|이 Connector가 지원하는 작업|안전 경계/);

  assert.match(styles, /\.connected-layout \{[^}]*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(styles, /\.app-shell \{[^}]*padding: 0 24px;/);
  assert.match(styles, /body \{[^}]*min-width: 640px;[^}]*min-height: 0;/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /\.activity-overlay/);
  assert.match(styles, /\.activity-dialog/);
  assert.match(styles, /\.identity-grid \.connector-id/);
  assert.match(styles, /\.approval-params \{[^}]*overflow-wrap: anywhere;[^}]*white-space: pre-wrap;/);
  assert.doesNotMatch(styles, /\.platform-badge/);
  assert.doesNotMatch(styles, /\.permission-copy span/);
  assert.doesNotMatch(styles, /\.capability-chips|\.boundary-note/);

  assert.deepEqual(
    {
      width: tauriConfig.app.windows[0].width,
      height: tauriConfig.app.windows[0].height,
      resizable: tauriConfig.app.windows[0].resizable,
      maximizable: tauriConfig.app.windows[0].maximizable,
    },
    { width: 720, height: 508, resizable: false, maximizable: false },
  );
});

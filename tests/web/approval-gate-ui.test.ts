import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const approvalGate = readFileSync("apps/web/src/components/ApprovalGate.tsx", "utf8");
const appSource = readFileSync("apps/web/src/main.tsx", "utf8");
const appCss = readFileSync("apps/web/src/styles.css", "utf8");
const mobileExperience = readFileSync("apps/web/src/experiences/mobile/MobileExperience.tsx", "utf8");

test("수동 승인은 화면 위 최상위 alertdialog로 렌더링되어 실행 UI에 묻히지 않는다", () => {
  assert.match(approvalGate, /role="alertdialog"/);
  assert.match(approvalGate, /aria-modal="true"/);
  assert.match(approvalGate, /createPortal/);
  assert.match(approvalGate, /showModal\(\)/);
  assert.match(approvalGate, /onCancel=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(approvalGate, /autoFocus/);
  assert.match(approvalGate, /data-testid="approval-gate"/);
  assert.match(appCss, /\.approvalGateDialog::backdrop/);
  assert.match(appCss, /\.approvalGateBackdrop[\s\S]*position: absolute/);
  assert.match(appCss, /\.approvalGateBackdrop[\s\S]*z-index: 5000/);
});

test("모바일과 데스크톱 렌더 분기 모두 동일한 강제 승인 게이트를 사용한다", () => {
  assert.equal((appSource.match(/<ApprovalGate/g) || []).length, 2);
  assert.match(appSource, /pendingHermesInteraction\?\.type === "approval"/);
  assert.match(mobileExperience, /interaction && interaction\.type !== "approval"/);
});

test("최대 자율주행 상태와 승인 범위를 UI에서 명시한다", () => {
  assert.match(approvalGate, /최대 자율주행 활성/);
  assert.match(approvalGate, /일반 작업은 승인 없이 실행됩니다/);
  assert.match(appSource, /autonomyModeBadge/);
  assert.match(mobileExperience, /mobileAutonomyStatus/);
});

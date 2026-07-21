import assert from "node:assert/strict";
import test from "node:test";
import { decideMaximumAutonomyApproval } from "../../packages/shared/src/index";

test("일반 파일·네트워크·설치·서비스·배포 작업은 최대 자율 정책으로 항상 승인한다", () => {
  for (const command of [
    "pnpm install",
    "curl https://api.example.com/health",
    "systemctl restart termes-api",
    "npm run deploy:production",
    "adb install app.apk",
  ]) {
    assert.deepEqual(decideMaximumAutonomyApproval({ command, allowPermanent: true }), {
      choice: "always",
      reason: "maximum_autonomy_pre_authorized",
      policyMode: "maximum",
    });
  }
});

test("영구 승인을 지원하지 않는 일반 작업은 세션 범위로 자동 승인한다", () => {
  assert.equal(decideMaximumAutonomyApproval({ command: "apt-get install ripgrep", allowPermanent: false }).choice, "session");
});

test("실제 사람 인증·새 비밀값·금전·계정 파기·루트 삭제는 수동 승인 경계다", () => {
  const requests = [
    "Complete OAuth consent and enter the verification code",
    "Provide the administrator password to continue",
    "Charge the card for a paid subscription",
    "Delete the owner account permanently",
    "rm -rf /",
  ];
  for (const description of requests) {
    assert.equal(decideMaximumAutonomyApproval({ description }).choice, "manual", description);
  }
});

test("인증 상태 조회와 이미 위임된 토큰 사용은 사람 승인을 요구하지 않는다", () => {
  assert.equal(decideMaximumAutonomyApproval({ command: "gh auth status" }).choice, "always");
  assert.equal(decideMaximumAutonomyApproval({ description: "Use the provisioned OAuth token to call the service API" }).choice, "always");
  assert.equal(decideMaximumAutonomyApproval({ command: "rg -n login apps/web/src" }).choice, "always");
  assert.equal(decideMaximumAutonomyApproval({ command: "git checkout codex/autonomy" }).choice, "always");
});

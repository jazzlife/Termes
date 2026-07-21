import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { maximumAutonomyPolicy } from "../../packages/shared/src/index";

const codexRuntimePatch = readFileSync("infra/hermes-agent/patch_codex_runtime.py", "utf8");
const apiServer = readFileSync("apps/api/src/server.ts", "utf8");

test("Codex 실행 경계는 승인 없음·전체 파일 권한·네트워크 가능 정책을 공유 계약과 일치시킨다", () => {
  assert.equal(maximumAutonomyPolicy.mode, "maximum");
  assert.equal(maximumAutonomyPolicy.execution.approvalPolicy, "never");
  assert.equal(maximumAutonomyPolicy.execution.sandbox, "danger-full-access");
  assert.equal(maximumAutonomyPolicy.execution.networkAccess, true);
  assert.match(codexRuntimePatch, /"approvalPolicy": "never"/);
  assert.match(codexRuntimePatch, /"sandbox": "danger-full-access"/);
});

test("일반 장치 설치·재시작은 사전 승인 대상으로 막지 않고 파괴적 호스트 명령만 차단한다", () => {
  assert.doesNotMatch(apiServer, /approvalRequiredAction/);
  assert.match(apiServer, /blockedDeviceAction/);
  assert.match(apiServer, /if \(blockedReason\)/);
});

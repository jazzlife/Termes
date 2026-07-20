import assert from "node:assert/strict";
import test from "node:test";
import { resolveAutomaticExperience, resolveExperience } from "../../apps/web/src/app/experience";

test("Experience 경계는 819/820/1179/1180에서 결정적으로 동작한다", () => {
  assert.equal(resolveAutomaticExperience({ viewportWidth: 819, finePointer: true, hover: true }), "mobile");
  assert.equal(resolveAutomaticExperience({ viewportWidth: 820, finePointer: true, hover: true }), "tablet");
  assert.equal(resolveAutomaticExperience({ viewportWidth: 1179, finePointer: true, hover: true }), "tablet");
  assert.equal(resolveAutomaticExperience({ viewportWidth: 1180, finePointer: true, hover: true }), "desktop");
});

test("넓은 coarse 또는 no-hover 환경은 Tablet Review를 유지한다", () => {
  assert.equal(resolveAutomaticExperience({ viewportWidth: 1366, finePointer: false, hover: false }), "tablet");
  assert.equal(resolveAutomaticExperience({ viewportWidth: 1440, finePointer: true, hover: false }), "tablet");
});

test("사용자 preference는 자동 Experience보다 높은 기능 단계가 될 수 없다", () => {
  const mobile = { viewportWidth: 390, finePointer: false, hover: false };
  const desktop = { viewportWidth: 1440, finePointer: true, hover: true };
  assert.equal(resolveExperience(mobile, "desktop"), "mobile");
  assert.equal(resolveExperience(desktop, "tablet"), "tablet");
  assert.equal(resolveExperience(desktop, "mobile"), "mobile");
});

import assert from "node:assert/strict";
import test from "node:test";
import { experienceAllows, resolveEffectiveCapability } from "../../apps/web/src/app/capability-resolver";

test("Mobile Chat은 대화 기능을 허용하고 시스템 제어 기능을 노출하지 않는다", () => {
  assert.equal(experienceAllows("mobile", "conversation"), true);
  assert.equal(experienceAllows("mobile", "verification"), true);
  assert.equal(experienceAllows("mobile", "terminal-interactive"), false);
  assert.equal(experienceAllows("mobile", "device-control"), false);
  assert.equal(experienceAllows("mobile", "raw-json-rpc"), false);
});

test("최종 capability는 upstream, account, context, Experience 교집합이다", () => {
  assert.equal(resolveEffectiveCapability("conversation", {
    experience: "mobile",
    upstreamSupported: true,
    accountAllowed: true,
    contextAvailable: true,
  }), true);
  assert.equal(resolveEffectiveCapability("conversation", {
    experience: "mobile",
    upstreamSupported: true,
    accountAllowed: false,
    contextAvailable: true,
  }), false);
  assert.equal(resolveEffectiveCapability("terminal-interactive", {
    experience: "mobile",
    upstreamSupported: true,
    accountAllowed: true,
    contextAvailable: true,
  }), false);
});

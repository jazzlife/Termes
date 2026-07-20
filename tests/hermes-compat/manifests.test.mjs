import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const commit = "7fb875451bcef8c379ece6779c6b147eef42c05d";

async function readJson(relative) {
  return JSON.parse(await readFile(new URL(`../../${relative}`, import.meta.url), "utf8"));
}

test("Hermes compatibility manifests are pinned and internally consistent", async () => {
  const [lock, methods, events, routes, tests, performance] = await Promise.all([
    readJson("hermes-compat-lock.json"),
    readJson("artifacts/hermes-parity/methods.json"),
    readJson("artifacts/hermes-parity/events.json"),
    readJson("artifacts/hermes-parity/routes.json"),
    readJson("artifacts/hermes-parity/tests.json"),
    readJson("artifacts/hermes-parity/performance-scenarios.json"),
  ]);

  for (const manifest of [lock, methods, events, routes, tests, performance]) {
    assert.equal(manifest.commit, commit);
  }
  assert.equal(methods.total, methods.directDecoratorCount + methods.wrappedDecoratorCount);
  assert.equal(new Set(methods.methods.map((method) => method.name)).size, methods.total);
  assert.equal(events.knownCount, events.events.length);
  assert.equal(events.unknownPassthrough, true);
  assert.equal(routes.staticCount, routes.routes.length);
  assert.equal(routes.dynamicSessionRoute, true);
  assert.equal(tests.desktopCount, tests.desktop.length);
  assert.equal(tests.gatewayCount, tests.gateway.length);
  assert.ok(performance.scenarios.includes("apps/desktop/scripts/measure-real-stream.mjs"));
});

test("critical Hermes runtime methods and interaction events are present", async () => {
  const [methods, events] = await Promise.all([
    readJson("artifacts/hermes-parity/methods.json"),
    readJson("artifacts/hermes-parity/events.json"),
  ]);
  const methodNames = new Set(methods.methods.map((method) => method.name));
  const eventNames = new Set(events.events);

  for (const name of [
    "session.create",
    "session.resume",
    "session.interrupt",
    "session.steer",
    "prompt.submit",
    "clarify.respond",
    "approval.respond",
    "projects.list",
  ]) {
    assert.ok(methodNames.has(name), `missing method ${name}`);
  }
  for (const name of [
    "message.delta",
    "reasoning.delta",
    "tool.start",
    "tool.complete",
    "clarify.request",
    "approval.request",
  ]) {
    assert.ok(eventNames.has(name), `missing event ${name}`);
  }
});

test("generated JSON-RPC client remains byte-identical to pinned upstream", async () => {
  const lock = await readJson("hermes-compat-lock.json");
  const generated = await readFile(
    new URL("../../packages/hermes-compat/src/upstream/json-rpc-gateway.ts", import.meta.url),
  );
  const digest = createHash("sha256").update(generated).digest("hex");
  assert.equal(digest, lock.files["apps/shared/src/json-rpc-gateway.ts"]);
});

test("Codex runtime keeps direct Hermes chat separate from Termes specialist delegation", async () => {
  const patch = await readFile(
    new URL("../../infra/hermes-agent/patch_codex_runtime.py", import.meta.url),
    "utf8",
  );

  assert.match(patch, /if len\(delegate_lines\) > 1:/);
  assert.match(patch, /if delegate_lines:\n\s+termes_delegate_tasks = json\.loads/);
  assert.doesNotMatch(patch, /if len\(delegate_lines\) != 1:/);
  assert.match(patch, /Termes session auto-title option/);
  assert.match(patch, /Termes resumed session auto-title option/);
  assert.match(patch, /session\.get\(\"auto_title\", True\)/);
});

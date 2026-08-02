import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatDesktopAppDebugReport,
  loadDesktopAppCommand,
} from "../../services/orchestrator/src/desktop-app-command.ts";

async function projectFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "termes-device-app-"));
  await mkdir(path.join(root, ".termes"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

test("project manifest becomes a bounded platform-specific Connector command", async () => {
  const root = await projectFixture();
  await writeFile(path.join(root, "src/main.js"), "console.log('TERMES_APP_DEBUG_OK');\nconsole.error('TERMES_APP_TRACE_OK');\n");
  await writeFile(path.join(root, "config.json"), "{\"message\":\"hello\"}\n");
  await writeFile(path.join(root, ".termes/device-app.json"), JSON.stringify({
    version: 1,
    appId: "hello-debug",
    runtime: "node",
    entrypoint: "src/main.js",
    files: ["src/main.js", "config.json"],
    args: ["--debug"],
    timeoutMs: 8_000,
  }));

  const command = await loadDesktopAppCommand(root, "macos");

  assert.equal(command.action, "macos.dev.app.run");
  assert.equal(command.timeoutMs, 73_000);
  assert.deepEqual(command.params, {
    appId: "hello-debug",
    runtime: "node",
    entrypoint: "src/main.js",
    files: [
      { path: "src/main.js", content: "console.log('TERMES_APP_DEBUG_OK');\nconsole.error('TERMES_APP_TRACE_OK');\n" },
      { path: "config.json", content: "{\"message\":\"hello\"}\n" },
    ],
    args: ["--debug"],
    timeoutMs: 8_000,
  });
});

test("manifest cannot read source through a path that escapes the selected project", async () => {
  const root = await projectFixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "termes-device-app-outside-"));
  await writeFile(path.join(outside, "outside.js"), "console.log('outside');\n");
  await symlink(path.join(outside, "outside.js"), path.join(root, "linked.js"));
  await writeFile(path.join(root, ".termes/device-app.json"), JSON.stringify({
    version: 1,
    appId: "escape-attempt",
    runtime: "node",
    entrypoint: "linked.js",
    files: ["linked.js"],
  }));

  await assert.rejects(loadDesktopAppCommand(root, "windows"), /outside the selected project workspace/);
});

test("debug report exposes command provenance and both process streams", () => {
  const report = formatDesktopAppDebugReport({
    commandId: "123e4567-e89b-12d3-a456-426614174000",
    deviceName: "Studio Mac",
    action: "macos.dev.app.run",
    status: "completed",
    exitCode: 0,
    stdout: "TERMES_APP_DEBUG_OK\n",
    stderr: "TERMES_APP_TRACE_OK\n",
  });

  assert.match(report, /Studio Mac/);
  assert.match(report, /123e4567-e89b-12d3-a456-426614174000/);
  assert.match(report, /exitCode: 0/);
  assert.match(report, /TERMES_APP_DEBUG_OK/);
  assert.match(report, /TERMES_APP_TRACE_OK/);
});

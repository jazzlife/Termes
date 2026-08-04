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

test("browser debugger manifest becomes a target-bound Connector command", async () => {
  const root = await projectFixture();
  await writeFile(path.join(root, ".termes/device-debug.json"), JSON.stringify({
    version: 1,
    kind: "browser",
    host: "127.0.0.1",
    port: 9222,
    targetId: "page-1",
    expectedUrl: "https://example.test/",
    expression: "document.title",
    collectMs: 500,
  }));

  const command = await loadDesktopAppCommand(root, "macos");

  assert.equal(command.action, "macos.debug.browser");
  assert.equal(command.timeoutMs, 85_000);
  assert.deepEqual(command.params, {
    host: "127.0.0.1",
    port: 9222,
    targetId: "page-1",
    expectedUrl: "https://example.test/",
    expression: "document.title",
    collectMs: 500,
  });
});

test("Visual Studio debugger manifest requires a Windows Connector", async () => {
  const root = await projectFixture();
  await writeFile(path.join(root, ".termes/device-debug.json"), JSON.stringify({
    version: 1,
    kind: "visual-studio",
    pid: 4242,
    expectedExecutable: "C:\\Windows\\System32\\notepad.exe",
    expectedStartTimeUnixSeconds: 1_785_000_000,
    expectedUserId: "S-1-5-21-test",
  }));

  await assert.rejects(loadDesktopAppCommand(root, "macos"), /requires a Windows Desktop Connector/);
  const command = await loadDesktopAppCommand(root, "windows");
  assert.equal(command.action, "windows.debug.visual-studio");
  assert.deepEqual(command.params, {
    pid: 4242,
    expectedExecutable: "C:\\Windows\\System32\\notepad.exe",
    expectedStartTimeUnixSeconds: 1_785_000_000,
    expectedUserId: "S-1-5-21-test",
  });
});

test("debug manifest rejects unsupported fields instead of forwarding them", async () => {
  const root = await projectFixture();
  await writeFile(path.join(root, ".termes/device-debug.json"), JSON.stringify({
    version: 1,
    kind: "browser-targets",
    host: "127.0.0.1",
    port: 9222,
    expression: "must not be forwarded",
  }));

  await assert.rejects(loadDesktopAppCommand(root, "macos"), /unsupported field: expression/);
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

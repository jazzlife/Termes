import assert from "node:assert/strict";
import test from "node:test";

import { deviceCommandParamsForLedger } from "../../apps/api/src/device-command-ledger.ts";

test("development app ledger stores source identity without source content", () => {
  const ledger = deviceCommandParamsForLedger("macos.dev.app.run", {
    appId: "hello-debug",
    runtime: "node",
    entrypoint: "main.js",
    files: [{ path: "main.js", content: "console.log('private source')" }],
    args: ["--debug"],
    timeoutMs: 5_000,
  });

  assert.deepEqual(ledger, {
    appId: "hello-debug",
    runtime: "node",
    entrypoint: "main.js",
    argumentCount: 1,
    timeoutMs: 5_000,
    files: [{
      path: "main.js",
      bytes: 29,
      sha256: "06a732f7485a5ab57bd8f8f1766c30f79055ffc06f208ae443eaf8599a7b0f3c",
    }],
  });
  assert.doesNotMatch(JSON.stringify(ledger), /private source/);
});

test("ordinary command ledger keeps recursive credential redaction", () => {
  assert.deepEqual(deviceCommandParamsForLedger("windows.system.info", {
    nested: { apiToken: "do-not-store", label: "safe" },
  }), {
    nested: { apiToken: "[REDACTED]", label: "safe" },
  });
});

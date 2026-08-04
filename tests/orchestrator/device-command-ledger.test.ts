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

test("browser debugger ledger stores expression identity without expression content", () => {
  const ledger = deviceCommandParamsForLedger("macos.debug.browser", {
    port: 9222,
    targetId: "page-1",
    expectedUrl: "https://example.test/",
    expression: "document.cookie",
    collectMs: 750,
  });

  assert.deepEqual(ledger, {
    port: 9222,
    targetId: "page-1",
    collectMs: 750,
    expectedUrlBytes: 21,
    expectedUrlSha256: "1648707b9f8d7b3a543fb75342c44ccc4e680cc222c5249b21454b2f1ca36109",
    expressionBytes: 15,
    expressionSha256: "16137b5c3a70e638493deb59803145cc6d12011095da23b10f666bb23350e493",
  });
  assert.doesNotMatch(JSON.stringify(ledger), /document\.cookie/);
  assert.doesNotMatch(JSON.stringify(ledger), /example\.test/);
});

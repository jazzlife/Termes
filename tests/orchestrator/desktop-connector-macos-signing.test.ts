import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptsDir = path.join(repoRoot, "apps/desktop-connector/scripts");
const resolver = path.join(scriptsDir, "resolve-macos-signing-identity.sh");

async function withFakeSecurity(
  identityOutput: string,
  run: (environment: NodeJS.ProcessEnv) => void,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "termes-signing-test-"));
  const security = path.join(temporaryDirectory, "security");
  await writeFile(
    security,
    `#!/bin/sh\nif [ "$1" = "find-identity" ]; then\n  printf '%s\\n' '${identityOutput}'\n  exit 0\nfi\nexit 1\n`,
  );
  await chmod(security, 0o755);

  try {
    run({
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
      TERMES_MACOS_KEYCHAIN: path.join(temporaryDirectory, "login.keychain-db"),
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test("macOS signing resolver rejects missing and ad-hoc identities", async () => {
  await withFakeSecurity("0 valid identities found", (environment) => {
    const missing = spawnSync("bash", [resolver], { encoding: "utf8", env: environment });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /found 0/);

    const adHoc = spawnSync("bash", [resolver], {
      encoding: "utf8",
      env: { ...environment, TERMES_MACOS_SIGNING_IDENTITY: "-" },
    });
    assert.notEqual(adHoc.status, 0);
    assert.match(adHoc.stderr, /ad-hoc signing is not allowed/);
  });
});

test("macOS signing resolver returns the single stable identity", async () => {
  const identityHash = "90B078C5ABCA197420C9ED11E98755B3DBC073B1";
  await withFakeSecurity(
    `  1) ${identityHash} "Termes Connector Local Development"\n     1 valid identities found`,
    (environment) => {
      const result = spawnSync("bash", [resolver], { encoding: "utf8", env: environment });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), identityHash);
    },
  );
});

test("macOS build and install scripts preserve the stable designated requirement", async () => {
  const buildScript = await readFile(path.join(scriptsDir, "build-macos-test-bundle.sh"), "utf8");
  const installScript = await readFile(path.join(scriptsDir, "install-macos-test-bundle.sh"), "utf8");
  const setupScript = await readFile(path.join(scriptsDir, "setup-macos-local-signing.sh"), "utf8");

  assert.match(buildScript, /resolve-macos-signing-identity\.sh/);
  assert.match(buildScript, /--sign "\$identity_hash"/);
  assert.doesNotMatch(buildScript, /--sign\s+-/);
  assert.match(installScript, /source_requirement/);
  assert.match(installScript, /built app has no designated requirement/);
  assert.match(installScript, /existing_requirement/);
  assert.match(installScript, /existing app has no designated requirement/);
  assert.match(installScript, /refusing to replace its TCC identity/);
  assert.match(installScript, /staged app has no designated requirement/);
  assert.match(installScript, /installed_requirement/);
  assert.match(installScript, /installed app has no designated requirement/);
  assert.match(installScript, /installed_app="\/Applications\/Termes Connector\.app"/);
  assert.doesNotMatch(installScript, /TERMES_MACOS_INSTALL_PATH/);
  assert.match(installScript, /mktemp -d '\/Applications\/\.termes-connector-install\.XXXXXX'/);
  assert.match(installScript, /restore_previous_installation/);
  assert.match(installScript, /Previous Termes Connector\.app/);
  assert.ok(
    installScript.indexOf("installed_replacement=true")
      < installScript.indexOf('mv "$staged_app" "$installed_app"'),
    "rollback state must be armed before the staged app is moved into place",
  );
  assert.match(installScript, /ditto/);
  assert.doesNotMatch(installScript, /tccutil|codesign --force/);
  assert.doesNotMatch(setupScript, /openssl|pkcs12|security import|security create-keypair|-P /);
  assert.match(setupScript, /Keychain Access/);
});

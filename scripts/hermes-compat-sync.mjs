#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/realfishsam/hermes-agent.git";
const commit = "7fb875451bcef8c379ece6779c6b147eef42c05d";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const vendorDir = path.join(rootDir, "vendor", "hermes-compat", "upstream");
const artifactDir = path.join(rootDir, "artifacts", "hermes-parity");
const generatedPackageDir = path.join(rootDir, "packages", "hermes-compat", "src", "upstream");

const selectedSources = [
  "LICENSE",
  "tui_gateway/server.py",
  "tui_gateway/ws.py",
  "apps/shared/src/json-rpc-gateway.ts",
  "apps/desktop/src/app/routes.ts",
  "apps/desktop/src/lib/chat-messages.ts",
  "apps/desktop/src/lib/chat-runtime.ts",
  "apps/desktop/src/app/session/hooks/use-message-stream.ts",
];

const performanceScripts = [
  "apps/desktop/scripts/measure-submit.mjs",
  "apps/desktop/scripts/measure-real-stream.mjs",
  "apps/desktop/scripts/leak-typing.mjs",
  "apps/desktop/scripts/measure-latency.mjs",
  "apps/desktop/scripts/measure-synthetic-stream.mjs",
  "apps/desktop/scripts/profile-real-stream.mjs",
  "apps/desktop/scripts/profile-typing.mjs",
  "apps/desktop/scripts/measure-jump.mjs",
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

async function resolveUpstream() {
  const candidates = [
    process.env.HERMES_UPSTREAM_DIR,
    "/tmp/termes-hermes-agent-audit",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const actual = run("git", ["rev-parse", "HEAD"], candidate);
      if (actual === commit) {
        return { directory: candidate, temporary: false };
      }
    } catch {
      // Continue to the reproducible clone below.
    }
  }

  const directory = await mkdtemp(path.join(tmpdir(), "termes-hermes-compat-"));
  run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", repository, directory], rootDir);
  run("git", ["checkout", "--quiet", commit], directory);
  return { directory, temporary: true };
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function listFiles(directory, predicate, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolute, predicate, base));
    } else if (predicate(absolute)) {
      files.push(path.relative(base, absolute).split(path.sep).join("/"));
    }
  }
  return files;
}

function extractMethods(source) {
  const methods = [];
  for (const match of source.matchAll(/@method\(["']([^"']+)["']\)/g)) {
    methods.push({ name: match[1], registration: "direct" });
  }
  for (const match of source.matchAll(/@_projects_method\(["']([^"']+)["']\)/g)) {
    methods.push({ name: match[1], registration: "projects_wrapper" });
  }
  methods.sort((left, right) => left.name.localeCompare(right.name));
  const duplicate = methods.find((method, index) => index > 0 && methods[index - 1].name === method.name);
  if (duplicate) {
    throw new Error(`Duplicate Hermes method registration: ${duplicate.name}`);
  }
  return methods;
}

function extractEvents(source) {
  const start = source.indexOf("export type GatewayEventName =");
  const end = source.indexOf("export interface GatewayEvent", start);
  if (start < 0 || end < 0) {
    throw new Error("GatewayEventName declaration was not found");
  }
  return [...source.slice(start, end).matchAll(/\|\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
}

function extractRoutes(source) {
  const start = source.indexOf("export const APP_ROUTES = [");
  const end = source.indexOf("] as const", start);
  if (start < 0 || end < 0) {
    throw new Error("APP_ROUTES declaration was not found");
  }
  return [...source.slice(start, end).matchAll(/\{\s*id:\s*['"]([^'"]+)['"],\s*path:\s*([A-Z_]+),\s*view:\s*['"]([^'"]+)['"]\s*\}/g)]
    .map((match) => ({ id: match[1], pathConstant: match[2], view: match[3] }));
}

async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const upstream = await resolveUpstream();
  try {
    const actualCommit = run("git", ["rev-parse", "HEAD"], upstream.directory);
    if (actualCommit !== commit) {
      throw new Error(`Hermes upstream commit mismatch: expected ${commit}, got ${actualCommit}`);
    }

    await rm(vendorDir, { recursive: true, force: true });
    const files = {};
    for (const relative of [...selectedSources, ...performanceScripts]) {
      const source = path.join(upstream.directory, relative);
      const target = path.join(vendorDir, relative);
      const content = await readFile(source);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target);
      files[relative] = sha256(content);
    }
    await rm(generatedPackageDir, { recursive: true, force: true });
    await mkdir(generatedPackageDir, { recursive: true });
    await cp(
      path.join(upstream.directory, "apps/shared/src/json-rpc-gateway.ts"),
      path.join(generatedPackageDir, "json-rpc-gateway.ts"),
    );

    const serverSource = await readFile(path.join(upstream.directory, "tui_gateway/server.py"), "utf8");
    const gatewaySource = await readFile(path.join(upstream.directory, "apps/shared/src/json-rpc-gateway.ts"), "utf8");
    const routesSource = await readFile(path.join(upstream.directory, "apps/desktop/src/app/routes.ts"), "utf8");
    const methods = extractMethods(serverSource);
    const events = extractEvents(gatewaySource);
    const routes = extractRoutes(routesSource);
    const desktopTests = await listFiles(
      path.join(upstream.directory, "apps", "desktop", "src"),
      (file) => /\.test\.tsx?$/.test(file),
      upstream.directory,
    );
    const gatewayTests = await listFiles(
      path.join(upstream.directory, "tests", "tui_gateway"),
      (file) => /test_.*\.py$/.test(path.basename(file)),
      upstream.directory,
    );

    const methodManifest = {
      repository,
      commit,
      directDecoratorCount: methods.filter((method) => method.registration === "direct").length,
      wrappedDecoratorCount: methods.filter((method) => method.registration === "projects_wrapper").length,
      total: methods.length,
      methods,
    };
    const eventManifest = { repository, commit, knownCount: events.length, unknownPassthrough: true, events };
    const routeManifest = { repository, commit, staticCount: routes.length, dynamicSessionRoute: true, routes };
    const testManifest = {
      repository,
      commit,
      desktopCount: desktopTests.length,
      gatewayCount: gatewayTests.length,
      desktop: desktopTests,
      gateway: gatewayTests,
    };
    const performanceManifest = { repository, commit, scenarios: performanceScripts };

    await writeJson(path.join(artifactDir, "methods.json"), methodManifest);
    await writeJson(path.join(artifactDir, "events.json"), eventManifest);
    await writeJson(path.join(artifactDir, "routes.json"), routeManifest);
    await writeJson(path.join(artifactDir, "tests.json"), testManifest);
    await writeJson(path.join(artifactDir, "performance-scenarios.json"), performanceManifest);

    const lock = {
      repository,
      commit,
      license: "MIT",
      files,
      methodManifestSha256: sha256(JSON.stringify(methodManifest)),
      eventManifestSha256: sha256(JSON.stringify(eventManifest)),
      routeManifestSha256: sha256(JSON.stringify(routeManifest)),
    };
    await writeJson(path.join(rootDir, "hermes-compat-lock.json"), lock);

    const report = `# Hermes Compatibility Manifest\n\n` +
      `- Repository: ${repository}\n` +
      `- Commit: \`${commit}\`\n` +
      `- Direct \`@method\` registrations: ${methodManifest.directDecoratorCount}\n` +
      `- Wrapped project registrations: ${methodManifest.wrappedDecoratorCount}\n` +
      `- Total runtime method registrations: ${methodManifest.total}\n` +
      `- Known gateway events: ${eventManifest.knownCount}\n` +
      `- Static desktop routes: ${routeManifest.staticCount} + dynamic session route\n` +
      `- Desktop tests: ${testManifest.desktopCount}\n` +
      `- TUI gateway tests: ${testManifest.gatewayCount}\n` +
      `- Performance scenarios: ${performanceManifest.scenarios.length}\n`;
    await writeFile(path.join(artifactDir, "report.md"), report);

    process.stdout.write(`${report}\nGenerated ${Object.keys(files).length} provenance-locked upstream files.\n`);
  } finally {
    if (upstream.temporary) {
      await rm(upstream.directory, { recursive: true, force: true });
    }
  }
}

await main();

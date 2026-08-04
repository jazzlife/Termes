import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import http from "node:http";

const port = Number.parseInt(process.argv[2] ?? "9344", 10);
const detached = process.argv.includes("--detached");
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("debug port must be between 1024 and 65535");
}

const chromePath = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome";
const marker = "TERMES_REMOTE_DEBUG_SMOKE";
const runId = randomUUID();
const page = `<!doctype html><meta charset="utf-8"><title>${marker}</title><script>window.termesApp = ${JSON.stringify({ marker, runId, nodePid: process.pid, answer: 42 })}; console.log("${marker}:BROWSER_READY");</script>`;
const pageUrl = `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
const profile = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/termes-remote-debug-smoke-${runId}`;
const profileArgument = `--user-data-dir=${profile}`;
const maxProbeBytes = 64 * 1024;

function waitForSpawn(child, label) {
  if (child.pid) return Promise.resolve(child.pid);
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child.pid));
    child.once("error", (error) => reject(new Error(`${label} failed to spawn: ${error.message}`)));
  });
}

function processGroupCommand(pid) {
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId = \" + $env:TERMES_CLEANUP_PID); if ($p) { [Console]::Out.Write($p.CommandLine) }",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TERMES_CLEANUP_PID: String(pid) },
        maxBuffer: maxProbeBytes,
        timeout: 5_000,
      },
    );
    return result.status === 0 ? result.stdout : null;
  }
  const result = spawnSync("ps", ["-ww", "-g", String(pid), "-o", "command="], {
    encoding: "utf8",
    maxBuffer: maxProbeBytes,
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout : result.status === 1 ? "" : null;
}

function terminateOwnedChrome(pid) {
  const command = processGroupCommand(pid);
  if (command === null || !command.includes(profileArgument)) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  rmSync(profile, { recursive: true, force: true });
  return true;
}

function fetchBoundedJson(path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = http.get({ hostname: "127.0.0.1", port, path }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
        return;
      }
      const declaredBytes = Number.parseInt(response.headers["content-length"] ?? "0", 10);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxProbeBytes) {
        response.destroy();
        fail(new Error("probe response exceeded 64 KiB"));
        return;
      }
      let body = "";
      let receivedBytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > maxProbeBytes) {
          response.destroy();
          fail(new Error("probe response exceeded 64 KiB"));
          return;
        }
        body += chunk;
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        try {
          const value = JSON.parse(body);
          settled = true;
          resolve(value);
        } catch (error) {
          fail(error);
        }
      });
    });
    request.setTimeout(500, () => request.destroy(new Error("timeout")));
    request.on("error", fail);
  });
}

const chrome = spawn(chromePath, [
  "--headless=new",
  "--no-first-run",
  "--disable-background-networking",
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${port}`,
  profileArgument,
  pageUrl,
], {
  detached,
  stdio: detached ? "ignore" : ["ignore", "pipe", "pipe"],
});

chrome.stdout?.on("data", (chunk) => process.stdout.write(`[chrome] ${chunk}`));
chrome.stderr?.on("data", (chunk) => process.stderr.write(`[chrome] ${chunk}`));
const chromePid = await waitForSpawn(chrome, "Chrome");
let chromeExited = false;
chrome.once("exit", () => { chromeExited = true; });

let cleanup = null;
if (detached) {
  const cleanupCode = `
    const { spawnSync } = require("node:child_process");
    const fs = require("node:fs");
    const pid = Number(process.argv[1]);
    const profile = process.argv[2];
    const profileArgument = process.argv[3];
    const inspect = () => {
      if (process.platform === "win32") {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$p = Get-CimInstance Win32_Process -Filter (\\\"ProcessId = \\\" + $env:TERMES_CLEANUP_PID); if ($p) { [Console]::Out.Write($p.CommandLine) }"], { encoding: "utf8", env: { ...process.env, TERMES_CLEANUP_PID: String(pid) }, maxBuffer: 65536, timeout: 5000 });
        return result.status === 0 ? result.stdout : null;
      }
      const result = spawnSync("ps", ["-ww", "-g", String(pid), "-o", "command="], { encoding: "utf8", maxBuffer: 65536, timeout: 5000 });
      return result.status === 0 ? result.stdout : result.status === 1 ? "" : null;
    };
    const terminate = () => {
      const command = inspect();
      const owned = typeof command === "string" && command.includes(profileArgument);
      if (owned && process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: 5000 });
      } else if (owned) {
        try { process.kill(-pid, "SIGTERM"); } catch {}
        setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 2000);
      }
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), owned && process.platform !== "win32" ? 2500 : 0);
    };
    setTimeout(terminate, 120_000);
  `;
  cleanup = spawn(process.execPath, ["-e", cleanupCode, String(chromePid), profile, profileArgument], {
    detached: true,
    stdio: "ignore",
  });
  try {
    await waitForSpawn(cleanup, "cleanup helper");
  } catch (error) {
    terminateOwnedChrome(chromePid);
    throw error;
  }
  cleanup.unref();
}

console.log(JSON.stringify({ marker, phase: "started", runId, nodePid: process.pid, chromePid, cleanupPid: cleanup?.pid ?? null, debugPort: port }));

const deadline = Date.now() + 10_000;
let readyBrowser = null;
while (Date.now() < deadline && !chromeExited) {
  try {
    const version = await fetchBoundedJson("/json/version");
    const targets = await fetchBoundedJson("/json/list");
    const target = Array.isArray(targets)
      ? targets.find((value) => value?.title === marker && value?.url === pageUrl)
      : null;
    const debuggerUrl = target?.webSocketDebuggerUrl ? new URL(target.webSocketDebuggerUrl) : null;
    if (
      typeof version?.Browser === "string"
      && version.Browser.startsWith("Chrome/")
      && target
      && debuggerUrl?.protocol === "ws:"
      && debuggerUrl.hostname === "127.0.0.1"
      && Number(debuggerUrl.port) === port
      && !chromeExited
    ) {
      readyBrowser = version.Browser;
      break;
    }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!readyBrowser) {
  terminateOwnedChrome(chromePid);
  throw new Error(`Chrome debugger did not expose the exact smoke target on port ${port}`);
}

console.log(JSON.stringify({ marker, phase: "debug-ready", runId, nodePid: process.pid, chromePid, debugPort: port, browser: readyBrowser }));

if (detached) {
  chrome.unref();
  console.log(JSON.stringify({ marker, phase: "detached", runId, nodePid: process.pid, chromePid, cleanupPid: cleanup.pid, debugPort: port }));
  process.exitCode = 0;
} else {
  const stop = () => {
    if (!chrome.killed) chrome.kill("SIGTERM");
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  setTimeout(stop, 42_000).unref();

  const exitCode = await new Promise((resolve) => chrome.once("exit", (code, signal) => {
    rmSync(profile, { recursive: true, force: true });
    console.log(JSON.stringify({ marker, phase: "stopped", runId, code, signal }));
    resolve(code ?? (signal ? 0 : 1));
  }));
  process.exitCode = exitCode;
}

import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

const MANIFEST_PATH = ".termes/device-app.json";
const DEBUG_MANIFEST_PATH = ".termes/device-debug.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_REPORT_STREAM_CHARS = 12_000;
const APPROVAL_AND_TRANSPORT_BUDGET_MS = 65_000;

export type DesktopConnectorPlatform = "macos" | "windows";

export type DesktopAppCommand = {
  action: `${DesktopConnectorPlatform}.${"dev.app.run" | "debug.console" | "debug.browser.targets" | "debug.browser" | "debug.visual-studio"}`;
  params: Record<string, unknown>;
  timeoutMs: number;
};

export type DesktopAppExecution = {
  commandId: string;
  deviceName: string;
  action: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type DesktopAppManifest = {
  version: 1;
  appId: string;
  runtime: "node";
  entrypoint: string;
  files: string[];
  args?: string[];
  timeoutMs?: number;
};

type DesktopDebugManifest = {
  version: 1;
  kind: "console" | "browser-targets" | "browser" | "visual-studio";
  pid?: number;
  expectedExecutable?: string;
  expectedStartTimeUnixSeconds?: number;
  expectedUserId?: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  targetId?: string;
  expectedUrl?: string;
  expression?: string;
  awaitPromise?: boolean;
  collectMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 240 || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be a bounded POSIX relative path`);
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

function parseManifest(value: unknown): DesktopAppManifest {
  if (!isRecord(value) || value.version !== 1) throw new Error("Termes device app manifest version must be 1");
  if (typeof value.appId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value.appId)) {
    throw new Error("Termes device app appId is invalid");
  }
  if (value.runtime !== "node") throw new Error("Termes device app runtime must be node");
  const entrypoint = safeRelativePath(value.entrypoint, "entrypoint");
  if (!/\.(?:js|mjs|cjs)$/.test(entrypoint)) throw new Error("Node.js entrypoint must end in .js, .mjs, or .cjs");
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    throw new Error(`Termes device app files must contain 1 to ${MAX_FILES} paths`);
  }
  const files = value.files.map((file, index) => safeRelativePath(file, `files[${index}]`));
  if (new Set(files).size !== files.length) throw new Error("Termes device app files contain duplicate paths");
  if (!files.includes(entrypoint)) throw new Error("Termes device app entrypoint must be included in files");
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.length > 16 || args.some((argument) => typeof argument !== "string" || argument.length > 512 || argument.includes("\0"))) {
    throw new Error("Termes device app args must contain at most 16 bounded strings");
  }
  const timeoutMs = value.timeoutMs === undefined ? 15_000 : value.timeoutMs;
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 55_000) {
    throw new Error("Termes device app timeoutMs must be between 1000 and 55000");
  }
  return {
    version: 1,
    appId: value.appId,
    runtime: "node",
    entrypoint,
    files,
    args: args as string[],
    timeoutMs: timeoutMs as number,
  };
}

function parseDebugManifest(value: unknown): DesktopDebugManifest {
  if (!isRecord(value) || value.version !== 1) throw new Error("Termes device debug manifest version must be 1");
  if (!["console", "browser-targets", "browser", "visual-studio"].includes(String(value.kind))) {
    throw new Error("Termes device debug kind is invalid");
  }
  const kind = value.kind as DesktopDebugManifest["kind"];
  const allowedKeys = new Set({
    console: ["version", "kind", "pid", "expectedExecutable", "expectedStartTimeUnixSeconds", "expectedUserId"],
    "visual-studio": ["version", "kind", "pid", "expectedExecutable", "expectedStartTimeUnixSeconds", "expectedUserId"],
    "browser-targets": ["version", "kind", "host", "port"],
    browser: ["version", "kind", "host", "port", "targetId", "expectedUrl", "expression", "awaitPromise", "collectMs"],
  }[kind]);
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey) throw new Error(`Termes device debug manifest contains unsupported field: ${unknownKey}`);
  if ((kind === "console" || kind === "visual-studio")
    && (!Number.isInteger(value.pid) || (value.pid as number) < 1 || (value.pid as number) > 0xffff_ffff)) {
    throw new Error("Termes device debug pid must be a positive 32-bit integer");
  }
  if (kind === "console" || kind === "visual-studio") {
    if (typeof value.expectedExecutable !== "string" || value.expectedExecutable.length < 1
      || value.expectedExecutable.length > 4_096 || value.expectedExecutable.includes("\0")) {
      throw new Error("Termes device debug expectedExecutable is invalid");
    }
    if (!Number.isInteger(value.expectedStartTimeUnixSeconds)
      || (value.expectedStartTimeUnixSeconds as number) < 1
      || (value.expectedStartTimeUnixSeconds as number) > Number.MAX_SAFE_INTEGER) {
      throw new Error("Termes device debug expectedStartTimeUnixSeconds is invalid");
    }
    if (typeof value.expectedUserId !== "string" || value.expectedUserId.length < 1
      || value.expectedUserId.length > 256 || value.expectedUserId.includes("\0")) {
      throw new Error("Termes device debug expectedUserId is invalid");
    }
  }
  if (kind.startsWith("browser")) {
    if (value.host !== undefined && !["127.0.0.1", "::1"].includes(String(value.host))) {
      throw new Error("Termes browser debugger host must be loopback");
    }
    if (!Number.isInteger(value.port) || (value.port as number) < 1024 || (value.port as number) > 65535) {
      throw new Error("Termes browser debugger port must be between 1024 and 65535");
    }
  }
  if (kind === "browser") {
    if (typeof value.targetId !== "string" || value.targetId.length < 1 || value.targetId.length > 256) {
      throw new Error("Termes browser debugger targetId is invalid");
    }
    if (typeof value.expectedUrl !== "string" || value.expectedUrl.length < 1 || value.expectedUrl.length > 4_096) {
      throw new Error("Termes browser debugger expectedUrl is invalid");
    }
    if (value.expression !== undefined
      && (typeof value.expression !== "string" || value.expression.length > 8_192 || value.expression.includes("\0"))) {
      throw new Error("Termes browser debugger expression is invalid");
    }
    if (value.awaitPromise !== undefined && typeof value.awaitPromise !== "boolean") {
      throw new Error("Termes browser debugger awaitPromise must be boolean");
    }
    if (value.collectMs !== undefined
      && (!Number.isInteger(value.collectMs) || (value.collectMs as number) < 0 || (value.collectMs as number) > 2_000)) {
      throw new Error("Termes browser debugger collectMs must be between 0 and 2000");
    }
  }
  return value as DesktopDebugManifest;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function readBoundedWorkspaceFile(
  workspaceRoot: string,
  candidate: string,
  maxBytes: number,
  missingMessage: string,
  outsideMessage: string,
  invalidMessage: string,
): Promise<{ content: string; bytes: number }> {
  const initiallyResolved = await realpath(candidate).catch(() => {
    throw new Error(missingMessage);
  });
  if (!isInsideRoot(workspaceRoot, initiallyResolved)) throw new Error(outsideMessage);

  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new Error(invalidMessage);
  });
  try {
    const openedStats = await handle.stat();
    if (process.platform === "linux") {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => {
        throw new Error(invalidMessage);
      });
      if (!isInsideRoot(workspaceRoot, openedPath)) throw new Error(outsideMessage);
    } else {
      if (process.env.NODE_ENV === "production") {
        throw new Error("Secure Termes device app source loading requires the Linux Orchestrator runtime");
      }
      const currentlyResolved = await realpath(candidate).catch(() => {
        throw new Error(invalidMessage);
      });
      if (!isInsideRoot(workspaceRoot, currentlyResolved)) throw new Error(outsideMessage);
      const currentStats = await stat(currentlyResolved);
      if (openedStats.dev !== currentStats.dev || openedStats.ino !== currentStats.ino) {
        throw new Error(invalidMessage);
      }
    }
    if (!openedStats.isFile() || openedStats.size > maxBytes) {
      throw new Error(invalidMessage);
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const chunk = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (chunk.bytesRead === 0) break;
      bytes += chunk.bytesRead;
    }
    if (bytes > maxBytes) throw new Error(invalidMessage);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new Error(invalidMessage);
    }
    if (content.includes("\0")) throw new Error(invalidMessage);
    return { content, bytes };
  } finally {
    await handle.close();
  }
}

export async function loadDesktopAppCommand(
  workspacePath: string,
  platform: DesktopConnectorPlatform,
): Promise<DesktopAppCommand> {
  const workspaceRoot = await realpath(workspacePath);
  const debugManifestCandidate = path.join(workspaceRoot, DEBUG_MANIFEST_PATH);
  const hasDebugManifest = await stat(debugManifestCandidate)
    .then((value) => value.isFile())
    .catch(() => false);
  if (hasDebugManifest) {
    const manifestSource = await readBoundedWorkspaceFile(
      workspaceRoot,
      debugManifestCandidate,
      MAX_MANIFEST_BYTES,
      `Termes remote debug command requires ${DEBUG_MANIFEST_PATH}`,
      "Termes device debug manifest resolves outside the selected project workspace",
      "Termes device debug manifest is not a stable bounded regular file",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestSource.content);
    } catch (error) {
      throw new Error(`Cannot parse ${DEBUG_MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const manifest = parseDebugManifest(parsed);
    if (manifest.kind === "visual-studio" && platform !== "windows") {
      throw new Error("Visual Studio debugger handoff requires a Windows Desktop Connector");
    }
    const actionSuffix = {
      console: "debug.console",
      "browser-targets": "debug.browser.targets",
      browser: "debug.browser",
      "visual-studio": "debug.visual-studio",
    }[manifest.kind] as "debug.console" | "debug.browser.targets" | "debug.browser" | "debug.visual-studio";
    const { version: _version, kind: _kind, ...params } = manifest;
    return {
      action: `${platform}.${actionSuffix}`,
      params,
      timeoutMs: 85_000,
    };
  }
  const manifestCandidate = path.join(workspaceRoot, MANIFEST_PATH);
  const manifestSource = await readBoundedWorkspaceFile(
    workspaceRoot,
    manifestCandidate,
    MAX_MANIFEST_BYTES,
    `Termes remote app command requires ${MANIFEST_PATH}`,
    "Termes device app manifest resolves outside the selected project workspace",
    "Termes device app manifest is not a stable bounded regular file",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestSource.content);
  } catch (error) {
    throw new Error(`Cannot parse ${MANIFEST_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = parseManifest(parsed);
  const files: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  for (const relativePath of manifest.files) {
    const candidate = path.join(workspaceRoot, ...relativePath.split("/"));
    const source = await readBoundedWorkspaceFile(
      workspaceRoot,
      candidate,
      MAX_FILE_BYTES,
      `Termes device app source does not exist: ${relativePath}`,
      `Termes device app source resolves outside the selected project workspace: ${relativePath}`,
      `Termes device app source is not a stable bounded regular file: ${relativePath}`,
    );
    totalBytes += source.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Termes device app source exceeds the total size limit");
    files.push({ path: relativePath, content: source.content });
  }
  return {
    action: `${platform}.dev.app.run`,
    params: {
      appId: manifest.appId,
      runtime: "node",
      entrypoint: manifest.entrypoint,
      files,
      args: manifest.args || [],
      timeoutMs: manifest.timeoutMs || 15_000,
    },
    timeoutMs: (manifest.timeoutMs || 15_000) + APPROVAL_AND_TRANSPORT_BUDGET_MS,
  };
}

function boundedReportStream(value: string): string {
  return value.length <= MAX_REPORT_STREAM_CHARS
    ? value
    : `${value.slice(0, MAX_REPORT_STREAM_CHARS)}\n[debug output truncated in chat; full output remains in device command logs]`;
}

export function formatDesktopAppDebugReport(execution: DesktopAppExecution): string {
  return [
    "## Remote app debug result",
    `- device: ${execution.deviceName}`,
    `- commandId: ${execution.commandId}`,
    `- action: ${execution.action}`,
    `- status: ${execution.status}`,
    `- exitCode: ${execution.exitCode ?? "n/a"}`,
    "",
    "### stdout",
    "```text",
    boundedReportStream(execution.stdout) || "(empty)",
    "```",
    "",
    "### stderr",
    "```text",
    boundedReportStream(execution.stderr) || "(empty)",
    "```",
  ].join("\n");
}

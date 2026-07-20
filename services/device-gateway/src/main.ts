import {
  TERMES_VERSION,
  assertDevicePlatform,
  assertDeviceTransport,
  type DeviceCommandStatus,
  type DevicePlatform,
  type DeviceSummary,
  type DeviceTransport,
} from "@termes/shared";
import Fastify from "fastify";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const supportedActions = [
  "local_mock.health",
  "local_mock.echo",
  "local_mock.fail",
  "local_mock.sleep",
  "linux.system.info",
  "linux.shell",
  "linux.service.status",
  "linux.journal.query",
  "windows.system.info",
  "windows.powershell",
  "windows.service.status",
  "windows.eventlog.query",
  "android.system.info",
  "android.shell",
  "android.logcat",
  "tizen.system.info",
  "tizen.shell",
  "tizen.dlog",
] as const;

type SupportedAction = (typeof supportedActions)[number];

interface GatewayDeviceInput {
  id: string;
  projectId?: string;
  key: string;
  name: string;
  platform: DevicePlatform;
  transport: DeviceTransport;
  endpoint: string | null;
  labels?: Record<string, string>;
}

interface GatewayCommandInput {
  commandId?: string;
  device: GatewayDeviceInput;
  action: SupportedAction | string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

interface GatewayCommandResult {
  id: string;
  deviceId: string;
  action: string;
  status: DeviceCommandStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  artifactUri: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function port(): number {
  const raw = process.env.PORT || "8080";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return parsed;
}

function gatewayRoot(): string {
  return path.resolve(process.env.DEVICE_GATEWAY_ROOT || "/data/docker_data/termes/device-gateway");
}

function commandTimeoutMs(input?: number): number {
  const raw = input ?? Number.parseInt(process.env.DEVICE_COMMAND_TIMEOUT_MS || "30000", 10);
  if (!Number.isInteger(raw) || raw < 1_000 || raw > 300_000) {
    return 30_000;
  }
  return raw;
}

function capText(value: string, limit = 16_000): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} bytes]`;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoundedInteger(record: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = readNumber(record, key);
  if (value === null || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function readLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof labelValue === "string") {
      labels[key] = labelValue;
    }
  }
  return labels;
}

function parseCommandInput(value: unknown): GatewayCommandInput {
  if (!value || typeof value !== "object") {
    throw new Error("Command body must be an object");
  }
  const record = value as Record<string, unknown>;
  const rawDevice = record.device;
  if (!rawDevice || typeof rawDevice !== "object") {
    throw new Error("Command body requires device");
  }
  const deviceRecord = rawDevice as Record<string, unknown>;
  const platform = assertDevicePlatform(readString(deviceRecord, "platform"));
  const transport = assertDeviceTransport(readString(deviceRecord, "transport"));
  const action = readString(record, "action");
  if (!action) {
    throw new Error("Command body requires action");
  }

  const params = record.params && typeof record.params === "object" ? (record.params as Record<string, unknown>) : {};
  const timeoutMs = readNumber(record, "timeoutMs") ?? undefined;
  const projectId = readString(deviceRecord, "projectId");
  const commandId = readString(record, "commandId");
  const device: GatewayDeviceInput = {
    id: readString(deviceRecord, "id"),
    key: readString(deviceRecord, "key"),
    name: readString(deviceRecord, "name"),
    platform,
    transport,
    endpoint: readString(deviceRecord, "endpoint") || null,
    labels: readLabels(deviceRecord.labels),
  };
  if (projectId) {
    device.projectId = projectId;
  }

  const input: GatewayCommandInput = {
    action,
    params,
    device,
  };
  if (commandId) {
    input.commandId = commandId;
  }
  if (timeoutMs !== undefined) {
    input.timeoutMs = timeoutMs;
  }

  return input;
}

function validatePlatformTransport(device: GatewayDeviceInput): void {
  const allowed: Record<DevicePlatform, DeviceTransport[]> = {
    local_mock: ["local_mock"],
    linux: ["ssh"],
    windows: ["winrm", "ssh"],
    android: ["adb"],
    tizen: ["sdb"],
  };
  if (!allowed[device.platform].includes(device.transport)) {
    throw new Error(`Transport ${device.transport} is not allowed for platform ${device.platform}`);
  }
}

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostFromEndpoint(endpoint: string): string {
  if (endpoint.includes("://")) {
    const parsed = new URL(endpoint);
    return parsed.hostname.toLowerCase();
  }
  const withoutUser = endpoint.includes("@") ? endpoint.slice(endpoint.lastIndexOf("@") + 1) : endpoint;
  if (withoutUser.startsWith("[") && withoutUser.includes("]")) {
    return withoutUser.slice(1, withoutUser.indexOf("]")).toLowerCase();
  }
  return withoutUser.split(":")[0]?.toLowerCase() || "";
}

function hostAllowed(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*" || pattern === host) {
      return true;
    }
    if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) {
      return true;
    }
    return false;
  });
}

function validateEndpointPolicy(device: GatewayDeviceInput): void {
  if (device.platform === "local_mock") {
    return;
  }
  const endpoint = (device.endpoint || "").trim();
  if (!endpoint) {
    return;
  }
  if (endpoint.startsWith("-") || /\s/.test(endpoint)) {
    throw new Error("Device endpoint contains an invalid host expression");
  }
  const host = hostFromEndpoint(endpoint);
  if (!host) {
    throw new Error("Device endpoint host is required");
  }
  const allowedHosts =
    device.platform === "windows" && device.transport === "winrm"
      ? envList("WINRM_ALLOWED_HOSTS").concat(envList("DEVICE_ALLOWED_HOSTS"))
      : envList("DEVICE_ALLOWED_HOSTS");
  if (allowedHosts.length > 0 && !hostAllowed(host, allowedHosts)) {
    throw new Error(`Endpoint host ${host} is not allowed by device gateway policy`);
  }
}

function validateAction(device: GatewayDeviceInput, action: string): SupportedAction {
  if (!supportedActions.includes(action as SupportedAction)) {
    throw new Error(`Unsupported action: ${action}`);
  }
  const actionPrefix = action.split(".")[0];
  if (actionPrefix !== device.platform) {
    throw new Error(`Action ${action} does not match platform ${device.platform}`);
  }
  return action as SupportedAction;
}

function blockedCommandText(value: string): boolean {
  const normalized = value.toLowerCase();
  const blocked = [
    "rm -rf /",
    "mkfs",
    "dd if=",
    "shutdown",
    "reboot",
    "format-volume",
    "clear-eventlog",
    "stop-computer",
    "restart-computer",
    "remove-item -recurse c:\\",
    "diskpart",
    "bcdedit",
  ];
  return blocked.some((pattern) => normalized.includes(pattern));
}

const secretKeyPattern = /(password|passwd|passphrase|token|secret|clientsecret|client_secret|api[-_]?key|private[-_]?key|authorization|credential)/i;

function collectSecretValues(value: unknown, parentKey = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSecretValues(item, parentKey));
  }
  if (!value || typeof value !== "object") {
    return secretKeyPattern.test(parentKey) && typeof value === "string" && value.length >= 4 ? [value] : [];
  }
  const secrets: string[] = [];
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    secrets.push(...collectSecretValues(candidate, key));
  }
  return secrets;
}

function redactText(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

async function saveResult(result: GatewayCommandResult): Promise<void> {
  const commandsRoot = path.join(gatewayRoot(), "commands");
  await mkdir(commandsRoot, { recursive: true });
  const resultPath = path.join(commandsRoot, `${result.id}.json`);
  if (!resultPath.startsWith(`${commandsRoot}${path.sep}`)) {
    throw new Error("Command result path escaped gateway root");
  }
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function readSavedResult(commandId: string): Promise<GatewayCommandResult | null> {
  const commandsRoot = path.join(gatewayRoot(), "commands");
  const resultPath = path.join(commandsRoot, `${commandId}.json`);
  if (!resultPath.startsWith(`${commandsRoot}${path.sep}`)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(resultPath, "utf8")) as GatewayCommandResult;
  } catch {
    return null;
  }
}

async function runExecFile(file: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return {
      stdout: capText(stdout),
      stderr: capText(stderr),
      exitCode: 0,
    };
  } catch (error) {
    const cause = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: capText(cause.stdout || ""),
      stderr: capText(cause.stderr || cause.message),
      exitCode: typeof cause.code === "number" ? cause.code : 1,
    };
  }
}

function safeShellParam(params: Record<string, unknown>, key: string): string {
  const value = readString(params, key).trim();
  if (!value) {
    return "";
  }
  if (blockedCommandText(value)) {
    throw new Error("Command is blocked by device gateway policy");
  }
  return value;
}

function requiredShellParam(params: Record<string, unknown>, key: string): string {
  const value = safeShellParam(params, key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

async function executeLocalMock(action: SupportedAction, params: Record<string, unknown>, timeoutMs: number): Promise<ExecResult> {
  if (action === "local_mock.health") {
    return { stdout: JSON.stringify({ status: "ok", checkedAt: new Date().toISOString() }), stderr: "", exitCode: 0 };
  }
  if (action === "local_mock.echo") {
    return { stdout: JSON.stringify(params.payload ?? params), stderr: "", exitCode: 0 };
  }
  if (action === "local_mock.fail") {
    return { stdout: "", stderr: readString(params, "message") || "local_mock failure requested", exitCode: 2 };
  }
  if (action === "local_mock.sleep") {
    const sleepMs = Math.min(Math.max(readNumber(params, "ms") ?? 100, 1), timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
    return { stdout: `slept ${sleepMs}ms`, stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: `Unsupported local mock action ${action}`, exitCode: 1 };
}

async function executeLinux(
  device: GatewayDeviceInput,
  action: SupportedAction,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecResult> {
  const endpoint = device.endpoint || "";
  if (!endpoint) {
    return { stdout: "", stderr: "linux ssh endpoint is required", exitCode: 1 };
  }
  const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", endpoint];
  if (action === "linux.system.info") {
    return runExecFile("ssh", [...base, "uname -a && uptime"], timeoutMs);
  }
  if (action === "linux.service.status") {
    const service = requiredShellParam(params, "service");
    return runExecFile("ssh", [...base, `systemctl is-active ${service}`], timeoutMs);
  }
  if (action === "linux.journal.query") {
    const unit = safeShellParam(params, "unit");
    const lines = readBoundedInteger(params, "lines", 80, 1, 500);
    const command = unit ? `journalctl -u ${unit} -n ${lines} --no-pager` : `journalctl -n ${lines} --no-pager`;
    return runExecFile("ssh", [...base, command], timeoutMs);
  }
  const command = requiredShellParam(params, "command");
  return runExecFile("ssh", [...base, command], timeoutMs);
}

async function executeWindows(
  device: GatewayDeviceInput,
  action: SupportedAction,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<ExecResult> {
  if (device.transport === "winrm") {
    return {
      stdout: "",
      stderr: "transport_unavailable: WinRM execution is contracted but not installed in this gateway image. Use Windows OpenSSH or install a WinRM bridge.",
      exitCode: 127,
    };
  }
  const endpoint = device.endpoint || "";
  if (!endpoint) {
    return { stdout: "", stderr: "windows ssh endpoint is required", exitCode: 1 };
  }
  const base = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", endpoint, "powershell", "-NoProfile", "-NonInteractive", "-Command"];
  if (action === "windows.system.info") {
    return runExecFile("ssh", [...base, "Get-ComputerInfo | Select-Object CsName,WindowsProductName,OsVersion | ConvertTo-Json -Compress"], timeoutMs);
  }
  if (action === "windows.service.status") {
    const service = requiredShellParam(params, "service");
    return runExecFile("ssh", [...base, `Get-Service -Name '${service.replace(/'/g, "''")}' | ConvertTo-Json -Compress`], timeoutMs);
  }
  if (action === "windows.eventlog.query") {
    const logName = safeShellParam(params, "logName") || "System";
    const maxEvents = readBoundedInteger(params, "maxEvents", 20, 1, 200);
    return runExecFile(
      "ssh",
      [...base, `Get-EventLog -LogName '${logName.replace(/'/g, "''")}' -Newest ${maxEvents} | ConvertTo-Json -Compress`],
      timeoutMs,
    );
  }
  const command = requiredShellParam(params, "command");
  return runExecFile("ssh", [...base, command], timeoutMs);
}

async function executeAndroid(action: SupportedAction, params: Record<string, unknown>, timeoutMs: number): Promise<ExecResult> {
  const serial = readString(params, "serial").trim();
  const prefix = serial ? ["-s", serial] : [];
  if (action === "android.system.info") {
    return runExecFile("adb", [...prefix, "shell", "getprop", "ro.product.model"], timeoutMs);
  }
  if (action === "android.logcat") {
    const lines = readBoundedInteger(params, "lines", 80, 1, 500);
    return runExecFile("adb", [...prefix, "logcat", "-d", "-t", String(lines)], timeoutMs);
  }
  const command = requiredShellParam(params, "command");
  return runExecFile("adb", [...prefix, "shell", command], timeoutMs);
}

async function executeTizen(action: SupportedAction, params: Record<string, unknown>, timeoutMs: number): Promise<ExecResult> {
  const serial = readString(params, "serial").trim();
  const prefix = serial ? ["-s", serial] : [];
  if (action === "tizen.system.info") {
    return runExecFile("sdb", [...prefix, "shell", "uname -a"], timeoutMs);
  }
  if (action === "tizen.dlog") {
    const lines = readBoundedInteger(params, "lines", 80, 1, 500);
    return runExecFile("sdb", [...prefix, "dlog", "-d", "-t", String(lines)], timeoutMs);
  }
  const command = requiredShellParam(params, "command");
  return runExecFile("sdb", [...prefix, "shell", command], timeoutMs);
}

async function executeCommand(input: GatewayCommandInput): Promise<GatewayCommandResult> {
  validatePlatformTransport(input.device);
  validateEndpointPolicy(input.device);
  const action = validateAction(input.device, input.action);
  const timeoutMs = commandTimeoutMs(input.timeoutMs);
  const commandId = input.commandId || randomUUID();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const secretValues = collectSecretValues(input.params || {});

  let execResult: ExecResult;
  try {
    if (Object.values(input.params || {}).some((value) => typeof value === "string" && blockedCommandText(value))) {
      execResult = { stdout: "", stderr: "Command is blocked by device gateway policy", exitCode: 126 };
    } else if (input.device.platform === "local_mock") {
      execResult = await executeLocalMock(action, input.params || {}, timeoutMs);
    } else if (input.device.platform === "linux") {
      execResult = await executeLinux(input.device, action, input.params || {}, timeoutMs);
    } else if (input.device.platform === "windows") {
      execResult = await executeWindows(input.device, action, input.params || {}, timeoutMs);
    } else if (input.device.platform === "android") {
      execResult = await executeAndroid(action, input.params || {}, timeoutMs);
    } else {
      execResult = await executeTizen(action, input.params || {}, timeoutMs);
    }
  } catch (error) {
    execResult = {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 126,
    };
  }

  const completedAtMs = Date.now();
  const blocked = execResult.exitCode === 126 && execResult.stderr.toLowerCase().includes("blocked");
  const result: GatewayCommandResult = {
    id: commandId,
    deviceId: input.device.id,
    action,
    status: blocked ? "blocked" : execResult.exitCode === 0 ? "completed" : "failed",
    stdout: capText(redactText(execResult.stdout, secretValues)),
    stderr: capText(redactText(execResult.stderr, secretValues)),
    exitCode: execResult.exitCode,
    artifactUri: null,
    startedAt,
    completedAt: new Date(completedAtMs).toISOString(),
    durationMs: completedAtMs - startedAtMs,
  };
  await saveResult(result);
  return result;
}

function discoveredDevices(): DeviceSummary[] {
  const now = new Date().toISOString();
  return [
    {
      id: "local-mock",
      projectId: "00000000-0000-0000-0000-000000000101",
      key: "local-mock",
      name: "Local Mock Device",
      platform: "local_mock",
      transport: "local_mock",
      endpoint: "local://termes/device-gateway",
      labels: { source: "device-gateway", purpose: "smoke" },
      status: "online",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

async function main(): Promise<void> {
  await mkdir(path.join(gatewayRoot(), "commands"), { recursive: true });
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({
    service: "device-gateway",
    version: TERMES_VERSION,
    status: "ok",
    checkedAt: new Date().toISOString(),
    root: gatewayRoot(),
    supportedActions,
  }));

  app.get("/devices", async () => ({ devices: discoveredDevices() }));
  app.post("/devices/discover", async () => ({ devices: discoveredDevices() }));

  app.post("/devices/:deviceId/command", async (request, reply) => {
    try {
      const input = parseCommandInput(request.body);
      const params = request.params as { deviceId?: string };
      if (params.deviceId && input.device.id && params.deviceId !== input.device.id) {
        return reply.code(400).send({ error: "Route deviceId does not match body device.id" });
      }
      const result = await executeCommand(input);
      return result;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/commands/:commandId", async (request, reply) => {
    const params = request.params as { commandId?: string };
    const result = params.commandId ? await readSavedResult(params.commandId) : null;
    if (!result) {
      return reply.code(404).send({ error: "Command result not found" });
    }
    return result;
  });

  app.get("/commands/:commandId/logs", async (request, reply) => {
    const params = request.params as { commandId?: string };
    const result = params.commandId ? await readSavedResult(params.commandId) : null;
    if (!result) {
      return reply.code(404).send({ error: "Command result not found" });
    }
    return {
      commandId: result.id,
      stdout: result.stdout,
      stderr: result.stderr,
      artifactUri: result.artifactUri,
    };
  });

  await app.listen({ host: "0.0.0.0", port: port() });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

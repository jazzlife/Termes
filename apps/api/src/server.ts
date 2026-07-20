import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type {
  AgentRunSummary,
  ArtifactSummary,
  ChatMessageRole,
  ChatMessageSummary,
  CheckpointSummary,
  CapabilityPackageSummary,
  DeviceCommandStatus,
  DeviceCommandSummary,
  DevicePlatform,
  DeviceStatus,
  DeviceSummary,
  DeviceTransport,
  EventType,
  HermesCapabilitySummary,
  PlatformEvent,
  ProjectSummary,
  RuntimeSessionSummary,
  TaskPlanStepSummary,
  TaskPlanSummary,
  TaskRuntimeSummary,
  TaskStatus,
  TaskSummary,
  VerificationResultSummary,
  VerificationStatus,
} from "@termes/shared";
import {
  TERMES_VERSION,
  assertDeviceCommandStatus,
  assertDevicePlatform,
  assertDeviceStatus,
  assertDeviceTransport,
  assertTaskStatus,
  assertVerificationStatus,
} from "@termes/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import Redis from "ioredis";
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { z } from "zod";
import { loadConfig } from "./config";
import { assertDbReady, createDb, type Db } from "./db";
import { EVENT_CHANNEL, EventOutboxDispatcher, TurnDispatchOutboxDispatcher, appendEvent } from "./events";
import { registerHermesRealtime } from "./hermes-realtime";
import { registerOpenAiAuth } from "./openai-auth";
import { requestHermesControl } from "./hermes-rpc-control";
import { createAccountAuth, type AccountPrincipal } from "./account-auth";

const projectInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional(),
  workspacePath: z.string().trim().max(512).optional(),
});

const projectPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "At least one project field is required",
  });

const taskInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(180),
  instructions: z.string().trim().min(1).max(10000),
});

const taskPatchSchema = z
  .object({
    title: z.string().trim().min(2).max(180).optional(),
    instructions: z.string().trim().min(1).max(10000).optional(),
    status: z.string().optional(),
  })
  .refine(
    (value) => value.title !== undefined || value.instructions !== undefined || value.status !== undefined,
    { message: "At least one task field is required" },
  );

const chatMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(20000),
});

const hermesInteractionResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    choice: z.enum(["once", "session", "always", "deny"]),
  }),
  z.object({
    type: z.literal("clarify"),
    requestId: z.string().trim().min(1).max(200),
    answer: z.string().max(20000),
  }),
  z.object({
    type: z.literal("sudo"),
    requestId: z.string().trim().min(1).max(200),
    password: z.string().max(4096),
  }),
  z.object({
    type: z.literal("secret"),
    requestId: z.string().trim().min(1).max(200),
    value: z.string().max(65536),
  }),
]);

const devicePlatformSchema = z.enum(["android", "tizen", "linux", "windows", "local_mock"]);
const deviceTransportSchema = z.enum(["adb", "sdb", "ssh", "winrm", "local_mock"]);
const deviceStatusSchema = z.enum(["unknown", "offline", "online", "busy", "error"]);

const deviceInputSchema = z.object({
  projectId: z.string().uuid().optional(),
  key: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(120),
  platform: devicePlatformSchema,
  transport: deviceTransportSchema,
  endpoint: z.string().trim().max(512).nullable().optional(),
  labels: z.record(z.string()).optional(),
  status: deviceStatusSchema.optional(),
});

const devicePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    transport: deviceTransportSchema.optional(),
    endpoint: z.string().trim().max(512).nullable().optional(),
    labels: z.record(z.string()).optional(),
    status: deviceStatusSchema.optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.transport !== undefined ||
      value.endpoint !== undefined ||
      value.labels !== undefined ||
      value.status !== undefined,
    { message: "At least one device field is required" },
  );

const deviceDiscoverInputSchema = z.object({
  projectId: z.string().uuid().optional(),
});

const deviceCommandInputSchema = z.object({
  taskId: z.string().uuid().nullable().optional(),
  action: z.string().trim().min(1).max(120),
  params: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
});

const capabilityInputSchema = z.object({
  key: z.string().trim().min(2).max(100),
  name: z.string().trim().min(2).max(140),
  description: z.string().trim().min(1).max(1000),
  platforms: z.array(devicePlatformSchema).optional(),
  actions: z.array(z.string().trim().min(1).max(120)).optional(),
  enabled: z.boolean().optional(),
});

const capabilityPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(140).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    platforms: z.array(devicePlatformSchema).optional(),
    actions: z.array(z.string().trim().min(1).max(120)).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.platforms !== undefined ||
      value.actions !== undefined ||
      value.enabled !== undefined,
    { message: "At least one capability field is required" },
  );

const githubCloneInputSchema = z.object({
  repositoryFullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  parentPath: z.string().trim().max(240).optional(),
});

const projectFolderCreateInputSchema = z.object({
  parentPath: z.string().trim().max(240).optional(),
  name: z.string().trim().min(1).max(120),
});

const projectFolderRegisterInputSchema = z.object({
  path: z.string().trim().min(1).max(240),
  name: z.string().trim().min(1).max(120).optional(),
});

const workspaceUid = process.env.HERMES_UID || "10000";
const workspaceGid = process.env.HERMES_GID || "10000";
const githubSecretsRootPath = path.resolve(process.env.GITHUB_SECRETS_ROOT || "/data/docker_data/termes/secrets");
const execFileAsync = promisify(execFile);
const githubDeviceSessionPrefix = "github.oauth.device.";

type ProjectRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  workspace_path: string | null;
  created_at: Date;
  updated_at: Date;
};

type GitHubConnectionRecord = {
  accessToken: string;
  login: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  linkedAt: string | null;
};

type GitHubApiUser = {
  login?: string;
  avatar_url?: string;
  html_url?: string;
};

type GitHubApiRepository = {
  name?: string;
  full_name?: string;
  private?: boolean;
  visibility?: "public" | "private" | "internal";
  default_branch?: string;
  owner?: {
    login?: string;
  };
};

type ProjectFolderRow = {
  path: string;
  name: string;
  type: "directory";
  depth: number;
};

type GitHubDeviceSession = {
  accountId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  interval: number;
  scope: string;
};

function resolveProjectWorkspacePath(workspaceRoot: string, projectKey: string, requestedPath?: string): string {
  const root = path.resolve(workspaceRoot);
  const rawPath = requestedPath?.trim();
  const candidate = rawPath
    ? path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath))
    : path.resolve(root, "projects", projectKey);

  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${root}`);
  }

  return candidate;
}

function slugifyProjectKey(value: string): string {
  const key = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return key.length >= 2 ? key : `project-${Date.now().toString(36)}`;
}

function deviceKeyFromName(value: string, platform: DevicePlatform): string {
  return `${platform}-${slugifyProjectKey(value).slice(0, 56)}`;
}

function assertPlatformTransport(platform: DevicePlatform, transport: DeviceTransport): void {
  const allowed: Record<DevicePlatform, DeviceTransport[]> = {
    local_mock: ["local_mock"],
    linux: ["ssh"],
    windows: ["winrm", "ssh"],
    android: ["adb"],
    tizen: ["sdb"],
  };
  if (!allowed[platform].includes(transport)) {
    throw new Error(`Transport ${transport} is not allowed for platform ${platform}`);
  }
}

function actionPlatform(action: string): DevicePlatform | null {
  const prefix = action.split(".")[0];
  if (!prefix) {
    return null;
  }
  try {
    return assertDevicePlatform(prefix);
  } catch {
    return null;
  }
}

function blockedDeviceAction(action: string, params: Record<string, unknown>): string | null {
  const joined = `${action} ${JSON.stringify(params)}`.toLowerCase();
  const patterns = [
    "rm -rf /",
    "mkfs",
    "dd if=",
    "format-volume",
    "remove-item -recurse c:\\",
    "clear-eventlog",
    "stop-computer",
    "restart-computer",
    "shutdown",
    "reboot",
    "diskpart",
    "bcdedit",
  ];
  const blocked = patterns.find((pattern) => joined.includes(pattern));
  return blocked ? `Blocked dangerous command pattern: ${blocked}` : null;
}

function approvalRequiredAction(action: string): boolean {
  return (
    action === "linux.service.restart" ||
    action === "windows.service.restart" ||
    action.startsWith("windows.app.install") ||
    action === "windows.app.uninstall" ||
    action === "android.install" ||
    action === "android.uninstall" ||
    action === "tizen.install" ||
    action === "tizen.uninstall"
  );
}

function normalizeJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const secretParamKeyPattern =
  /(password|passwd|passphrase|token|secret|clientsecret|client_secret|api[-_]?key|private[-_]?key|authorization|credential)/i;

function redactSecretParams(value: unknown, key = ""): unknown {
  if (secretParamKeyPattern.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretParams(item));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      redacted[childKey] = redactSecretParams(childValue, childKey);
    }
    return redacted;
  }
  return value;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = normalizeJsonRecord(value);
  const normalized: Record<string, string> = {};
  for (const [key, candidate] of Object.entries(record)) {
    if (typeof candidate === "string") {
      normalized[key] = candidate;
    }
  }
  return normalized;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizePlatformArray(value: unknown): DevicePlatform[] {
  return normalizeStringArray(value)
    .map((platform) => {
      try {
        return assertDevicePlatform(platform);
      } catch {
        return null;
      }
    })
    .filter((platform): platform is DevicePlatform => Boolean(platform));
}

function taskPlanStatusFromSteps(steps: TaskPlanStepSummary[]): TaskPlanSummary["status"] {
  if (steps.some((step) => step.status === "failed")) {
    return "failed";
  }
  if (steps.some((step) => step.status === "blocked")) {
    return "blocked";
  }
  if (steps.some((step) => step.status === "running")) {
    return "running";
  }
  if (steps.length > 0 && steps.every((step) => step.status === "completed")) {
    return "completed";
  }
  return "created";
}

function normalizeRelativeWorkspacePath(value?: string): string {
  const normalized = (value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Workspace path traversal is not allowed");
  }
  return segments.join("/");
}

function resolveProjectSandboxPath(workspaceRoot: string, relativePath: string): string {
  const projectsRoot = path.join(path.resolve(workspaceRoot), "projects");
  const normalized = normalizeRelativeWorkspacePath(relativePath);
  const candidate = path.resolve(projectsRoot, normalized);
  if (candidate !== projectsRoot && !candidate.startsWith(`${projectsRoot}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${projectsRoot}`);
  }
  return candidate;
}

async function makeWorkspacePathWritable(workspaceRoot: string, absolutePath: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(absolutePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${root}`);
  }
  await execFileAsync("chown", ["-R", `${workspaceUid}:${workspaceGid}`, candidate]);
  await execFileAsync("chmod", ["-R", "u+rwX,go-rwx", candidate]);
}

async function makeWorkspaceDirectoryWritable(workspaceRoot: string, absolutePath: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(absolutePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${root}`);
  }
  await execFileAsync("chown", [`${workspaceUid}:${workspaceGid}`, candidate]);
  await chmod(candidate, 0o700);
}

async function listProjectFolders(workspaceRoot: string): Promise<ProjectFolderRow[]> {
  const projectsRoot = path.join(path.resolve(workspaceRoot), "projects");
  await mkdir(projectsRoot, { recursive: true });
  await makeWorkspaceDirectoryWritable(workspaceRoot, projectsRoot);
  const rows: ProjectFolderRow[] = [];

  async function walk(absolutePath: string, relativePath: string, depth: number): Promise<void> {
    if (depth > 4) {
      return;
    }
    const entries = await readdir(absolutePath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of directories) {
      const childRelativePath = normalizeRelativeWorkspacePath(path.posix.join(relativePath, entry.name));
      const childAbsolutePath = resolveProjectSandboxPath(workspaceRoot, childRelativePath);
      rows.push({
        path: childRelativePath,
        name: entry.name,
        type: "directory",
        depth,
      });
      await walk(childAbsolutePath, childRelativePath, depth + 1);
    }
  }

  await walk(projectsRoot, "", 0);
  return rows;
}

function safeReturnTo(value: unknown): string {
  const candidate = typeof value === "string" ? value : "/";
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}

function buildExternalBaseUrl(request: { headers: Record<string, unknown> }): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/g, "");
  }
  const host = String(request.headers.host || "127.0.0.1:8080");
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0]?.trim() || "http";
  return `${proto}://${host}`;
}

function githubOAuthCallbackUrl(request: { headers: Record<string, unknown> }): string {
  const configured = process.env.GITHUB_OAUTH_CALLBACK_URL?.trim();
  if (configured) {
    return configured;
  }
  return `${buildExternalBaseUrl(request)}/api/github/oauth/callback`;
}

function githubOAuthScope(): string {
  return process.env.GITHUB_OAUTH_SCOPE?.trim() || "repo read:org";
}

function githubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID?.trim() && githubClientSecret());
}

function githubBrowserOAuthEnabled(): boolean {
  const configured = process.env.GITHUB_BROWSER_OAUTH_ENABLED?.trim().toLowerCase();
  if (!configured) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(configured);
}

function githubDeviceConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID?.trim());
}

function githubClientSecret(): string {
  const encrypted = process.env.GITHUB_CLIENT_SECRET_ENC?.trim();
  if (!encrypted) {
    return "";
  }

  try {
    const [, ivRaw, tagRaw, cipherRaw] = encrypted.split(":");
    if (!ivRaw || !tagRaw || !cipherRaw) {
      return "";
    }
    const keyPath = process.env.GITHUB_SECRET_KEY_FILE?.trim() || path.join(githubSecretsRootPath, "github-oauth.key");
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== 32) {
      return "";
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(cipherRaw, "base64")), decipher.final()]).toString("utf8").trim();
  } catch {
    return "";
  }
}

function githubConnectionFilePath(accountId: string): string {
  return path.join(githubSecretsRootPath, "accounts", accountId, "github-connection.json");
}

async function readGithubConnection(accountId: string, allowEnvToken: boolean): Promise<GitHubConnectionRecord | null> {
  const envToken = allowEnvToken ? process.env.GITHUB_TOKEN?.trim() : "";
  if (envToken) {
    return {
      accessToken: envToken,
      login: process.env.GITHUB_LOGIN?.trim() || null,
      avatarUrl: null,
      profileUrl: null,
      linkedAt: null,
    };
  }

  try {
    const raw = JSON.parse(await readFile(githubConnectionFilePath(accountId), "utf8")) as Partial<GitHubConnectionRecord>;
    if (!raw.accessToken || typeof raw.accessToken !== "string") {
      return null;
    }
    return {
      accessToken: raw.accessToken,
      login: typeof raw.login === "string" ? raw.login : null,
      avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
      profileUrl: typeof raw.profileUrl === "string" ? raw.profileUrl : null,
      linkedAt: typeof raw.linkedAt === "string" ? raw.linkedAt : null,
    };
  } catch {
    return null;
  }
}

async function writeGithubConnection(accountId: string, record: GitHubConnectionRecord): Promise<void> {
  const filePath = githubConnectionFilePath(accountId);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(filePath), 0o700);
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function clearGithubConnection(accountId: string, allowEnvToken: boolean): Promise<"cleared" | "env-token"> {
  if (allowEnvToken && process.env.GITHUB_TOKEN?.trim()) {
    return "env-token";
  }
  await rm(githubConnectionFilePath(accountId), { force: true });
  return "cleared";
}

function githubConnectionSummary(record: GitHubConnectionRecord | null, request: { headers: Record<string, unknown> }) {
  return {
    connected: Boolean(record),
    login: record?.login ?? null,
    avatarUrl: record?.avatarUrl ?? null,
    profileUrl: record?.profileUrl ?? null,
    linkedAt: record?.linkedAt ?? null,
    oauthConfigured: githubOAuthConfigured(),
    browserOAuthEnabled: githubOAuthConfigured() && githubBrowserOAuthEnabled(),
    deviceConfigured: githubDeviceConfigured(),
    callbackUrl: githubOAuthCallbackUrl(request),
  };
}

async function requestGitHubOAuthForm(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "termes",
    },
    body: new URLSearchParams(params),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(typeof payload?.message === "string" ? payload.message : "GitHub OAuth request failed");
  }
  return payload ?? {};
}

function readOAuthText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readOAuthNumber(payload: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

async function githubApi<T>(pathname: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "termes",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function uniqueProjectKey(db: Db, workspaceId: string, baseKey: string): Promise<string> {
  const base = slugifyProjectKey(baseKey);
  for (let index = 0; index < 20; index += 1) {
    const candidate = index === 0 ? base : `${base.slice(0, Math.max(2, 36 - String(index).length - 1))}-${index}`;
    const result = await db.pool.query<{ exists: boolean }>(
      "select exists(select 1 from projects where workspace_id = $1 and key = $2) as exists",
      [workspaceId, candidate],
    );
    if (!result.rows[0]?.exists) {
      return candidate;
    }
  }
  return `${base.slice(0, 26)}-${Date.now().toString(36)}`;
}

async function cloneGithubRepository(input: {
  repositoryFullName: string;
  targetAbsolutePath: string;
  token: string;
}): Promise<void> {
  const askpassDir = await mkdtemp(path.join(os.tmpdir(), "termes-git-askpass-"));
  const askpassPath = path.join(askpassDir, "askpass.sh");
  const script = [
    "#!/bin/sh",
    "case \"$1\" in",
    "  *Username*) printf '%s\\n' 'x-access-token' ;;",
    `  *) printf '%s\\n' '${input.token.replace(/'/g, "'\\''")}' ;;`,
    "esac",
    "",
  ].join("\n");

  try {
    await writeFile(askpassPath, script, { mode: 0o700 });
    await chmod(askpassPath, 0o700);
    await execFileAsync("git", ["clone", `https://github.com/${input.repositoryFullName}.git`, input.targetAbsolutePath], {
      env: {
        ...process.env,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 120_000,
    });
  } finally {
    await rm(askpassDir, { recursive: true, force: true });
  }
}

function mapProject(row: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  workspace_path: string | null;
  created_at: Date;
  updated_at: Date;
}): ProjectSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    workspacePath: row.workspace_path,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at?.toISOString(),
  };
}

function mapTask(row: {
  id: string;
  project_id: string;
  title: string;
  instructions: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}): TaskSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    instructions: row.instructions,
    status: assertTaskStatus(row.status),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapSession(row: {
  id: string;
  task_id: string;
  runtime_profile_id: string | null;
  hermes_session_id: string | null;
  hermes_live_session_id: string | null;
  hermes_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}): RuntimeSessionSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    runtimeProfileId: row.runtime_profile_id,
    hermesSessionId: row.hermes_session_id,
    hermesLiveSessionId: row.hermes_live_session_id,
    hermesRunId: row.hermes_run_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapRun(row: {
  id: string;
  task_id: string;
  soul_id: string | null;
  runtime_session_id: string | null;
  status: AgentRunSummary["status"];
  branch_name: string | null;
  worktree_path: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): AgentRunSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    soulId: row.soul_id,
    runtimeSessionId: row.runtime_session_id,
    status: row.status,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    startedAt: row.started_at?.toISOString() || null,
    completedAt: row.completed_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCheckpoint(row: {
  id: string;
  task_id: string;
  agent_run_id: string | null;
  summary: string;
  git_commit_sha: string | null;
  snapshot_uri: string | null;
  checksum: string | null;
  changed_files: unknown;
  test_result: Record<string, unknown>;
  created_at: Date;
}): CheckpointSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    agentRunId: row.agent_run_id,
    summary: row.summary,
    gitCommitSha: row.git_commit_sha,
    snapshotUri: row.snapshot_uri,
    checksum: row.checksum,
    changedFiles: Array.isArray(row.changed_files) ? row.changed_files : [],
    testResult: row.test_result,
    createdAt: row.created_at.toISOString(),
  };
}

function mapArtifact(row: {
  id: string;
  project_id: string | null;
  task_id: string | null;
  kind: string;
  uri: string;
  checksum: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}): ArtifactSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    kind: row.kind,
    uri: row.uri,
    checksum: row.checksum,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapEvent(row: {
  id: string;
  project_id: string | null;
  task_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: Date;
}): PlatformEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

function mapChatMessage(row: {
  id: string;
  project_id: string;
  task_id: string;
  role: ChatMessageRole;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}): ChatMessageSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    role: row.role,
    source: row.source,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

function mapDevice(row: {
  id: string;
  project_id: string;
  key: string;
  name: string;
  platform: string;
  transport: string;
  endpoint: string | null;
  labels: unknown;
  status: string;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): DeviceSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    name: row.name,
    platform: assertDevicePlatform(row.platform),
    transport: assertDeviceTransport(row.transport),
    endpoint: row.endpoint,
    labels: normalizeStringRecord(row.labels),
    status: assertDeviceStatus(row.status),
    lastSeenAt: row.last_seen_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapDeviceCommand(row: {
  id: string;
  project_id: string;
  task_id: string | null;
  device_id: string;
  action: string;
  params: unknown;
  status: string;
  approval_id: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  artifact_uri: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): DeviceCommandSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    deviceId: row.device_id,
    action: row.action,
    params: normalizeJsonRecord(row.params),
    status: assertDeviceCommandStatus(row.status),
    approvalId: row.approval_id,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exit_code,
    artifactUri: row.artifact_uri,
    startedAt: row.started_at?.toISOString() || null,
    completedAt: row.completed_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapCapabilityPackage(row: {
  id: string;
  key: string;
  name: string;
  description: string;
  platforms: unknown;
  actions: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}): CapabilityPackageSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    platforms: normalizePlatformArray(row.platforms),
    actions: normalizeStringArray(row.actions),
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapTaskPlan(row: {
  id: string;
  task_id: string;
  selected_capabilities: unknown;
  steps: unknown;
  status: string;
  created_at: Date;
  updated_at: Date;
}): TaskPlanSummary {
  const rawSteps = Array.isArray(row.steps) ? row.steps : [];
  const steps = rawSteps
    .map((step): TaskPlanStepSummary | null => {
      if (!step || typeof step !== "object") {
        return null;
      }
      const record = step as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "verification.check";
      if (!["hermes.run", "runner.run", "device.command", "approval.required", "verification.check"].includes(type)) {
        return null;
      }
      const status = typeof record.status === "string" ? record.status : "created";
      if (!["created", "running", "completed", "failed", "blocked"].includes(status)) {
        return null;
      }
      return {
        id: typeof record.id === "string" ? record.id : `step-${Number(record.order || 0)}`,
        type: type as TaskPlanStepSummary["type"],
        title: typeof record.title === "string" ? record.title : "Plan step",
        status: status as TaskPlanStepSummary["status"],
        capabilityKey: typeof record.capabilityKey === "string" ? record.capabilityKey : null,
        deviceCommandId: typeof record.deviceCommandId === "string" ? record.deviceCommandId : null,
        verificationResultId: typeof record.verificationResultId === "string" ? record.verificationResultId : null,
        order: typeof record.order === "number" ? record.order : 0,
      };
    })
    .filter((step): step is TaskPlanStepSummary => Boolean(step))
    .sort((left, right) => left.order - right.order);

  return {
    id: row.id,
    taskId: row.task_id,
    selectedCapabilities: normalizeStringArray(row.selected_capabilities),
    steps,
    status: taskPlanStatusFromSteps(steps) === "created" ? (row.status as TaskPlanSummary["status"]) : taskPlanStatusFromSteps(steps),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapVerificationResult(row: {
  id: string;
  project_id: string | null;
  task_id: string | null;
  device_command_id: string | null;
  kind: string;
  status: string;
  confidence: string | number;
  summary: string;
  metadata: unknown;
  created_at: Date;
}): VerificationResultSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    deviceCommandId: row.device_command_id,
    kind: row.kind,
    status: assertVerificationStatus(row.status),
    confidence: typeof row.confidence === "number" ? row.confidence : Number.parseFloat(row.confidence),
    summary: row.summary,
    metadata: normalizeJsonRecord(row.metadata),
    createdAt: row.created_at.toISOString(),
  };
}

function firstText(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function hermesCompletionFailure(value: unknown, assistantText = ""): string | null {
  const visibleText = assistantText.trim();
  const runtimeErrorPattern = /codex app-server|stdin closed unexpectedly|broken pipe|fall back to default runtime/i;
  if (visibleText && runtimeErrorPattern.test(visibleText)) {
    return visibleText;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const explicitError = firstText(record, ["error", "message"]);
  if (explicitError && (record.completed === false || record.partial === true || runtimeErrorPattern.test(explicitError))) {
    return explicitError;
  }
  if (record.completed === false) {
    return explicitError || "Hermes upstream reported an incomplete Codex app-server turn.";
  }

  return null;
}

function upstreamFetchErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "fetch failed";
}

function extractHermesAssistantText(value: unknown): string {
  const direct = firstText(value, ["output", "content", "text"]);
  if (direct) {
    return direct;
  }

  if (value && typeof value === "object") {
    const choices = (value as Record<string, unknown>).choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") {
          continue;
        }
        const message = (choice as Record<string, unknown>).message;
        const messageText = firstText(message, ["content", "output", "text"]);
        if (messageText) {
          return messageText;
        }
      }
    }

    const message = (value as Record<string, unknown>).message;
    const messageText = firstText(message, ["content", "output", "text"]);
    if (messageText) {
      return messageText;
    }
  }

  return JSON.stringify(value);
}

async function insertChatMessage(
  db: Db,
  input: {
    projectId: string;
    taskId: string;
    role: ChatMessageRole;
    source: string;
    content: string;
    metadata?: Record<string, unknown>;
  },
): Promise<ChatMessageSummary> {
  const result = await db.pool.query<{
    id: string;
    project_id: string;
    task_id: string;
    role: ChatMessageRole;
    source: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `
      insert into chat_messages (project_id, task_id, role, source, content, metadata)
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id, project_id, task_id, role, source, content, metadata, created_at
    `,
    [
      input.projectId,
      input.taskId,
      input.role,
      input.source,
      input.content,
      JSON.stringify(input.metadata || {}),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Chat message insert did not return a row");
  }

  return mapChatMessage(row);
}

async function insertTaskTurn(
  client: pg.PoolClient,
  input: {
    accountId: string;
    workspaceId: string;
    runtimeCellId: string;
    projectId: string;
    taskId: string;
    userMessageId: string;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      insert into task_turns (
        account_id, workspace_id, runtime_cell_id, project_id, task_id, user_message_id, status
      ) values ($1, $2, $3, $4, $5, $6, 'requested')
      returning id
    `,
    [input.accountId, input.workspaceId, input.runtimeCellId, input.projectId, input.taskId, input.userMessageId],
  );
  const turnId = result.rows[0]?.id;
  if (!turnId) throw new Error("Task turn insert did not return a row");
  await client.query(
    "insert into turn_dispatch_outbox (turn_id, runtime_cell_id) values ($1, $2)",
    [turnId, input.runtimeCellId],
  );
  return turnId;
}

async function resolveProjectId(
  db: Db,
  accountId: string,
  workspaceId: string,
  requestedProjectId?: string,
): Promise<string> {
  if (requestedProjectId) {
    const project = await db.pool.query<{ id: string }>(
      `
        select p.id
        from projects p
        join project_members pm on pm.project_id = p.id and pm.user_id = $2
        where p.id = $1 and p.workspace_id = $3
      `,
      [requestedProjectId, accountId, workspaceId],
    );
    if ((project.rowCount ?? 0) === 0) {
      throw new Error("Project not found");
    }
    return requestedProjectId;
  }

  const result = await db.pool.query<{ id: string }>(
    `
      select p.id
      from projects p
      join project_members pm on pm.project_id = p.id and pm.user_id = $1
      where p.workspace_id = $2
      order by p.created_at asc
      limit 1
    `,
    [accountId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("No project exists");
  }
  return row.id;
}

function encodeSse(event: string, data: unknown, id?: string): string {
  const lines = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id) {
    lines.unshift(`id: ${id}`);
  }

  return `${lines.join("\n")}\n\n`;
}

function proxyHeaders(headers: Record<string, string | string[] | undefined>): HeadersInit {
  const forwarded: Record<string, string> = {};
  for (const name of ["accept", "idempotency-key", "x-hermes-session-id", "x-hermes-session-key"]) {
    const value = headers[name];
    if (Array.isArray(value)) {
      forwarded[name] = value[0] || "";
    } else if (value) {
      forwarded[name] = value;
    }
  }

  return forwarded;
}

function proxyRequestInit(
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>,
): RequestInit {
  if (method === "GET" || method === "HEAD") {
    return { method, headers: proxyHeaders(headers) };
  }

  return {
    method,
    headers: { "content-type": "application/json", ...proxyHeaders(headers) },
    body: JSON.stringify(body || {}),
  };
}

function hermesProxyPath(url: string): string {
  const path = url.replace(/^\/api\/hermes/, "");
  return path || "/";
}

function secureCompare(left: string, right: string): boolean {
  return createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest());
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  const app = Fastify({
    logger: true,
    requestTimeout: Math.max(Number.parseInt(process.env.API_REQUEST_TIMEOUT_MS || "300000", 10) || 300000, 30_000),
  });
  await redis.connect();
  const eventOutbox = new EventOutboxDispatcher(db.pool, redis, {
    onError: (error) => app.log.error({ err: error }, "Event outbox dispatch failed"),
  });

  await app.register(cors, {
    origin: false,
  });
  await app.register(websocket, {
    options: { maxPayload: 4 * 1024 * 1024 },
  });
  const accountAuth = createAccountAuth({
    db,
    redis,
    accessHashes: config.accountAccessHashes,
    oauthAdminAccountId: config.oauthAdminAccountId,
  });
  const requestPrincipals = new WeakMap<FastifyRequest, AccountPrincipal>();
  const principalForRequest = (request: FastifyRequest): AccountPrincipal => {
    const principal = requestPrincipals.get(request);
    if (!principal) throw new Error("Authenticated account principal is unavailable");
    return principal;
  };
  await accountAuth.registerRoutes(app);

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0] || "/";
    const publicPath = request.method === "OPTIONS"
      || pathname === "/healthz"
      || pathname === "/api/health"
      || pathname === "/api/healthz"
      || pathname === "/api/account-auth/accounts"
      || pathname === "/api/account-auth/login"
      || pathname === "/api/account-auth/session"
      || pathname === "/api/hermes/ws";
    if (publicPath) return;
    const presented = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length).trim()
      : "";
    if (
      pathname === "/api/hermes/realtime-ticket"
      && presented
      && secureCompare(presented, config.hermesManagerServiceToken)
    ) {
      return;
    }
    if (
      request.method === "POST"
      && /^\/api\/devices\/[0-9a-f-]+\/commands$/i.test(pathname)
      && presented
      && secureCompare(presented, config.hermesManagerServiceToken)
    ) {
      const serviceScope = z.object({
        accountId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        runtimeCellId: z.string().uuid(),
      }).safeParse({
        accountId: request.headers["x-termes-account-id"],
        workspaceId: request.headers["x-termes-workspace-id"],
        runtimeCellId: request.headers["x-termes-runtime-cell-id"],
      });
      if (!serviceScope.success) {
        return reply.code(401).send({ error: "invalid_service_scope" });
      }
      const principal = await accountAuth.authenticateServicePrincipal(serviceScope.data);
      if (!principal) {
        return reply.code(401).send({ error: "invalid_service_scope" });
      }
      requestPrincipals.set(request, principal);
      return;
    }
    const principal = await accountAuth.authenticate(request);
    if (!principal) return reply.code(401).send({ error: "authentication_required" });
    requestPrincipals.set(request, principal);
  });

  await registerHermesRealtime(app, { config, db, redis, principalForRequest });
  await registerOpenAiAuth(app, config, principalForRequest);
  eventOutbox.start();
  const turnDispatchOutbox = new TurnDispatchOutboxDispatcher(db.pool, redis, (error) => {
    app.log.error({ err: error }, "Turn dispatch outbox failed");
  });
  turnDispatchOutbox.start();

  app.addHook("onClose", async () => {
    await eventOutbox.stop();
    await turnDispatchOutbox.stop();
    redis.disconnect();
    await db.close();
  });

  app.addHook("preHandler", async (request, reply) => {
    const params = (request.params || {}) as Record<string, unknown>;
    const taskId = typeof params.taskId === "string" ? params.taskId : null;
    const projectId = typeof params.projectId === "string" ? params.projectId : null;
    const deviceId = typeof params.deviceId === "string" ? params.deviceId : null;
    const commandId = typeof params.commandId === "string" ? params.commandId : null;
    if (!taskId && !projectId && !deviceId && !commandId) return;
    const principal = principalForRequest(request);
    if (taskId) {
      const owned = await db.pool.query(
        "select 1 from tasks where id = $1 and account_id = $2 and workspace_id = $3",
        [taskId, principal.accountId, principal.workspaceId],
      );
      if ((owned.rowCount ?? 0) === 0) return reply.code(404).send({ error: "Task not found" });
      return;
    }
    if (projectId) {
      const owned = await db.pool.query(
        `
          select 1
          from projects p
          join project_members pm on pm.project_id = p.id and pm.user_id = $2
          where p.id = $1 and p.workspace_id = $3
        `,
        [projectId, principal.accountId, principal.workspaceId],
      );
      if ((owned.rowCount ?? 0) === 0) return reply.code(404).send({ error: "Project not found" });
      return;
    }
    if (deviceId || commandId) {
      const owned = await db.pool.query(
        commandId
          ? `
              select 1
              from device_commands dc
              join devices d on d.id = dc.device_id
              join projects p on p.id = d.project_id
              join project_members pm on pm.project_id = p.id and pm.user_id = $2
              where dc.id = $1 and p.workspace_id = $3
            `
          : `
              select 1
              from devices d
              join projects p on p.id = d.project_id
              join project_members pm on pm.project_id = p.id and pm.user_id = $2
              where d.id = $1 and p.workspace_id = $3
            `,
        [commandId || deviceId, principal.accountId, principal.workspaceId],
      );
      if ((owned.rowCount ?? 0) === 0) return reply.code(404).send({ error: "Device resource not found" });
    }
  });

  async function healthPayload() {
    await assertDbReady(db.pool);
    await redis.ping();

    return {
      service: "api",
      version: TERMES_VERSION,
      status: "ok",
      checkedAt: new Date().toISOString(),
      dependencies: {
        postgres: "ok",
        redis: "ok",
      },
    };
  }

  app.get("/healthz", healthPayload);
  app.get("/api/health", healthPayload);
  app.get("/api/healthz", healthPayload);

  app.get("/api/github/status", async (request) => {
    const principal = principalForRequest(request);
    return {
      github: githubConnectionSummary(
        await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
        request,
      ),
    };
  });

  for (const oauthStartPath of ["/api/github/oauth/start", "/api/github/oauth/login"]) {
    app.get(oauthStartPath, async (request, reply) => {
      const principal = principalForRequest(request);
      if (!githubOAuthConfigured()) {
        return reply.code(503).send({ error: "GitHub OAuth is not configured" });
      }
      if (!githubBrowserOAuthEnabled()) {
        return reply.code(409).send({
          error: "Browser OAuth is disabled. Use GitHub Device Code login or set GITHUB_BROWSER_OAUTH_ENABLED=true after registering the callback URL.",
          callbackUrl: githubOAuthCallbackUrl(request),
        });
      }

      const query = z.object({ returnTo: z.string().optional() }).parse(request.query);
      const state = randomBytes(24).toString("hex");
      await redis.set(
        `github.oauth.state.${state}`,
        JSON.stringify({ returnTo: safeReturnTo(query.returnTo), accountId: principal.accountId }),
        "EX",
        600,
      );

      const oauthUrl = new URL("https://github.com/login/oauth/authorize");
      oauthUrl.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID?.trim() || "");
      oauthUrl.searchParams.set("redirect_uri", githubOAuthCallbackUrl(request));
      oauthUrl.searchParams.set("state", state);
      oauthUrl.searchParams.set("scope", githubOAuthScope());

      return reply.header("location", oauthUrl.toString()).code(302).send();
    });
  }

  app.post("/api/github/oauth/device/start", async (request) => {
    const principal = principalForRequest(request);
    const clientId = process.env.GITHUB_CLIENT_ID?.trim();
    const scope = githubOAuthScope();
    if (!clientId) {
      return {
        configured: false,
        message: "GitHub OAuth client id is not configured",
        sessionId: "",
        userCode: "",
        verificationUri: "",
        verificationUriComplete: null,
        expiresAt: "",
        interval: 0,
        scope,
      };
    }

    const payload = await requestGitHubOAuthForm("https://github.com/login/device/code", {
      client_id: clientId,
      scope,
    });
    const deviceCode = readOAuthText(payload, "device_code");
    const userCode = readOAuthText(payload, "user_code");
    const verificationUri = readOAuthText(payload, "verification_uri");
    const verificationUriComplete = readOAuthText(payload, "verification_uri_complete") || null;
    const expiresIn = Math.max(60, readOAuthNumber(payload, "expires_in", 900));
    const interval = Math.max(5, readOAuthNumber(payload, "interval", 5));
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error("GitHub device login response is invalid");
    }

    const sessionId = randomBytes(18).toString("hex");
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const session: GitHubDeviceSession = {
      accountId: principal.accountId,
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresAt,
      interval,
      scope,
    };
    await redis.set(`${githubDeviceSessionPrefix}${sessionId}`, JSON.stringify(session), "EX", expiresIn);

    return {
      configured: true,
      message: "GitHub device login started",
      sessionId,
      userCode,
      verificationUri,
      verificationUriComplete,
      expiresAt,
      interval,
      scope,
      github: githubConnectionSummary(
        await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
        request,
      ),
    };
  });

  app.post("/api/github/oauth/device/poll", async (request, reply) => {
    const principal = principalForRequest(request);
    const clientId = process.env.GITHUB_CLIENT_ID?.trim();
    if (!clientId) {
      return reply.code(503).send({ error: "GitHub OAuth client id is not configured" });
    }

    const input = z.object({ sessionId: z.string().trim().min(1) }).parse(request.body);
    const sessionKey = `${githubDeviceSessionPrefix}${input.sessionId}`;
    const rawSession = await redis.get(sessionKey);
    if (!rawSession) {
      return reply.code(404).send({ error: "GitHub device login session was not found or expired" });
    }
    const session = JSON.parse(rawSession) as GitHubDeviceSession;
    if (session.accountId !== principal.accountId) {
      return reply.code(404).send({ error: "GitHub device login session was not found or expired" });
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await redis.del(sessionKey);
      return reply.code(410).send({ error: "GitHub device login code expired" });
    }

    const payload = await requestGitHubOAuthForm("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code: session.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const errorCode = readOAuthText(payload, "error");
    if (errorCode === "authorization_pending") {
      return {
        status: "pending",
        message: "GitHub approval is still pending",
        nextInterval: session.interval,
        github: githubConnectionSummary(
          await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
          request,
        ),
      };
    }
    if (errorCode === "slow_down") {
      const nextInterval = session.interval + 5;
      await redis.set(sessionKey, JSON.stringify({ ...session, interval: nextInterval }), "KEEPTTL");
      return {
        status: "pending",
        message: "GitHub asked to slow down polling",
        nextInterval,
        github: githubConnectionSummary(
          await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
          request,
        ),
      };
    }
    if (errorCode) {
      await redis.del(sessionKey);
      return reply.code(400).send({ error: readOAuthText(payload, "error_description") || `GitHub OAuth error: ${errorCode}` });
    }

    const accessToken = readOAuthText(payload, "access_token");
    if (!accessToken) {
      return reply.code(502).send({ error: "GitHub OAuth access token was not returned" });
    }
    const user = await githubApi<GitHubApiUser>("/user", accessToken);
    await writeGithubConnection(principal.accountId, {
      accessToken,
      login: user.login || null,
      avatarUrl: user.avatar_url || null,
      profileUrl: user.html_url || null,
      linkedAt: new Date().toISOString(),
    });
    await redis.del(sessionKey);

    return {
      status: "complete",
      message: `${user.login || "GitHub"} GitHub account connected`,
      nextInterval: null,
      github: githubConnectionSummary(
        await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
        request,
      ),
    };
  });

  app.get("/api/github/oauth/callback", async (request, reply) => {
    const principal = principalForRequest(request);
    if (!githubOAuthConfigured()) {
      return reply.code(503).send({ error: "GitHub OAuth is not configured" });
    }

    const query = z.object({ code: z.string().optional(), state: z.string().optional() }).parse(request.query);
    const stateKey = query.state ? `github.oauth.state.${query.state}` : "";
    const rawState = stateKey ? await redis.get(stateKey) : null;
    if (stateKey) {
      await redis.del(stateKey);
    }

    const parsedState = rawState
      ? JSON.parse(rawState) as { returnTo?: string; accountId?: string }
      : null;
    const returnTo = safeReturnTo(parsedState?.returnTo || "/");
    const redirectUrl = new URL(returnTo, buildExternalBaseUrl(request));

    try {
      if (!query.code || !parsedState || parsedState.accountId !== principal.accountId) {
        throw new Error("GitHub OAuth state is invalid");
      }

      const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "termes",
        },
        body: new URLSearchParams({
          client_id: process.env.GITHUB_CLIENT_ID?.trim() || "",
          client_secret: githubClientSecret(),
          code: query.code,
          redirect_uri: githubOAuthCallbackUrl(request),
        }),
      });
      const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
      if (!tokenResponse.ok || !tokenPayload.access_token) {
        throw new Error(tokenPayload.error_description || tokenPayload.error || "GitHub OAuth token exchange failed");
      }

      const user = await githubApi<GitHubApiUser>("/user", tokenPayload.access_token);
      await writeGithubConnection(principal.accountId, {
        accessToken: tokenPayload.access_token,
        login: user.login || null,
        avatarUrl: user.avatar_url || null,
        profileUrl: user.html_url || null,
        linkedAt: new Date().toISOString(),
      });

      redirectUrl.searchParams.set("github_oauth", "success");
      redirectUrl.searchParams.set("github_oauth_message", "GitHub 로그인이 완료되었습니다.");
    } catch (error) {
      redirectUrl.searchParams.set("github_oauth", "error");
      redirectUrl.searchParams.set(
        "github_oauth_message",
        error instanceof Error ? error.message : "GitHub 로그인에 실패했습니다.",
      );
    }

    return reply.header("location", redirectUrl.toString()).code(302).send();
  });

  app.post("/api/github/oauth/logout", async (request, reply) => {
    const principal = principalForRequest(request);
    const result = await clearGithubConnection(principal.accountId, principal.accountId === config.singleAccountId);
    if (result === "env-token") {
      return reply.code(409).send({ error: "GitHub is connected by GITHUB_TOKEN; remove the server environment variable to disconnect." });
    }
    return {
      github: githubConnectionSummary(
        await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId),
        request,
      ),
    };
  });

  app.get("/api/github/repositories", async (request, reply) => {
    const principal = principalForRequest(request);
    const connection = await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId);
    if (!connection) {
      return reply.code(401).send({ error: "GitHub login is required" });
    }

    const query = z.object({ q: z.string().trim().optional() }).parse(request.query);
    const repositories = await githubApi<GitHubApiRepository[]>(
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      connection.accessToken,
    );
    const normalizedQuery = query.q?.toLowerCase() || "";
    const grouped = new Map<string, GitHubApiRepository[]>();
    for (const repository of repositories) {
      if (!repository.full_name || !repository.name || !repository.owner?.login) {
        continue;
      }
      if (normalizedQuery && !repository.full_name.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const owner = repository.owner.login;
      const key = owner === connection.login ? "personal" : `group:${owner}`;
      grouped.set(key, [...(grouped.get(key) || []), repository]);
    }

    const groups = [...grouped.entries()].map(([key, items]) => {
      const first = items[0];
      const owner = first?.owner?.login || "";
      const personal = key === "personal";
      return {
        groupId: key,
        label: personal ? "개인 저장소" : `${owner} 저장소`,
        owner,
        scope: personal ? "personal" : "group",
        repositories: items.map((repository) => ({
          owner: repository.owner?.login || "",
          name: repository.name || "",
          fullName: repository.full_name || "",
          visibility: repository.visibility || (repository.private ? "private" : "public"),
          defaultBranch: repository.default_branch || "main",
        })),
      };
    });

    return { groups };
  });

  app.get("/api/projects", async (request) => {
    const principal = principalForRequest(request);
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      workspace_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select
          p.id,
          p.key,
          p.name,
          p.description,
          wr.host_path as workspace_path,
          p.created_at,
          p.updated_at
        from projects p
        join project_members pm on pm.project_id = p.id and pm.user_id = $2
        left join lateral (
          select host_path
          from workspace_roots
          where project_id = p.id
          order by created_at asc
          limit 1
        ) wr on true
        where p.workspace_id = $1
        order by p.created_at asc
      `,
      [principal.workspaceId, principal.accountId],
    );

    return { projects: result.rows.map(mapProject) };
  });

  app.post("/api/projects", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = projectInputSchema.parse(request.body);

    let workspacePath: string;
    try {
      workspacePath = resolveProjectWorkspacePath(principal.workspaceRoot, input.key, input.workspacePath);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid workspace path" });
    }

    const client = await db.pool.connect();
    let row:
      | {
          id: string;
          key: string;
          name: string;
          description: string | null;
          workspace_path: string | null;
          created_at: Date;
          updated_at: Date;
        }
      | undefined;

    try {
      await client.query("begin");
      const result = await client.query<{
        id: string;
        key: string;
        name: string;
        description: string | null;
        workspace_path: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          insert into projects (workspace_id, key, name, description)
          values ($1, $2, $3, $4)
          returning id, key, name, description, $5::text as workspace_path, created_at, updated_at
        `,
        [principal.workspaceId, input.key, input.name, input.description ?? null, workspacePath],
      );

      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }

      await mkdir(workspacePath, { recursive: true });
      await makeWorkspaceDirectoryWritable(principal.workspaceRoot, path.dirname(workspacePath));
      await makeWorkspacePathWritable(principal.workspaceRoot, workspacePath);
      await client.query(
        `
          insert into workspace_roots (workspace_id, project_id, host_path)
          values ($1, $2, $3)
        `,
        [principal.workspaceId, row.id, workspacePath],
      );
      await client.query(
        `
          insert into project_members (project_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [row.id, principal.accountId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const project = mapProject(row);
    await appendEvent(db.pool, redis, {
      projectId: row.id,
      type: "project.created",
      payload: {
        key: row.key,
        name: row.name,
      },
    });

    return reply.code(201).send({ project });
  });

  app.post("/api/projects/folder/create", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = projectFolderCreateInputSchema.parse(request.body);
    const parentPath = normalizeRelativeWorkspacePath(input.parentPath);
    const folderName = normalizeRelativeWorkspacePath(input.name);
    if (!folderName) {
      return reply.code(400).send({ error: "Folder name is required" });
    }

    const folderRelativePath = normalizeRelativeWorkspacePath(path.posix.join(parentPath, folderName));
    const folderAbsolutePath = resolveProjectSandboxPath(principal.workspaceRoot, folderRelativePath);
    await mkdir(folderAbsolutePath, { recursive: true });
    await makeWorkspaceDirectoryWritable(principal.workspaceRoot, path.dirname(folderAbsolutePath));
    await makeWorkspacePathWritable(principal.workspaceRoot, folderAbsolutePath);

    return reply.code(201).send({
      workspaceId: principal.workspaceId,
      name: folderRelativePath.split("/").filter(Boolean).at(-1) || folderRelativePath,
      path: folderRelativePath,
      absolutePath: folderAbsolutePath,
    });
  });

  app.get("/api/projects/folders", async (request) => {
    const principal = principalForRequest(request);
    return {
      workspaceId: principal.workspaceId,
      rootPath: path.join(principal.workspaceRoot, "projects"),
      folders: await listProjectFolders(principal.workspaceRoot),
    };
  });

  app.post("/api/projects/folder", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = projectFolderRegisterInputSchema.parse(request.body);
    const folderRelativePath = normalizeRelativeWorkspacePath(input.path);
    const folderAbsolutePath = resolveProjectSandboxPath(principal.workspaceRoot, folderRelativePath);
    const folderStat = await stat(folderAbsolutePath).catch(() => null);
    if (!folderStat?.isDirectory()) {
      return reply.code(400).send({ error: "Project folder does not exist under the workspace projects root" });
    }

    const projectName = input.name?.trim() || folderRelativePath.split("/").filter(Boolean).at(-1) || "Project";
    const key = await uniqueProjectKey(db, principal.workspaceId, projectName);
    const client = await db.pool.connect();
    let row: ProjectRow | undefined;
    try {
      await client.query("begin");
      const result = await client.query<ProjectRow>(
        `
          insert into projects (workspace_id, key, name, description)
          values ($1, $2, $3, $4)
          returning id, key, name, description, $5::text as workspace_path, created_at, updated_at
        `,
        [principal.workspaceId, key, projectName, `Folder project: ${folderRelativePath}`, folderAbsolutePath],
      );
      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }
      await client.query(
        `
          insert into workspace_roots (workspace_id, project_id, host_path)
          values ($1, $2, $3)
        `,
        [principal.workspaceId, row.id, folderAbsolutePath],
      );
      await client.query(
        `
          insert into project_members (project_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [row.id, principal.accountId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const project = mapProject(row);
    await appendEvent(db.pool, redis, {
      projectId: row.id,
      type: "project.created",
      payload: {
        key: row.key,
        name: row.name,
        source: "folder",
        path: folderRelativePath,
      },
    });

    return reply.code(201).send({
      workspaceId: principal.workspaceId,
      project,
      path: folderRelativePath,
      workspacePath: folderAbsolutePath,
    });
  });

  async function handleGitHubProjectClone(request: FastifyRequest, reply: FastifyReply) {
    const principal = principalForRequest(request);
    const input = githubCloneInputSchema.parse(request.body);
    const connection = await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId);
    if (!connection) {
      return reply.code(401).send({ error: "GitHub login is required" });
    }

    const repositoryName = input.repositoryFullName.split("/")[1];
    if (!repositoryName) {
      return reply.code(400).send({ error: "GitHub repository name is invalid" });
    }
    const targetRelativePath = normalizeRelativeWorkspacePath(path.posix.join(input.parentPath || "", repositoryName));
    const targetAbsolutePath = resolveProjectSandboxPath(principal.workspaceRoot, targetRelativePath);

    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await makeWorkspaceDirectoryWritable(principal.workspaceRoot, path.dirname(targetAbsolutePath));
    try {
      await cloneGithubRepository({
        repositoryFullName: input.repositoryFullName,
        targetAbsolutePath,
        token: connection.accessToken,
      });
      await makeWorkspacePathWritable(principal.workspaceRoot, targetAbsolutePath);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message.replace(connection.accessToken, "[REDACTED]") : "GitHub clone failed",
      });
    }

    const key = await uniqueProjectKey(db, principal.workspaceId, repositoryName);
    const client = await db.pool.connect();
    let row: ProjectRow | undefined;
    try {
      await client.query("begin");
      const result = await client.query<ProjectRow>(
        `
          insert into projects (workspace_id, key, name, description)
          values ($1, $2, $3, $4)
          returning id, key, name, description, $5::text as workspace_path, created_at, updated_at
        `,
        [principal.workspaceId, key, repositoryName, `GitHub clone: ${input.repositoryFullName}`, targetAbsolutePath],
      );
      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }
      await client.query(
        `
          insert into workspace_roots (workspace_id, project_id, host_path)
          values ($1, $2, $3)
        `,
        [principal.workspaceId, row.id, targetAbsolutePath],
      );
      await client.query(
        `
          insert into project_members (project_id, user_id, role)
          values ($1, $2, 'owner')
        `,
        [row.id, principal.accountId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const project = mapProject(row);
    await appendEvent(db.pool, redis, {
      projectId: row.id,
      type: "project.created",
      payload: {
        key: row.key,
        name: row.name,
        source: "github",
        repositoryFullName: input.repositoryFullName,
      },
    });

    return reply.code(201).send({
      project,
      repositoryFullName: input.repositoryFullName,
      workspacePath: targetAbsolutePath,
    });
  }

  async function handleGitHubProjectCloneOnly(request: FastifyRequest, reply: FastifyReply) {
    const principal = principalForRequest(request);
    const input = githubCloneInputSchema.parse(request.body);
    const connection = await readGithubConnection(principal.accountId, principal.accountId === config.singleAccountId);
    if (!connection) {
      return reply.code(401).send({ error: "GitHub login is required" });
    }

    const repositoryName = input.repositoryFullName.split("/")[1];
    if (!repositoryName) {
      return reply.code(400).send({ error: "GitHub repository name is invalid" });
    }
    const targetRelativePath = normalizeRelativeWorkspacePath(path.posix.join(input.parentPath || "", repositoryName));
    const targetAbsolutePath = resolveProjectSandboxPath(principal.workspaceRoot, targetRelativePath);

    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await makeWorkspaceDirectoryWritable(principal.workspaceRoot, path.dirname(targetAbsolutePath));
    try {
      await cloneGithubRepository({
        repositoryFullName: input.repositoryFullName,
        targetAbsolutePath,
        token: connection.accessToken,
      });
      await makeWorkspacePathWritable(principal.workspaceRoot, targetAbsolutePath);
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message.replace(connection.accessToken, "[REDACTED]") : "GitHub clone failed",
      });
    }

    return reply.code(202).send({
      workspaceId: principal.workspaceId,
      repositoryFullName: input.repositoryFullName,
      name: repositoryName,
      path: targetRelativePath,
      workspacePath: targetAbsolutePath,
    });
  }

  app.post("/api/projects/github-clone", handleGitHubProjectClone);
  app.post("/api/projects/clone", handleGitHubProjectCloneOnly);

  app.patch("/api/projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = projectPatchSchema.parse(request.body);
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      workspace_path: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        with updated as (
          update projects
          set
            name = coalesce($2, name),
            description = case when $3::boolean then $4 else description end,
            updated_at = now()
          where id = $1
          returning id, key, name, description, created_at, updated_at
        )
        select
          updated.id,
          updated.key,
          updated.name,
          updated.description,
          wr.host_path as workspace_path,
          updated.created_at,
          updated.updated_at
        from updated
        left join lateral (
          select host_path
          from workspace_roots
          where project_id = updated.id
          order by created_at asc
          limit 1
        ) wr on true
      `,
      [params.projectId, input.name ?? null, input.description !== undefined, input.description ?? null],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Project not found" });
    }

    await appendEvent(db.pool, redis, {
      projectId: row.id,
      type: "project.updated",
      payload: {
        key: row.key,
        name: row.name,
      },
    });

    return { project: mapProject(row) };
  });

  app.delete("/api/projects/:projectId", async (request, reply) => {
    const principal = principalForRequest(request);
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const query = z.object({ removeWorkspace: z.string().optional() }).parse(request.query);
    const removeWorkspace = query.removeWorkspace === "true" || query.removeWorkspace === "1";
    const workspaceResult = removeWorkspace
      ? await db.pool.query<{ host_path: string }>("select host_path from workspace_roots where project_id = $1", [params.projectId])
      : { rows: [] as { host_path: string }[] };
    const result = await db.pool.query<{ id: string; key: string; name: string }>(
      `
        delete from projects
        where id = $1
        returning id, key, name
      `,
      [params.projectId],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const workspaceCleanup: Array<{ path: string; removed: boolean; reason?: string }> = [];
    if (removeWorkspace) {
      const projectsRoot = path.join(path.resolve(principal.workspaceRoot), "projects");
      for (const workspace of workspaceResult.rows) {
        const candidate = path.resolve(workspace.host_path);
        const insideProjectsRoot =
          candidate !== projectsRoot && candidate.startsWith(`${projectsRoot}${path.sep}`);
        if (!insideProjectsRoot) {
          workspaceCleanup.push({ path: candidate, removed: false, reason: "outside_projects_root" });
          continue;
        }
        try {
          await rmdir(candidate);
          workspaceCleanup.push({ path: candidate, removed: true });
        } catch (error) {
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          workspaceCleanup.push({
            path: candidate,
            removed: code === "ENOENT",
            reason: code === "ENOENT" ? "already_missing" : code === "ENOTEMPTY" ? "not_empty" : error instanceof Error ? error.message : "remove_failed",
          });
        }
      }
    }

    await appendEvent(db.pool, redis, {
      projectId: null,
      type: "project.deleted",
      payload: {
        projectId: row.id,
        key: row.key,
        name: row.name,
      },
    });

    return { project: row, deleted: true, workspaceCleanup };
  });

  app.get("/api/devices", async (request) => {
    const principal = principalForRequest(request);
    const query = z.object({ projectId: z.string().uuid().optional() }).parse(request.query);
    const values: string[] = [principal.accountId, principal.workspaceId];
    const clauses: string[] = ["pm.user_id = $1", "p.workspace_id = $2"];
    if (query.projectId) {
      values.push(query.projectId);
      clauses.push(`d.project_id = $${values.length}`);
    }
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      key: string;
      name: string;
      platform: string;
      transport: string;
      endpoint: string | null;
      labels: unknown;
      status: string;
      last_seen_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select d.id, d.project_id, d.key, d.name, d.platform, d.transport, d.endpoint, d.labels, d.status,
               d.last_seen_at, d.created_at, d.updated_at
        from devices d
        join projects p on p.id = d.project_id
        join project_members pm on pm.project_id = p.id
        ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
        order by updated_at desc, created_at desc
      `,
      values,
    );
    return { devices: result.rows.map(mapDevice) };
  });

  app.post("/api/devices", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = deviceInputSchema.parse(request.body);
    const projectId = await resolveProjectId(db, principal.accountId, principal.workspaceId, input.projectId);
    try {
      assertPlatformTransport(input.platform, input.transport);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid device transport" });
    }
    const key = input.key?.trim() || deviceKeyFromName(input.name, input.platform);
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      key: string;
      name: string;
      platform: string;
      transport: string;
      endpoint: string | null;
      labels: unknown;
      status: string;
      last_seen_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        insert into devices (project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, case when $8 = 'online' then now() else null end)
        returning id, project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at, created_at, updated_at
      `,
      [
        projectId,
        key,
        input.name,
        input.platform,
        input.transport,
        input.endpoint ?? null,
        JSON.stringify(input.labels || {}),
        input.status || "unknown",
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Device insert did not return a row");
    }
    await appendEvent(db.pool, redis, {
      projectId,
      type: "device.command.created",
      payload: {
        deviceId: row.id,
        deviceKey: row.key,
        action: "device.registered",
        status: row.status,
      },
    });
    return reply.code(201).send({ device: mapDevice(row) });
  });

  app.patch("/api/devices/:deviceId", async (request, reply) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const input = devicePatchSchema.parse(request.body);
    const current = await db.pool.query<{ platform: string; transport: string }>(
      "select platform, transport from devices where id = $1",
      [params.deviceId],
    );
    const currentRow = current.rows[0];
    if (!currentRow) {
      return reply.code(404).send({ error: "Device not found" });
    }
    const nextTransport = input.transport || assertDeviceTransport(currentRow.transport);
    try {
      assertPlatformTransport(assertDevicePlatform(currentRow.platform), nextTransport);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Invalid device transport" });
    }
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      key: string;
      name: string;
      platform: string;
      transport: string;
      endpoint: string | null;
      labels: unknown;
      status: string;
      last_seen_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        update devices
        set
          name = coalesce($2, name),
          transport = coalesce($3, transport),
          endpoint = case when $4::boolean then $5 else endpoint end,
          labels = case when $6::boolean then $7::jsonb else labels end,
          status = coalesce($8, status),
          last_seen_at = case when $8 = 'online' then now() else last_seen_at end,
          updated_at = now()
        where id = $1
        returning id, project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at, created_at, updated_at
      `,
      [
        params.deviceId,
        input.name ?? null,
        input.transport ?? null,
        input.endpoint !== undefined,
        input.endpoint ?? null,
        input.labels !== undefined,
        JSON.stringify(input.labels || {}),
        input.status ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Device not found" });
    }
    return { device: mapDevice(row) };
  });

  app.delete("/api/devices/:deviceId", async (request, reply) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const result = await db.pool.query<{ id: string; project_id: string; key: string; name: string }>(
      `
        delete from devices
        where id = $1
        returning id, project_id, key, name
      `,
      [params.deviceId],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Device not found" });
    }
    return { device: row, deleted: true };
  });

  app.post("/api/devices/discover", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = deviceDiscoverInputSchema.parse(request.body || {});
    const projectId = await resolveProjectId(db, principal.accountId, principal.workspaceId, input.projectId);
    const response = await fetch(`${config.deviceGatewayUrl}/devices/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const body = (await response.json()) as { devices?: DeviceSummary[]; error?: string };
    if (!response.ok) {
      return reply.code(response.status).send(body);
    }

    const devices: DeviceSummary[] = [];
    for (const discovered of body.devices || []) {
      try {
        assertPlatformTransport(discovered.platform, discovered.transport);
      } catch {
        continue;
      }
      const result = await db.pool.query<{
        id: string;
        project_id: string;
        key: string;
        name: string;
        platform: string;
        transport: string;
        endpoint: string | null;
        labels: unknown;
        status: string;
        last_seen_at: Date | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `
          insert into devices (project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at)
          values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
          on conflict (project_id, key) do update
          set
            name = excluded.name,
            platform = excluded.platform,
            transport = excluded.transport,
            endpoint = excluded.endpoint,
            labels = excluded.labels,
            status = excluded.status,
            last_seen_at = now(),
            updated_at = now()
          returning id, project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at, created_at, updated_at
        `,
        [
          projectId,
          discovered.key,
          discovered.name,
          discovered.platform,
          discovered.transport,
          discovered.endpoint,
          JSON.stringify(discovered.labels || {}),
          discovered.status,
        ],
      );
      const row = result.rows[0];
      if (row) {
        devices.push(mapDevice(row));
      }
    }
    return { devices };
  });

  app.post("/api/devices/:deviceId/commands", async (request, reply) => {
    const params = z.object({ deviceId: z.string().uuid() }).parse(request.params);
    const input = deviceCommandInputSchema.parse(request.body);
    const deviceResult = await db.pool.query<{
      id: string;
      project_id: string;
      key: string;
      name: string;
      platform: string;
      transport: string;
      endpoint: string | null;
      labels: unknown;
      status: string;
      last_seen_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, key, name, platform, transport, endpoint, labels, status, last_seen_at, created_at, updated_at
        from devices
        where id = $1
      `,
      [params.deviceId],
    );
    const deviceRow = deviceResult.rows[0];
    if (!deviceRow) {
      return reply.code(404).send({ error: "Device not found" });
    }
    const device = mapDevice(deviceRow);
    const actionOwner = actionPlatform(input.action);
    if (!actionOwner || actionOwner !== device.platform) {
      return reply.code(400).send({ error: `Action ${input.action} does not match device platform ${device.platform}` });
    }

    const commandParams = input.params || {};
    const commandParamsForLedger = redactSecretParams(commandParams);
    const blockedReason = blockedDeviceAction(input.action, commandParams);
    let status: DeviceCommandStatus = "created";
    let approvalId: string | null = null;
    const commandResult = await db.pool.query<{
      id: string;
      project_id: string;
      task_id: string | null;
      device_id: string;
      action: string;
      params: unknown;
      status: string;
      approval_id: string | null;
      stdout: string | null;
      stderr: string | null;
      exit_code: number | null;
      artifact_uri: string | null;
      started_at: Date | null;
      completed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        insert into device_commands (project_id, task_id, device_id, action, params, status)
        values ($1, $2, $3, $4, $5::jsonb, 'created')
        returning id, project_id, task_id, device_id, action, params, status, approval_id,
                  stdout, stderr, exit_code, artifact_uri, started_at, completed_at, created_at, updated_at
      `,
      [device.projectId, input.taskId ?? null, device.id, input.action, JSON.stringify(commandParamsForLedger)],
    );
    const commandRow = commandResult.rows[0];
    if (!commandRow) {
      throw new Error("Device command insert did not return a row");
    }
    let command = mapDeviceCommand(commandRow);

    await appendEvent(db.pool, redis, {
      projectId: command.projectId,
      taskId: command.taskId,
      type: "device.command.created",
      payload: { deviceCommandId: command.id, deviceId: device.id, action: command.action, status: command.status },
    });

    if (blockedReason || approvalRequiredAction(input.action)) {
      const reason = blockedReason || "Command requires approval";
      if (input.taskId) {
        const approval = await db.pool.query<{ id: string }>(
          `
            insert into approvals (task_id, type, summary, payload)
            values ($1, 'device.command', $2, $3::jsonb)
            returning id
          `,
          [
            input.taskId,
            reason,
            JSON.stringify({ deviceCommandId: command.id, deviceId: device.id, action: input.action }),
          ],
        );
        approvalId = approval.rows[0]?.id || null;
      }
      const update = await db.pool.query<typeof commandRow>(
        `
          update device_commands
          set status = 'blocked',
              approval_id = $2,
              stderr = $3,
              completed_at = now(),
              updated_at = now()
          where id = $1
          returning id, project_id, task_id, device_id, action, params, status, approval_id,
                    stdout, stderr, exit_code, artifact_uri, started_at, completed_at, created_at, updated_at
        `,
        [command.id, approvalId, reason],
      );
      command = mapDeviceCommand(update.rows[0] || commandRow);
      await appendEvent(db.pool, redis, {
        projectId: command.projectId,
        taskId: command.taskId,
        type: "device.command.blocked",
        payload: { deviceCommandId: command.id, deviceId: device.id, action: command.action, reason },
      });
      const verification = await db.pool.query<{
        id: string;
        project_id: string | null;
        task_id: string | null;
        device_command_id: string | null;
        kind: string;
        status: string;
        confidence: string | number;
        summary: string;
        metadata: unknown;
        created_at: Date;
      }>(
        `
          insert into verification_results (
            project_id,
            task_id,
            device_command_id,
            kind,
            status,
            confidence,
            summary,
            metadata
          )
          values ($1, $2, $3, 'device.command', 'warning', 0.8, $4, $5::jsonb)
          returning id, project_id, task_id, device_command_id, kind, status, confidence, summary, metadata, created_at
        `,
        [
          command.projectId,
          command.taskId,
          command.id,
          `${command.action} blocked on ${device.name}: ${reason}`,
          JSON.stringify({ deviceId: device.id, action: command.action, reason, approvalId }),
        ],
      );
      const verificationRow = verification.rows[0];
      if (!verificationRow) {
        throw new Error("Blocked command verification insert did not return a row");
      }
      const verificationResult = mapVerificationResult(verificationRow);
      await appendEvent(db.pool, redis, {
        projectId: command.projectId,
        taskId: command.taskId,
        type: "verification.created",
        payload: {
          verificationResultId: verificationResult.id,
          deviceCommandId: command.id,
          status: verificationResult.status,
        },
      });
      return reply.code(202).send({ command, verificationResult });
    }

    status = "queued";
    await db.pool.query("update device_commands set status = $2, updated_at = now() where id = $1", [command.id, status]);
    await appendEvent(db.pool, redis, {
      projectId: command.projectId,
      taskId: command.taskId,
      type: "device.command.queued",
      payload: { deviceCommandId: command.id, deviceId: device.id, action: command.action, status },
    });

    await db.pool.query("update device_commands set status = 'running', started_at = now(), updated_at = now() where id = $1", [
      command.id,
    ]);
    await appendEvent(db.pool, redis, {
      projectId: command.projectId,
      taskId: command.taskId,
      type: "device.command.running",
      payload: { deviceCommandId: command.id, deviceId: device.id, action: command.action, status: "running" },
    });

    const gatewayResponse = await fetch(`${config.deviceGatewayUrl}/devices/${encodeURIComponent(device.id)}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: command.id,
        device,
        action: command.action,
        params: commandParams,
        timeoutMs: input.timeoutMs,
      }),
    });
    const gatewayBody = (await gatewayResponse.json().catch(() => null)) as
      | {
          status?: string;
          stdout?: string;
          stderr?: string;
          exitCode?: number;
          artifactUri?: string | null;
          startedAt?: string;
          completedAt?: string;
        }
      | null;
    const finalStatus = gatewayResponse.ok
      ? assertDeviceCommandStatus(gatewayBody?.status || "failed")
      : "failed";
    const finalUpdate = await db.pool.query<typeof commandRow>(
      `
        update device_commands
        set status = $2,
            stdout = $3,
            stderr = $4,
            exit_code = $5,
            artifact_uri = $6,
            started_at = coalesce(started_at, $7::timestamptz),
            completed_at = now(),
            updated_at = now()
        where id = $1
        returning id, project_id, task_id, device_id, action, params, status, approval_id,
                  stdout, stderr, exit_code, artifact_uri, started_at, completed_at, created_at, updated_at
      `,
      [
        command.id,
        finalStatus,
        gatewayBody?.stdout ?? "",
        gatewayBody?.stderr ?? (gatewayResponse.ok ? "" : "Device gateway request failed"),
        gatewayBody?.exitCode ?? (gatewayResponse.ok ? 0 : 1),
        gatewayBody?.artifactUri ?? null,
        gatewayBody?.startedAt ? new Date(gatewayBody.startedAt) : new Date(),
      ],
    );
    command = mapDeviceCommand(finalUpdate.rows[0] || commandRow);

    await db.pool.query(
      `
        update devices
        set status = $2, last_seen_at = now(), updated_at = now()
        where id = $1
      `,
      [device.id, command.status === "completed" ? "online" : command.status === "blocked" ? "online" : "error"],
    );

    const verificationStatus: VerificationStatus =
      command.status === "completed" ? "passed" : command.status === "blocked" ? "warning" : "failed";
    const verification = await db.pool.query<{
      id: string;
      project_id: string | null;
      task_id: string | null;
      device_command_id: string | null;
      kind: string;
      status: string;
      confidence: string | number;
      summary: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `
        insert into verification_results (
          project_id,
          task_id,
          device_command_id,
          kind,
          status,
          confidence,
          summary,
          metadata
        )
        values ($1, $2, $3, 'device.command', $4, $5, $6, $7::jsonb)
        returning id, project_id, task_id, device_command_id, kind, status, confidence, summary, metadata, created_at
      `,
      [
        command.projectId,
        command.taskId,
        command.id,
        verificationStatus,
        command.status === "completed" ? 0.95 : 0.7,
        command.status === "completed"
          ? `${command.action} completed on ${device.name}`
          : `${command.action} ${command.status} on ${device.name}`,
        JSON.stringify({ deviceId: device.id, action: command.action, exitCode: command.exitCode }),
      ],
    );
    const verificationRow = verification.rows[0];
    if (!verificationRow) {
      throw new Error("Verification result insert did not return a row");
    }
    const verificationResult = mapVerificationResult(verificationRow);

    await appendEvent(db.pool, redis, {
      projectId: command.projectId,
      taskId: command.taskId,
      type: command.status === "completed" ? "device.command.completed" : "device.command.failed",
      payload: {
        deviceCommandId: command.id,
        deviceId: device.id,
        action: command.action,
        status: command.status,
        verificationResultId: verificationResult.id,
      },
    });
    await appendEvent(db.pool, redis, {
      projectId: command.projectId,
      taskId: command.taskId,
      type: "verification.created",
      payload: {
        verificationResultId: verificationResult.id,
        deviceCommandId: command.id,
        status: verificationResult.status,
      },
    });

    return { command, verificationResult };
  });

  app.get("/api/device-commands/:commandId", async (request, reply) => {
    const params = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      task_id: string | null;
      device_id: string;
      action: string;
      params: unknown;
      status: string;
      approval_id: string | null;
      stdout: string | null;
      stderr: string | null;
      exit_code: number | null;
      artifact_uri: string | null;
      started_at: Date | null;
      completed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, task_id, device_id, action, params, status, approval_id,
               stdout, stderr, exit_code, artifact_uri, started_at, completed_at, created_at, updated_at
        from device_commands
        where id = $1
      `,
      [params.commandId],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Device command not found" });
    }
    return { command: mapDeviceCommand(row) };
  });

  app.get("/api/device-commands/:commandId/logs", async (request, reply) => {
    const params = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const result = await db.pool.query<{ id: string; stdout: string | null; stderr: string | null; artifact_uri: string | null }>(
      `
        select id, stdout, stderr, artifact_uri
        from device_commands
        where id = $1
      `,
      [params.commandId],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Device command not found" });
    }
    return {
      commandId: row.id,
      stdout: row.stdout || "",
      stderr: row.stderr || "",
      artifactUri: row.artifact_uri,
    };
  });

  app.get("/api/capabilities", async () => {
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string;
      platforms: unknown;
      actions: unknown;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, key, name, description, platforms, actions, enabled, created_at, updated_at
        from capability_packages
        order by key asc
      `,
    );
    return { capabilities: result.rows.map(mapCapabilityPackage) };
  });

  app.post("/api/capabilities", async (request, reply) => {
    const input = capabilityInputSchema.parse(request.body);
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string;
      platforms: unknown;
      actions: unknown;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        insert into capability_packages (key, name, description, platforms, actions, enabled)
        values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
        returning id, key, name, description, platforms, actions, enabled, created_at, updated_at
      `,
      [
        input.key,
        input.name,
        input.description,
        JSON.stringify(input.platforms || []),
        JSON.stringify(input.actions || []),
        input.enabled ?? true,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Capability insert did not return a row");
    }
    return reply.code(201).send({ capability: mapCapabilityPackage(row) });
  });

  app.patch("/api/capabilities/:capabilityId", async (request, reply) => {
    const params = z.object({ capabilityId: z.string().uuid() }).parse(request.params);
    const input = capabilityPatchSchema.parse(request.body);
    const result = await db.pool.query<{
      id: string;
      key: string;
      name: string;
      description: string;
      platforms: unknown;
      actions: unknown;
      enabled: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        update capability_packages
        set
          name = coalesce($2, name),
          description = coalesce($3, description),
          platforms = case when $4::boolean then $5::jsonb else platforms end,
          actions = case when $6::boolean then $7::jsonb else actions end,
          enabled = coalesce($8, enabled),
          updated_at = now()
        where id = $1
        returning id, key, name, description, platforms, actions, enabled, created_at, updated_at
      `,
      [
        params.capabilityId,
        input.name ?? null,
        input.description ?? null,
        input.platforms !== undefined,
        JSON.stringify(input.platforms || []),
        input.actions !== undefined,
        JSON.stringify(input.actions || []),
        input.enabled ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Capability not found" });
    }
    return { capability: mapCapabilityPackage(row) };
  });

  app.get("/api/tasks", async (request) => {
    const principal = principalForRequest(request);
    const query = z
      .object({
        projectId: z.string().uuid().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);

    const values: string[] = [principal.accountId, principal.workspaceId];
    const clauses: string[] = ["account_id = $1", "workspace_id = $2"];

    if (query.projectId) {
      values.push(query.projectId);
      clauses.push(`project_id = $${values.length}`);
    }

    if (query.status) {
      const status: TaskStatus = assertTaskStatus(query.status);
      values.push(status);
      clauses.push(`status = $${values.length}`);
    }

    const result = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, title, instructions, status, created_at, updated_at
        from tasks
        ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
        order by created_at desc
        limit 100
      `,
      values,
    );

    return { tasks: result.rows.map(mapTask) };
  });

  app.post("/api/tasks", async (request, reply) => {
    const principal = principalForRequest(request);
    const input = taskInputSchema.parse(request.body);
    const project = await db.pool.query<{ workspace_id: string }>(
      `
        select p.workspace_id
        from projects p
        join project_members pm on pm.project_id = p.id and pm.user_id = $2
        where p.id = $1 and p.workspace_id = $3
      `,
      [input.projectId, principal.accountId, principal.workspaceId],
    );
    if ((project.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const client = await db.pool.connect();
    let row!: {
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    };
    try {
      await client.query("begin");
      const taskResult = await client.query<typeof row>(
        `
          insert into tasks (account_id, workspace_id, project_id, title, instructions, status, created_by)
          values ($1, $2, $3, $4, $5, 'created', $1)
          returning id, project_id, title, instructions, status, created_at, updated_at
        `,
        [principal.accountId, project.rows[0]!.workspace_id, input.projectId, input.title, input.instructions],
      );
      const insertedTask = taskResult.rows[0];
      if (!insertedTask) throw new Error("Task insert did not return a row");
      row = insertedTask;
      const messageResult = await client.query<{ id: string }>(
        `
          insert into chat_messages (project_id, task_id, role, source, content, metadata)
          values ($1, $2, 'user', 'master', $3, $4::jsonb)
          returning id
        `,
        [row.project_id, row.id, input.instructions, JSON.stringify({ title: row.title, initial: true })],
      );
      const messageId = messageResult.rows[0]?.id;
      if (!messageId) throw new Error("Initial chat message insert did not return a row");
      const turnId = await insertTaskTurn(client, {
        accountId: principal.accountId,
        workspaceId: project.rows[0]!.workspace_id,
        runtimeCellId: principal.runtimeCellId,
        projectId: row.project_id,
        taskId: row.id,
        userMessageId: messageId,
      });
      await appendEvent(client, redis, { projectId: row.project_id, taskId: row.id, type: "task.created", payload: { title: row.title, status: row.status } });
      await appendEvent(client, redis, { projectId: row.project_id, taskId: row.id, type: "chat.message.created", payload: { role: "user", messageId } });
      await appendEvent(client, redis, { projectId: row.project_id, taskId: row.id, type: "task.turn.requested", payload: { turnId, messageId } });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return reply.code(201).send({ task: mapTask(row) });
  });

  app.patch("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const input = taskPatchSchema.parse(request.body);
    const status = input.status ? assertTaskStatus(input.status) : undefined;
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        update tasks
        set
          title = coalesce($2, title),
          instructions = coalesce($3, instructions),
          status = coalesce($4::task_status, status),
          updated_at = now()
        where id = $1
        returning id, project_id, title, instructions, status, created_at, updated_at
      `,
      [params.taskId, input.title ?? null, input.instructions ?? null, status ?? null],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Task not found" });
    }

    await appendEvent(db.pool, redis, {
      projectId: row.project_id,
      taskId: row.id,
      type: "task.updated",
      payload: {
        title: row.title,
        status: row.status,
      },
    });

    return { task: mapTask(row) };
  });

  app.delete("/api/tasks/:taskId", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const result = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      status: string;
    }>(
      `
        delete from tasks
        where id = $1
        returning id, project_id, title, status
      `,
      [params.taskId],
    );

    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send({ error: "Task not found" });
    }

    await appendEvent(db.pool, redis, {
      projectId: row.project_id,
      taskId: null,
      type: "task.deleted",
      payload: {
        taskId: row.id,
        title: row.title,
        status: row.status,
      },
    });

    return { task: row, deleted: true };
  });

  app.get("/api/tasks/:taskId/plan", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const taskResult = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
    }>(
      `
        select id, project_id, title, instructions
        from tasks
        where id = $1
      `,
      [params.taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const planResult = await db.pool.query<{
      id: string;
      task_id: string;
      selected_capabilities: unknown;
      steps: unknown;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, task_id, selected_capabilities, steps, status, created_at, updated_at
        from task_plans
        where task_id = $1
      `,
      [task.id],
    );
    const taskPlan = planResult.rows[0] ? mapTaskPlan(planResult.rows[0]) : null;
    return { taskPlan };
  });

  app.get("/api/tasks/:taskId/verification-results", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const task = await db.pool.query<{ id: string }>("select id from tasks where id = $1", [params.taskId]);
    if ((task.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "Task not found" });
    }
    const result = await db.pool.query<{
      id: string;
      project_id: string | null;
      task_id: string | null;
      device_command_id: string | null;
      kind: string;
      status: string;
      confidence: string | number;
      summary: string;
      metadata: unknown;
      created_at: Date;
    }>(
      `
        select id, project_id, task_id, device_command_id, kind, status, confidence, summary, metadata, created_at
        from verification_results
        where task_id = $1
        order by created_at desc
      `,
      [params.taskId],
    );
    return { verificationResults: result.rows.map(mapVerificationResult) };
  });

  app.get("/api/runtime/hermes", async (request, reply) => {
    const response = await fetch(`${config.hermesManagerUrl}/capabilities`);
    const body = (await response.json()) as HermesCapabilitySummary;
    if (!response.ok) {
      return reply.code(response.status).send(body);
    }

    return body;
  });

  app.all("/api/hermes/*", async (request, reply) => {
    const targetPath = hermesProxyPath(request.url);
    const principal = principalForRequest(request);
    const readOnlyCellSafePaths = new Set([
      "/v1/models",
      "/v1/skills",
      "/v1/toolsets",
      "/health/detailed",
      "/upstream/diagnostics",
    ]);
    const targetPathname = targetPath.split("?")[0] || "/";
    if (
      principal.accountId !== config.oauthAdminAccountId
      && (request.method !== "GET" || !readOnlyCellSafePaths.has(targetPathname))
    ) {
      return reply.code(403).send({
        error: "Global Hermes operator state is restricted to the shared OAuth administrator",
      });
    }
    const response = await fetch(
      `${config.hermesManagerUrl}${targetPath}`,
      proxyRequestInit(request.method, request.body, request.headers),
    );
    const contentType = response.headers.get("content-type") || "";
    const sessionKey = response.headers.get("x-hermes-session-key");
    const sessionId = response.headers.get("x-hermes-session-id");

    if (contentType.includes("text/event-stream")) {
      reply.hijack();
      reply.raw.writeHead(response.status, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "referrer-policy": response.headers.get("referrer-policy") || "no-referrer",
        "x-accel-buffering": "no",
        "x-content-type-options": response.headers.get("x-content-type-options") || "nosniff",
        ...(sessionId ? { "x-hermes-session-id": sessionId } : {}),
        ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
      });
      if (!response.body) {
        reply.raw.end();
        return;
      }
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        reply.raw.write(Buffer.from(chunk));
      }
      reply.raw.end();
      return;
    }

    const text = await response.text();
    reply.code(response.status).header("content-type", contentType || "application/json");
    for (const name of ["referrer-policy", "x-content-type-options", "x-hermes-session-id", "x-hermes-session-key"]) {
      const value = response.headers.get(name);
      if (value) {
        reply.header(name, value);
      }
    }
    return text ? JSON.parse(text) : {};
  });

  app.get("/api/tasks/:taskId/runtime", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);

    const taskResult = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, title, instructions, status, created_at, updated_at
        from tasks
        where id = $1
      `,
      [params.taskId],
    );

    const taskRow = taskResult.rows[0];
    if (!taskRow) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const [
      messagesResult,
      turnsResult,
      sessionsResult,
      runsResult,
      checkpointsResult,
      artifactsResult,
      eventsResult,
      planResult,
      verificationResult,
    ] =
      await Promise.all([
        db.pool.query<{
          id: string;
          project_id: string;
          task_id: string;
          role: ChatMessageRole;
          source: string;
          content: string;
          metadata: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, role, source, content, metadata, created_at
            from chat_messages
            where task_id = $1
            order by created_at asc
            limit 500
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          user_message_id: string;
          status: "requested" | "routing" | "routed" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
          failure_code: string | null;
          created_at: Date;
          completed_at: Date | null;
          decision: Record<string, unknown> | null;
        }>(
          `
            select tt.id, tt.task_id, tt.user_message_id, tt.status, tt.failure_code,
                   tt.created_at, tt.completed_at,
                   case when rd.id is null then null else jsonb_build_object(
                     'intent', rd.intent,
                     'route', rd.route,
                     'primaryDomain', rd.primary_domain,
                     'secondaryDomains', rd.secondary_domains,
                     'riskSignals', rd.risk_signals,
                     'evidenceRequirement', rd.evidence_requirement,
                     'contextRequirement', rd.context_requirement,
                     'reasonCodes', rd.reason_codes,
                     'source', rd.source,
                     'routingDurationMs', rd.routing_duration_ms,
                     'semanticFrame', rd.semantic_frame
                   ) end as decision
            from task_turns tt
            left join route_decisions rd on rd.turn_id = tt.id
            where tt.task_id = $1
            order by tt.created_at asc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          runtime_profile_id: string | null;
          hermes_session_id: string | null;
          hermes_live_session_id: string | null;
          hermes_run_id: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, runtime_profile_id, hermes_session_id, hermes_live_session_id,
                   hermes_run_id, created_at, updated_at
            from runtime_sessions
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          soul_id: string | null;
          runtime_session_id: string | null;
          status: AgentRunSummary["status"];
          branch_name: string | null;
          worktree_path: string | null;
          started_at: Date | null;
          completed_at: Date | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, soul_id, runtime_session_id, status, branch_name, worktree_path,
                   started_at, completed_at, created_at, updated_at
            from agent_runs
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          agent_run_id: string | null;
          summary: string;
          git_commit_sha: string | null;
          snapshot_uri: string | null;
          checksum: string | null;
          changed_files: unknown;
          test_result: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, task_id, agent_run_id, summary, git_commit_sha, snapshot_uri,
                   checksum, changed_files, test_result, created_at
            from checkpoints
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          project_id: string | null;
          task_id: string | null;
          kind: string;
          uri: string;
          checksum: string | null;
          metadata: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, kind, uri, checksum, metadata, created_at
            from artifacts
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          project_id: string | null;
          task_id: string | null;
          type: EventType;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, type, payload, created_at
            from events
            where task_id = $1
            order by created_at desc
            limit 100
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          task_id: string;
          selected_capabilities: unknown;
          steps: unknown;
          status: string;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, selected_capabilities, steps, status, created_at, updated_at
            from task_plans
            where task_id = $1
          `,
          [params.taskId],
        ),
        db.pool.query<{
          id: string;
          project_id: string | null;
          task_id: string | null;
          device_command_id: string | null;
          kind: string;
          status: string;
          confidence: string | number;
          summary: string;
          metadata: unknown;
          created_at: Date;
        }>(
          `
            select id, project_id, task_id, device_command_id, kind, status, confidence, summary, metadata, created_at
            from verification_results
            where task_id = $1
            order by created_at desc
          `,
          [params.taskId],
        ),
      ]);

    const taskPlan = planResult.rows[0] ? mapTaskPlan(planResult.rows[0]) : null;
    const orchestrationResult = await db.pool.query<{
      id: string;
      domain: TaskRuntimeSummary["orchestration"] extends { domain: infer T } ? T : string;
      secondary_domains: unknown;
      weight: TaskRuntimeSummary["orchestration"] extends { weight: infer T } ? T : string;
      risk_signals: unknown;
      collaboration: TaskRuntimeSummary["orchestration"] extends { collaboration: infer T } ? T : string;
      require_evidence: boolean;
      require_independent_review: boolean;
      status: TaskRuntimeSummary["orchestration"] extends { status: infer T } ? T : string;
      specialists: unknown;
    }>(
      `
        select
          b.id,
          b.domain,
          b.secondary_domains,
          b.weight,
          b.risk_signals,
          b.collaboration,
          b.require_evidence,
          b.require_independent_review,
          b.status,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', s.id,
                'key', s.assignment_key,
                'role', s.role_name,
                'mission', s.mission,
                'toolsets', s.toolsets,
                'required', s.required,
                'status', s.status,
                'hermesSubagentId', s.hermes_subagent_id,
                'resultSummary', s.result_summary
              ) order by s.created_at asc
            ) filter (where s.id is not null),
            '[]'::jsonb
          ) as specialists
        from orchestration_blueprints b
        left join specialist_assignments s on s.blueprint_id = b.id
        where b.id = (
          select id
          from orchestration_blueprints
          where task_id = $1
          order by created_at desc
          limit 1
        )
        group by b.id
      `,
      [params.taskId],
    );
    const orchestrationRow = orchestrationResult.rows[0];
    const orchestration = orchestrationRow
      ? {
          id: orchestrationRow.id,
          domain: orchestrationRow.domain,
          secondaryDomains: Array.isArray(orchestrationRow.secondary_domains)
            ? orchestrationRow.secondary_domains.filter((value): value is string => typeof value === "string")
            : [],
          weight: orchestrationRow.weight,
          riskSignals: Array.isArray(orchestrationRow.risk_signals)
            ? orchestrationRow.risk_signals.filter((value): value is string => typeof value === "string")
            : [],
          collaboration: orchestrationRow.collaboration,
          requireEvidence: orchestrationRow.require_evidence,
          requireIndependentReview: orchestrationRow.require_independent_review,
          status: orchestrationRow.status,
          specialists: Array.isArray(orchestrationRow.specialists) ? orchestrationRow.specialists : [],
        } as NonNullable<TaskRuntimeSummary["orchestration"]>
      : null;
    const projectionResult = await db.pool.query<{
      state: Omit<NonNullable<TaskRuntimeSummary["hermesProjection"]>, "updatedAt">;
      updated_at: Date;
    }>(
      `
        select state, updated_at
        from hermes_session_projections
        where task_id = $1
        order by updated_at desc
        limit 1
      `,
      [params.taskId],
    );
    const projectionRow = projectionResult.rows[0];
    const hermesProjection = projectionRow
      ? { ...projectionRow.state, updatedAt: projectionRow.updated_at.toISOString() }
      : null;
    const runtime: TaskRuntimeSummary = {
      task: mapTask(taskRow),
      messages: messagesResult.rows.map(mapChatMessage),
      turns: turnsResult.rows.map((turn) => ({
        id: turn.id,
        taskId: turn.task_id,
        userMessageId: turn.user_message_id,
        status: turn.status,
        failureCode: turn.failure_code,
        createdAt: turn.created_at.toISOString(),
        completedAt: turn.completed_at?.toISOString() ?? null,
        decision: turn.decision as TaskRuntimeSummary["turns"] extends Array<infer T>
          ? T extends { decision: infer D } ? D : never
          : never,
      })),
      sessions: sessionsResult.rows.map(mapSession),
      runs: runsResult.rows.map(mapRun),
      checkpoints: checkpointsResult.rows.map(mapCheckpoint),
      artifacts: artifactsResult.rows.map(mapArtifact),
      events: eventsResult.rows.map(mapEvent),
      taskPlan,
      verificationResults: verificationResult.rows.map(mapVerificationResult),
      orchestration,
      hermesProjection,
    };

    return runtime;
  });

  app.get("/api/tasks/:taskId/messages", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const task = await db.pool.query<{ id: string }>("select id from tasks where id = $1", [params.taskId]);
    if ((task.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const result = await db.pool.query<{
      id: string;
      project_id: string;
      task_id: string;
      role: ChatMessageRole;
      source: string;
      content: string;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>(
      `
        select id, project_id, task_id, role, source, content, metadata, created_at
        from chat_messages
        where task_id = $1
        order by created_at asc
        limit 500
      `,
      [params.taskId],
    );

    return { messages: result.rows.map(mapChatMessage) };
  });

  app.post("/api/tasks/:taskId/messages", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const input = chatMessageInputSchema.parse(request.body);
    const taskResult = await db.pool.query<{
      id: string;
      project_id: string;
      title: string;
      instructions: string;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `
        select id, project_id, title, instructions, status, created_at, updated_at
        from tasks
        where id = $1
      `,
      [params.taskId],
    );

    const task = taskResult.rows[0];
    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }

    const client = await db.pool.connect();
    let userMessage: ChatMessageSummary;
    try {
      await client.query("begin");
      const claimed = await client.query(
        `
          update tasks
          set instructions = $2, status = 'created', updated_at = now()
          where id = $1 and status not in ('running', 'reviewing')
          returning id
        `,
        [task.id, input.content],
      );
      if ((claimed.rowCount ?? 0) === 0) {
        await client.query("rollback");
        return reply.code(409).send({
          error: "task_turn_in_progress",
          message: "The current specialist collaboration must finish before another message is submitted.",
        });
      }
      const messageResult = await client.query<{
        id: string;
        project_id: string;
        task_id: string;
        role: ChatMessageRole;
        source: string;
        content: string;
        metadata: Record<string, unknown>;
        created_at: Date;
      }>(
        `
          insert into chat_messages (project_id, task_id, role, source, content)
          values ($1, $2, 'user', 'master', $3)
          returning id, project_id, task_id, role, source, content, metadata, created_at
        `,
        [task.project_id, task.id, input.content],
      );
      const messageRow = messageResult.rows[0];
      if (!messageRow) throw new Error("Follow-up message insert did not return a row");
      userMessage = mapChatMessage(messageRow);
      const principal = principalForRequest(request);
      const turnId = await insertTaskTurn(client, {
        accountId: principal.accountId,
        workspaceId: principal.workspaceId,
        runtimeCellId: principal.runtimeCellId,
        projectId: task.project_id,
        taskId: task.id,
        userMessageId: messageRow.id,
      });
      await client.query("delete from task_plans where task_id = $1", [task.id]);
      await client.query("delete from orchestration_blueprints where task_id = $1", [task.id]);
      await appendEvent(client, redis, {
        projectId: task.project_id,
        taskId: task.id,
        type: "task.turn.requested",
        payload: { turnId, messageId: messageRow.id },
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await appendEvent(db.pool, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "chat.message.created",
      payload: {
        role: "user",
        messageId: userMessage.id,
      },
    });

    await appendEvent(db.pool, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "task.updated",
      payload: { title: task.title, status: "created", reason: "followup_turn" },
    });

    return reply.code(202).send({ messages: [userMessage] });
  });

  app.post("/api/tasks/:taskId/hermes-interactions/respond", async (request, reply) => {
    const params = z.object({ taskId: z.string().uuid() }).parse(request.params);
    const input = hermesInteractionResponseSchema.parse(request.body);
    const runtimeResult = await db.pool.query<{
      project_id: string;
      account_id: string;
      workspace_id: string;
      runtime_cell_id: string;
      agent_run_id: string | null;
      hermes_live_session_id: string | null;
    }>(
      `
        select t.project_id, t.account_id, t.workspace_id, rs.runtime_cell_id,
               ar.id as agent_run_id, rs.hermes_live_session_id
        from tasks t
        left join lateral (
          select id, hermes_live_session_id
          from runtime_sessions
          where task_id = t.id
          order by created_at desc
          limit 1
        ) rs on true
        left join lateral (
          select id
          from agent_runs
          where task_id = t.id
          order by created_at desc
          limit 1
        ) ar on true
        where t.id = $1
      `,
      [params.taskId],
    );
    const runtime = runtimeResult.rows[0];
    if (!runtime) return reply.code(404).send({ error: "Task not found" });
    if (!runtime.hermes_live_session_id) {
      return reply.code(409).send({ error: "Hermes live session is not available" });
    }
    const controlScope = {
      accountId: runtime.account_id,
      workspaceId: runtime.workspace_id,
      runtimeCellId: runtime.runtime_cell_id,
    };

    if (input.type === "approval") {
      const result = await requestHermesControl<{ resolved?: number | boolean }>(config, controlScope, "approval.respond", {
        choice: input.choice,
        session_id: runtime.hermes_live_session_id,
      });
      const resolved = typeof result.resolved === "number"
        ? result.resolved
        : result.resolved === true
          ? 1
          : 0;
      if (resolved < 1) {
        return reply.code(409).send({ error: "Hermes approval request is no longer pending" });
      }

      const decision = input.choice === "deny" ? "rejected" : "approved";
      const eventType = input.choice === "deny" ? "approval.rejected" : "approval.approved";
      const client = await db.pool.connect();
      try {
        await client.query("begin");
        const approvalResult = await client.query<{ id: string }>(
          `
            update approvals
            set status = $2, decided_at = now()
            where id = (
              select id
              from approvals
              where task_id = $1 and status = 'requested'
              order by created_at desc
              for update skip locked
              limit 1
            )
            returning id
          `,
          [params.taskId, decision],
        );
        await client.query("update tasks set status = 'running', updated_at = now() where id = $1", [params.taskId]);
        if (runtime.agent_run_id) {
          await client.query(
            "update agent_runs set status = 'running', updated_at = now() where id = $1",
            [runtime.agent_run_id],
          );
        }
        await appendEvent(client, redis, {
          projectId: runtime.project_id,
          taskId: params.taskId,
          type: eventType,
          payload: {
            approvalId: approvalResult.rows[0]?.id ?? null,
            choice: input.choice,
          },
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return { status: "ok", resolved };
    }

    if (input.type === "clarify") {
      await requestHermesControl(config, controlScope, "clarify.respond", {
        request_id: input.requestId,
        answer: input.answer,
      });
    } else if (input.type === "sudo") {
      await requestHermesControl(config, controlScope, "sudo.respond", {
        request_id: input.requestId,
        password: input.password,
      });
    } else {
      await requestHermesControl(config, controlScope, "secret.respond", {
        request_id: input.requestId,
        value: input.value,
      });
    }

    return { status: "ok" };
  });

  app.get("/events/stream", async (request, reply) => {
    const principal = principalForRequest(request);
    const subscriber = new Redis(config.redisUrl);
    await subscriber.subscribe(EVENT_CHANNEL);

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });
    let heartbeat: NodeJS.Timeout | null = null;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) clearInterval(heartbeat);
      subscriber.disconnect();
    };
    reply.raw.on("close", cleanup);

    type SseEvent = {
      id: string;
      accountId: string;
      workspaceId: string;
      projectId: string | null;
      taskId: string | null;
      type: string;
      payload: Record<string, unknown>;
      createdAt: string;
    };
    type EventRow = {
      id: string;
      account_id: string;
      workspace_id: string;
      project_id: string | null;
      task_id: string | null;
      type: EventType;
      payload: Record<string, unknown>;
      created_at: Date;
    };
    const bufferedLiveEvents: SseEvent[] = [];
    const replayedIds = new Set<string>();
    let replaying = true;
    const writeEvent = (event: SseEvent) => {
      if (replayedIds.has(event.id)) return;
      replayedIds.add(event.id);
      reply.raw.write(encodeSse(event.type, event, event.id));
    };
    subscriber.on("message", (_channel, message) => {
      let parsed: SseEvent;
      try {
        parsed = JSON.parse(message) as SseEvent;
      } catch (error) {
        app.log.error({ err: error }, "Invalid event envelope received from Redis");
        return;
      }
      if (!parsed.id || !parsed.type) {
        app.log.error({ message }, "Incomplete event envelope received from Redis");
        return;
      }
      if (
        parsed.accountId !== principal.accountId
        || parsed.workspaceId !== principal.workspaceId
      ) {
        return;
      }
      if (replaying) {
        if (bufferedLiveEvents.length >= 10_000) {
          app.log.error("SSE live-event replay buffer saturated");
          reply.raw.destroy(new Error("SSE replay buffer saturated"));
          return;
        }
        bufferedLiveEvents.push(parsed);
      } else {
        writeEvent(parsed);
      }
    });

    let replayRows: EventRow[];
    try {
      const rawLastEventId = request.headers["last-event-id"];
      const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
      if (lastEventId) {
        const cursor = await db.pool.query<{ id: string; created_at: Date }>(
          `
            select id, created_at
            from events
            where id::text = $1 and account_id = $2 and workspace_id = $3
          `,
          [lastEventId, principal.accountId, principal.workspaceId],
        );
        if (cursor.rows[0]) {
          const replay = await db.pool.query<EventRow>(
            `
              select id, account_id, workspace_id, project_id, task_id, type, payload, created_at
              from events
              where account_id = $3
                and workspace_id = $4
                and (created_at, id) > ($1, $2::uuid)
              order by created_at asc, id asc
            `,
            [cursor.rows[0].created_at, cursor.rows[0].id, principal.accountId, principal.workspaceId],
          );
          replayRows = replay.rows;
        } else {
          replayRows = [];
        }
      } else {
        const recent = await db.pool.query<EventRow>(
          `
            select id, account_id, workspace_id, project_id, task_id, type, payload, created_at
            from events
            where account_id = $1 and workspace_id = $2
            order by created_at desc, id desc
            limit 50
          `,
          [principal.accountId, principal.workspaceId],
        );
        replayRows = recent.rows.reverse();
      }
    } catch (error) {
      app.log.error({ err: error }, "SSE event replay failed");
      cleanup();
      reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    for (const row of replayRows) {
      writeEvent({
        id: row.id,
        accountId: row.account_id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        taskId: row.task_id,
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at.toISOString(),
      });
    }
    replaying = false;
    for (const event of bufferedLiveEvents.splice(0)) writeEvent(event);

    heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

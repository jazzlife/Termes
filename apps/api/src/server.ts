import cors from "@fastify/cors";
import type {
  AgentRunSummary,
  ArtifactSummary,
  ChatMessageRole,
  ChatMessageSummary,
  CheckpointSummary,
  EventType,
  HermesCapabilitySummary,
  PlatformEvent,
  ProjectSummary,
  RuntimeSessionSummary,
  TaskRuntimeSummary,
  TaskStatus,
  TaskSummary,
} from "@termes/shared";
import { TERMES_VERSION, assertTaskStatus } from "@termes/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import Fastify from "fastify";
import Redis from "ioredis";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { loadConfig } from "./config";
import { assertDbReady, createDb, type Db } from "./db";
import { EVENT_CHANNEL, appendEvent } from "./events";

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

const workspaceRootPath = path.resolve(process.env.WORKSPACE_ROOT || "/data/docker_data/termes/workspaces");
const workspaceProjectsRootPath = path.join(workspaceRootPath, "projects");
const githubSecretsRootPath = path.resolve(process.env.GITHUB_SECRETS_ROOT || "/data/docker_data/termes/secrets");
const githubConnectionFilePath = path.join(githubSecretsRootPath, "github-connection.json");
const execFileAsync = promisify(execFile);

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

function resolveProjectWorkspacePath(projectKey: string, requestedPath?: string): string {
  const rawPath = requestedPath?.trim();
  const candidate = rawPath
    ? path.resolve(path.isAbsolute(rawPath) ? rawPath : path.join(workspaceRootPath, rawPath))
    : path.resolve(workspaceRootPath, "projects", projectKey);

  if (candidate !== workspaceRootPath && !candidate.startsWith(`${workspaceRootPath}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${workspaceRootPath}`);
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

function resolveProjectSandboxPath(relativePath: string): string {
  const normalized = normalizeRelativeWorkspacePath(relativePath);
  const candidate = path.resolve(workspaceProjectsRootPath, normalized);
  if (candidate !== workspaceProjectsRootPath && !candidate.startsWith(`${workspaceProjectsRootPath}${path.sep}`)) {
    throw new Error(`Workspace path must be under ${workspaceProjectsRootPath}`);
  }
  return candidate;
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

function githubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim());
}

async function readGithubConnection(): Promise<GitHubConnectionRecord | null> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
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
    const raw = JSON.parse(await readFile(githubConnectionFilePath, "utf8")) as Partial<GitHubConnectionRecord>;
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

async function writeGithubConnection(record: GitHubConnectionRecord): Promise<void> {
  await mkdir(githubSecretsRootPath, { recursive: true });
  await writeFile(githubConnectionFilePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(githubConnectionFilePath, 0o600);
}

async function clearGithubConnection(): Promise<"cleared" | "env-token"> {
  if (process.env.GITHUB_TOKEN?.trim()) {
    return "env-token";
  }
  await rm(githubConnectionFilePath, { force: true });
  return "cleared";
}

function githubConnectionSummary(record: GitHubConnectionRecord | null) {
  return {
    connected: Boolean(record),
    login: record?.login ?? null,
    avatarUrl: record?.avatarUrl ?? null,
    profileUrl: record?.profileUrl ?? null,
    linkedAt: record?.linkedAt ?? null,
    oauthConfigured: githubOAuthConfigured(),
  };
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

async function uniqueProjectKey(db: Db, baseKey: string): Promise<string> {
  const base = slugifyProjectKey(baseKey);
  for (let index = 0; index < 20; index += 1) {
    const candidate = index === 0 ? base : `${base.slice(0, Math.max(2, 36 - String(index).length - 1))}-${index}`;
    const result = await db.pool.query<{ exists: boolean }>("select exists(select 1 from projects where key = $1) as exists", [
      candidate,
    ]);
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
  hermes_run_id: string | null;
  created_at: Date;
  updated_at: Date;
}): RuntimeSessionSummary {
  return {
    id: row.id,
    taskId: row.task_id,
    runtimeProfileId: row.runtime_profile_id,
    hermesSessionId: row.hermes_session_id,
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

function extractHermesAssistantText(value: unknown): string {
  const direct = firstText(value, ["output", "content", "text"]);
  if (direct) {
    return direct;
  }

  if (value && typeof value === "object") {
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

async function ensureHermesSession(
  db: Db,
  config: ReturnType<typeof loadConfig>,
  task: { id: string; project_id: string; title: string },
): Promise<string> {
  const existing = await db.pool.query<{ hermes_session_id: string | null }>(
    `
      select hermes_session_id
      from runtime_sessions
      where task_id = $1 and hermes_session_id is not null
      order by created_at desc
      limit 1
    `,
    [task.id],
  );
  const existingId = existing.rows[0]?.hermes_session_id;
  if (existingId) {
    return existingId;
  }

  const response = await fetch(`${config.hermesManagerUrl}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: `${task.title} · ${task.id.slice(0, 8)}`,
      source: "termes-chat",
      metadata: {
        projectId: task.project_id,
        taskId: task.id,
      },
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Hermes session create failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const sessionId =
    (typeof body.id === "string" && body.id) ||
    (typeof body.session_id === "string" && body.session_id) ||
    (body.session &&
    typeof body.session === "object" &&
    typeof (body.session as Record<string, unknown>).id === "string"
      ? ((body.session as Record<string, unknown>).id as string)
      : "");
  if (!sessionId) {
    throw new Error(`Hermes session create did not return an id: ${JSON.stringify(body)}`);
  }

  await db.pool.query(
    `
      insert into runtime_sessions (task_id, hermes_session_id)
      values ($1, $2)
    `,
    [task.id, sessionId],
  );

  return sessionId;
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

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  await redis.connect();

  const app = Fastify({
    logger: true,
    requestTimeout: 30_000,
  });

  await app.register(cors, {
    origin: true,
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
    await db.close();
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

  app.get("/api/github/status", async () => {
    return { github: githubConnectionSummary(await readGithubConnection()) };
  });

  for (const oauthStartPath of ["/api/github/oauth/start", "/api/github/oauth/login"]) {
    app.get(oauthStartPath, async (request, reply) => {
      if (!githubOAuthConfigured()) {
        return reply.code(503).send({ error: "GitHub OAuth is not configured" });
      }

      const query = z.object({ returnTo: z.string().optional() }).parse(request.query);
      const state = randomBytes(24).toString("hex");
      await redis.set(
        `github.oauth.state.${state}`,
        JSON.stringify({ returnTo: safeReturnTo(query.returnTo) }),
        "EX",
        600,
      );

      const oauthUrl = new URL("https://github.com/login/oauth/authorize");
      oauthUrl.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID?.trim() || "");
      oauthUrl.searchParams.set("redirect_uri", `${buildExternalBaseUrl(request)}/api/github/oauth/callback`);
      oauthUrl.searchParams.set("state", state);
      oauthUrl.searchParams.set("scope", "repo read:org");

      return reply.header("location", oauthUrl.toString()).code(302).send();
    });
  }

  app.get("/api/github/oauth/callback", async (request, reply) => {
    if (!githubOAuthConfigured()) {
      return reply.code(503).send({ error: "GitHub OAuth is not configured" });
    }

    const query = z.object({ code: z.string().optional(), state: z.string().optional() }).parse(request.query);
    const stateKey = query.state ? `github.oauth.state.${query.state}` : "";
    const rawState = stateKey ? await redis.get(stateKey) : null;
    if (stateKey) {
      await redis.del(stateKey);
    }

    const returnTo = safeReturnTo(rawState ? (JSON.parse(rawState) as { returnTo?: string }).returnTo : "/");
    const redirectUrl = new URL(returnTo, buildExternalBaseUrl(request));

    try {
      if (!query.code || !rawState) {
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
          client_secret: process.env.GITHUB_CLIENT_SECRET?.trim() || "",
          code: query.code,
          redirect_uri: `${buildExternalBaseUrl(request)}/api/github/oauth/callback`,
        }),
      });
      const tokenPayload = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
      if (!tokenResponse.ok || !tokenPayload.access_token) {
        throw new Error(tokenPayload.error_description || tokenPayload.error || "GitHub OAuth token exchange failed");
      }

      const user = await githubApi<GitHubApiUser>("/user", tokenPayload.access_token);
      await writeGithubConnection({
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

  app.post("/api/github/oauth/logout", async (_request, reply) => {
    const result = await clearGithubConnection();
    if (result === "env-token") {
      return reply.code(409).send({ error: "GitHub is connected by GITHUB_TOKEN; remove the server environment variable to disconnect." });
    }
    return { github: githubConnectionSummary(await readGithubConnection()) };
  });

  app.get("/api/github/repositories", async (request, reply) => {
    const connection = await readGithubConnection();
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

  app.get("/api/projects", async () => {
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
        left join lateral (
          select host_path
          from workspace_roots
          where project_id = p.id
          order by created_at asc
          limit 1
        ) wr on true
        order by p.created_at asc
      `,
    );

    return { projects: result.rows.map(mapProject) };
  });

  app.post("/api/projects", async (request, reply) => {
    const input = projectInputSchema.parse(request.body);

    let workspacePath: string;
    try {
      workspacePath = resolveProjectWorkspacePath(input.key, input.workspacePath);
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
          insert into projects (key, name, description)
          values ($1, $2, $3)
          returning id, key, name, description, $4::text as workspace_path, created_at, updated_at
        `,
        [input.key, input.name, input.description ?? null, workspacePath],
      );

      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }

      await mkdir(workspacePath, { recursive: true });
      await client.query(
        `
          insert into workspace_roots (project_id, host_path)
          values ($1, $2)
        `,
        [row.id, workspacePath],
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
    const input = projectFolderCreateInputSchema.parse(request.body);
    const parentPath = normalizeRelativeWorkspacePath(input.parentPath);
    const folderName = normalizeRelativeWorkspacePath(input.name);
    if (!folderName) {
      return reply.code(400).send({ error: "Folder name is required" });
    }

    const folderRelativePath = normalizeRelativeWorkspacePath(path.posix.join(parentPath, folderName));
    const folderAbsolutePath = resolveProjectSandboxPath(folderRelativePath);
    await mkdir(folderAbsolutePath, { recursive: true });

    return reply.code(201).send({
      workspaceId: "termes",
      name: folderRelativePath.split("/").filter(Boolean).at(-1) || folderRelativePath,
      path: folderRelativePath,
      absolutePath: folderAbsolutePath,
    });
  });

  app.post("/api/projects/folder", async (request, reply) => {
    const input = projectFolderRegisterInputSchema.parse(request.body);
    const folderRelativePath = normalizeRelativeWorkspacePath(input.path);
    const folderAbsolutePath = resolveProjectSandboxPath(folderRelativePath);
    const folderStat = await stat(folderAbsolutePath).catch(() => null);
    if (!folderStat?.isDirectory()) {
      return reply.code(400).send({ error: "Project folder does not exist under the workspace projects root" });
    }

    const projectName = input.name?.trim() || folderRelativePath.split("/").filter(Boolean).at(-1) || "Project";
    const key = await uniqueProjectKey(db, projectName);
    const client = await db.pool.connect();
    let row: ProjectRow | undefined;
    try {
      await client.query("begin");
      const result = await client.query<ProjectRow>(
        `
          insert into projects (key, name, description)
          values ($1, $2, $3)
          returning id, key, name, description, $4::text as workspace_path, created_at, updated_at
        `,
        [key, projectName, `Folder project: ${folderRelativePath}`, folderAbsolutePath],
      );
      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }
      await client.query(
        `
          insert into workspace_roots (project_id, host_path)
          values ($1, $2)
        `,
        [row.id, folderAbsolutePath],
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
      workspaceId: "termes",
      project,
      path: folderRelativePath,
      workspacePath: folderAbsolutePath,
    });
  });

  async function handleGitHubProjectClone(request: FastifyRequest, reply: FastifyReply) {
    const input = githubCloneInputSchema.parse(request.body);
    const connection = await readGithubConnection();
    if (!connection) {
      return reply.code(401).send({ error: "GitHub login is required" });
    }

    const repositoryName = input.repositoryFullName.split("/")[1];
    if (!repositoryName) {
      return reply.code(400).send({ error: "GitHub repository name is invalid" });
    }
    const targetRelativePath = normalizeRelativeWorkspacePath(path.posix.join(input.parentPath || "", repositoryName));
    const targetAbsolutePath = resolveProjectSandboxPath(targetRelativePath);

    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    try {
      await cloneGithubRepository({
        repositoryFullName: input.repositoryFullName,
        targetAbsolutePath,
        token: connection.accessToken,
      });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message.replace(connection.accessToken, "[REDACTED]") : "GitHub clone failed",
      });
    }

    const key = await uniqueProjectKey(db, repositoryName);
    const client = await db.pool.connect();
    let row: ProjectRow | undefined;
    try {
      await client.query("begin");
      const result = await client.query<ProjectRow>(
        `
          insert into projects (key, name, description)
          values ($1, $2, $3)
          returning id, key, name, description, $4::text as workspace_path, created_at, updated_at
        `,
        [key, repositoryName, `GitHub clone: ${input.repositoryFullName}`, targetAbsolutePath],
      );
      row = result.rows[0];
      if (!row) {
        throw new Error("Project insert did not return a row");
      }
      await client.query(
        `
          insert into workspace_roots (project_id, host_path)
          values ($1, $2)
        `,
        [row.id, targetAbsolutePath],
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

  app.post("/api/projects/github-clone", handleGitHubProjectClone);
  app.post("/api/projects/clone", handleGitHubProjectClone);

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
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
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

    await appendEvent(db.pool, redis, {
      projectId: null,
      type: "project.deleted",
      payload: {
        projectId: row.id,
        key: row.key,
        name: row.name,
      },
    });

    return { project: row, deleted: true };
  });

  app.get("/api/tasks", async (request) => {
    const query = z
      .object({
        projectId: z.string().uuid().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);

    const values: string[] = [];
    const clauses: string[] = [];

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
    const input = taskInputSchema.parse(request.body);
    const project = await db.pool.query("select id from projects where id = $1", [input.projectId]);
    if ((project.rowCount ?? 0) === 0) {
      return reply.code(404).send({ error: "Project not found" });
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
        insert into tasks (project_id, title, instructions, status)
        values ($1, $2, $3, 'created')
        returning id, project_id, title, instructions, status, created_at, updated_at
      `,
      [input.projectId, input.title, input.instructions],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Task insert did not return a row");
    }

    await appendEvent(db.pool, redis, {
      projectId: row.project_id,
      taskId: row.id,
      type: "task.created",
      payload: {
        title: row.title,
        status: row.status,
      },
    });

    await insertChatMessage(db, {
      projectId: row.project_id,
      taskId: row.id,
      role: "user",
      source: "master",
      content: input.instructions,
      metadata: {
        title: row.title,
        initial: true,
      },
    });

    await ensureHermesSession(db, config, row);

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

    const [messagesResult, sessionsResult, runsResult, checkpointsResult, artifactsResult, eventsResult] =
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
          runtime_profile_id: string | null;
          hermes_session_id: string | null;
          hermes_run_id: string | null;
          created_at: Date;
          updated_at: Date;
        }>(
          `
            select id, task_id, runtime_profile_id, hermes_session_id, hermes_run_id, created_at, updated_at
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
      ]);

    const runtime: TaskRuntimeSummary = {
      task: mapTask(taskRow),
      messages: messagesResult.rows.map(mapChatMessage),
      sessions: sessionsResult.rows.map(mapSession),
      runs: runsResult.rows.map(mapRun),
      checkpoints: checkpointsResult.rows.map(mapCheckpoint),
      artifacts: artifactsResult.rows.map(mapArtifact),
      events: eventsResult.rows.map(mapEvent),
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

    const userMessage = await insertChatMessage(db, {
      projectId: task.project_id,
      taskId: task.id,
      role: "user",
      source: "master",
      content: input.content,
    });

    await appendEvent(db.pool, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "chat.message.created",
      payload: {
        role: "user",
        messageId: userMessage.id,
      },
    });

    const sessionId = await ensureHermesSession(db, config, task);
    const response = await fetch(`${config.hermesManagerUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: input.content }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(`Hermes session chat failed: ${response.status} ${JSON.stringify(body)}`);
    }

    const assistantMessage = await insertChatMessage(db, {
      projectId: task.project_id,
      taskId: task.id,
      role: "assistant",
      source: "hermes",
      content: extractHermesAssistantText(body),
      metadata: {
        hermesSessionId: sessionId,
        response: body,
      },
    });

    await db.pool.query("update tasks set updated_at = now() where id = $1", [task.id]);
    await appendEvent(db.pool, redis, {
      projectId: task.project_id,
      taskId: task.id,
      type: "chat.message.completed",
      payload: {
        role: "assistant",
        messageId: assistantMessage.id,
        hermesSessionId: sessionId,
      },
    });

    return reply.code(201).send({ messages: [userMessage, assistantMessage] });
  });

  app.get("/events/stream", async (_request, reply) => {
    const subscriber = new Redis(config.redisUrl);
    await subscriber.subscribe(EVENT_CHANNEL);

    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });

    const recent = await db.pool.query<{
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
        order by created_at desc
        limit 50
      `,
    );

    for (const row of recent.rows.reverse()) {
      reply.raw.write(
        encodeSse(
          row.type,
          {
            id: row.id,
            projectId: row.project_id,
            taskId: row.task_id,
            type: row.type,
            payload: row.payload,
            createdAt: row.created_at.toISOString(),
          },
          row.id,
        ),
      );
    }

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);

    subscriber.on("message", (_channel, message) => {
      const parsed = JSON.parse(message) as { id: string; type: string };
      reply.raw.write(encodeSse(parsed.type, parsed, parsed.id));
    });

    reply.raw.on("close", () => {
      clearInterval(heartbeat);
      subscriber.disconnect();
    });
  });

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

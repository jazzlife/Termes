import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { TERMES_VERSION } from "@termes/shared";
import Fastify from "fastify";

type ManagedRunStatus = "started" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

interface ManagedEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

interface ManagedRun {
  object: "hermes.run";
  run_id: string;
  status: ManagedRunStatus;
  session_id: string;
  model: string;
  input: string;
  instructions: string;
  output: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  artifact_uri: string;
  checksum: string;
  worktree_path?: string;
  changed_files?: Array<{ path: string; bytes: number; sha256: string }>;
  commands?: Array<{
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
  events: ManagedEvent[];
  created_at: string;
  updated_at: string;
}

interface RunCreateInput {
  input?: string;
  instructions?: string;
  session_id?: string;
  profile?: string;
  previous_response_id?: string;
  conversation_history?: unknown[];
  metadata?: Record<string, unknown>;
}

interface ManagedMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

interface ManagedSession {
  id: string;
  title: string;
  source: string;
  parent_id: string | null;
  end_reason: string | null;
  messages: ManagedMessage[];
  created_at: string;
  updated_at: string;
}

interface ManagedJob {
  job_id: string;
  prompt: string;
  schedule: string | null;
  skills: unknown[];
  provider: string | null;
  delivery_target: string | null;
  paused: boolean;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ManagedResponse {
  id: string;
  object: "response";
  status: string;
  model: string;
  input: unknown;
  output: unknown[];
  usage: ManagedRun["usage"];
  run_id: string;
  conversation: string | null;
  previous_response_id: string | null;
  session_key: string | null;
  created_at: string;
}

interface RunnerExecutionResult {
  status: "completed";
  worktreePath: string;
  artifactUri: string;
  checksum: string;
  output: string;
  changedFiles: Array<{ path: string; bytes: number; sha256: string }>;
  commands: Array<{
    command: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
  }>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function truthyObject(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.keys(value as Record<string, unknown>).length > 0;
}

function parseModelConfig(text: string): {
  provider: string | null;
  model: string | null;
  openaiRuntime: string | null;
} {
  const result = { provider: null as string | null, model: null as string | null, openaiRuntime: null as string | null };
  let inModel = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^\S/.test(line)) {
      inModel = line.trim() === "model:";
      continue;
    }
    if (!inModel) {
      continue;
    }

    const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    const value = match[2]?.replace(/^['"]|['"]$/g, "").trim() || null;
    if (match[1] === "provider") {
      result.provider = value;
    } else if (match[1] === "default") {
      result.model = value;
    } else if (match[1] === "openai_runtime") {
      result.openaiRuntime = value;
    }
  }
  return result;
}

async function readJsonFileIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function port(): number {
  const raw = process.env.PORT || "8080";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }

  return parsed;
}

function optionalBaseUrl(): string | null {
  const raw = process.env.HERMES_API_BASE_URL?.trim();
  if (!raw) {
    return null;
  }

  return raw.replace(/\/+$/, "");
}

function optionalRunnerUrl(): string | null {
  const raw = process.env.RUNNER_SUPERVISOR_URL?.trim();
  if (!raw) {
    return null;
  }

  return raw.replace(/\/+$/, "");
}

function optionalOfficialAgentUrl(): string | null {
  const raw = process.env.HERMES_OFFICIAL_AGENT_URL?.trim();
  if (!raw) {
    return null;
  }

  return raw.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const token = process.env.HERMES_API_KEY?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function forwardedHermesHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of ["idempotency-key", "x-hermes-session-id", "x-hermes-session-key"]) {
    const value = headers[name];
    if (Array.isArray(value)) {
      if (value[0]) {
        forwarded[name] = value[0];
      }
    } else if (value) {
      forwarded[name] = value;
    }
  }

  return forwarded;
}

function applyHermesEchoHeaders(
  reply: { header: (name: string, value: string) => unknown },
  upstreamHeaders: Headers,
  localSessionKey: string | null,
  localSessionId: string | null = null,
): void {
  const upstreamSessionId = upstreamHeaders.get("x-hermes-session-id") || localSessionId;
  const upstreamSessionKey = upstreamHeaders.get("x-hermes-session-key") || localSessionKey;
  if (upstreamSessionId) {
    reply.header("x-hermes-session-id", upstreamSessionId);
  }
  if (upstreamSessionKey) {
    reply.header("x-hermes-session-key", upstreamSessionKey);
  }
}

function runPath(runsRoot: string, runId: string): string {
  return path.join(runsRoot, runId, "run.json");
}

async function readManagedRun(runsRoot: string, runId: string): Promise<ManagedRun> {
  const raw = await readFile(runPath(runsRoot, runId), "utf8");
  return JSON.parse(raw) as ManagedRun;
}

async function findManagedRun(runsRoot: string, runId: string): Promise<ManagedRun | null> {
  return readManagedRun(runsRoot, runId).catch(() => null);
}

async function writeManagedRun(runsRoot: string, run: ManagedRun): Promise<void> {
  await mkdir(path.dirname(runPath(runsRoot, run.run_id)), { recursive: true });
  await writeFile(runPath(runsRoot, run.run_id), `${JSON.stringify(run, null, 2)}\n`);
}

function appendRunEvent(run: ManagedRun, type: string, data: Record<string, unknown>): void {
  run.events.push({
    id: `evt_${randomUUID()}`,
    type,
    data,
    createdAt: new Date().toISOString(),
  });
  run.updated_at = new Date().toISOString();
}

async function proxyJson(baseUrl: string, pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...authHeaders(),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    throw new Error(`Hermes upstream ${pathname} returned ${response.status}: ${text}`);
  }

  return body;
}

function textFromResponseInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const record = item as Record<string, unknown>;
        const role = typeof record.role === "string" ? record.role : "user";
        const content = record.content;
        if (typeof content === "string") {
          return `${role}: ${content}`;
        }
        if (Array.isArray(content)) {
          const text = content
            .map((part) => {
              if (!part || typeof part !== "object") {
                return "";
              }
              const partRecord = part as Record<string, unknown>;
              return typeof partRecord.text === "string" ? partRecord.text : "";
            })
            .filter(Boolean)
            .join(" ");
          return `${role}: ${text}`;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(input ?? "");
}

function buildRunCreateInput(body: {
  input?: unknown;
  instructions?: string;
  conversation?: string;
  previous_response_id?: string;
  conversation_history?: unknown[];
  session_key?: string | null;
}): RunCreateInput {
  const input: RunCreateInput = {};
  if (body.input !== undefined) {
    input.input = textFromResponseInput(body.input);
  }
  if (body.instructions !== undefined) {
    input.instructions = body.instructions;
  }
  if (body.conversation !== undefined) {
    input.session_id = body.conversation;
  }
  if (body.previous_response_id !== undefined) {
    input.previous_response_id = body.previous_response_id;
  }
  if (body.conversation_history !== undefined) {
    input.conversation_history = body.conversation_history;
  }
  if (body.session_key) {
    input.metadata = { ...(input.metadata || {}), sessionKey: body.session_key };
  }

  return input;
}

function proxyRequestInit(
  method: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): RequestInit {
  if (method === "GET" || method === "HEAD") {
    return { method, headers: forwardedHermesHeaders(headers) };
  }

  return {
    method,
    headers: forwardedHermesHeaders(headers),
    body: JSON.stringify(body || {}),
  };
}

function jsonPath(root: string, id: string): string {
  return path.join(root, `${id}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function listJsonFiles<T>(root: string): Promise<T[]> {
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  const items = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readJsonFile<T>(path.join(root, entry.name))),
  );

  return items;
}

async function listManagedRuns(runsRoot: string): Promise<ManagedRun[]> {
  await mkdir(runsRoot, { recursive: true });
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const runs = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        return readJsonFile<ManagedRun>(path.join(runsRoot, entry.name, "run.json")).catch(() => null);
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        return readJsonFile<ManagedRun>(path.join(runsRoot, entry.name)).catch(() => null);
      }

      return null;
    }),
  );

  return runs.filter((run): run is ManagedRun => Boolean(run));
}

function textFromChatContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text || "");
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

function textFromChatMessages(messages: Array<{ role?: string; content?: unknown }> = []): string {
  return messages
    .map((message) => {
      const content = textFromChatContent(message.content);
      return content ? `${message.role || "user"}: ${content}` : `${message.role || "user"}:`;
    })
    .join("\n");
}

function latestChatMessageText(messages: Array<{ role?: string; content?: unknown }> = []): string {
  const reversed = [...messages].reverse();
  const message = reversed.find((item) => item.role === "user") || reversed.find((item) => (item.role || "user") !== "system");
  return message ? textFromChatContent(message.content) : "";
}

function textFromChatCompletionResponse(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return "";
  }

  return choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") {
        return "";
      }
      const message = (choice as { message?: unknown }).message;
      if (!message || typeof message !== "object") {
        return "";
      }
      return textFromChatContent((message as { content?: unknown }).content);
    })
    .filter(Boolean)
    .join("\n");
}

function sessionTitleFromInput(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 80) : "Chat Completions session";
}

function managedAssistantText(input: string): string {
  return [
    "Termes managed Hermes processed the request.",
    "",
    input.trim() || "(empty input)",
  ].join("\n");
}

function normalizeApprovalBody(body: unknown): Record<string, unknown> {
  const record = body && typeof body === "object" ? { ...(body as Record<string, unknown>) } : {};
  const decision = typeof record.decision === "string" ? record.decision : "";
  if (decision === "approved") {
    record.choice = "once";
    delete record.decision;
  } else if (decision === "rejected") {
    record.choice = "deny";
    delete record.decision;
  }
  return record;
}

function withTopLevelSessionId(value: unknown): unknown {
  if (!value || typeof value !== "object" || "id" in value) {
    return value;
  }
  const nested = (value as { session?: unknown }).session;
  if (nested && typeof nested === "object" && typeof (nested as { id?: unknown }).id === "string") {
    return { id: (nested as { id: string }).id, ...value };
  }
  return value;
}

function openAiUsage(input: string, output: string): ManagedRun["usage"] {
  const inputTokens = Math.ceil(input.length / 4);
  const outputTokens = Math.ceil(output.length / 4);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }

  return value || null;
}

function validateSessionKey(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (value.length > 256 || /[\r\n\u0000]/.test(value)) {
    throw new Error("X-Hermes-Session-Key must be 256 characters or fewer and cannot contain control characters");
  }

  return value;
}

function validateSessionId(value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error("X-Hermes-Session-Id must be 1-128 URL-safe characters without slashes");
  }

  return value;
}

function unsupportedContentType(value: unknown): string | null {
  if (typeof value === "string") {
    if (value.startsWith("data:") && !value.startsWith("data:image/")) {
      return "unsupported_content_type";
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const part of value) {
      const unsupported = unsupportedContentType(part);
      if (unsupported) {
        return unsupported;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "file" || type === "input_file" || "file_id" in record) {
    return "unsupported_content_type";
  }
  if (typeof record.url === "string" && record.url.startsWith("data:") && !record.url.startsWith("data:image/")) {
    return "unsupported_content_type";
  }
  if (
    typeof record.image_url === "string" &&
    record.image_url.startsWith("data:") &&
    !record.image_url.startsWith("data:image/")
  ) {
    return "unsupported_content_type";
  }
  if (record.image_url && typeof record.image_url === "object") {
    const nestedUrl = (record.image_url as { url?: unknown }).url;
    if (typeof nestedUrl === "string" && nestedUrl.startsWith("data:") && !nestedUrl.startsWith("data:image/")) {
      return "unsupported_content_type";
    }
  }

  for (const nested of Object.values(record)) {
    const unsupported = unsupportedContentType(nested);
    if (unsupported) {
      return unsupported;
    }
  }

  return null;
}

function responseOutputFromRun(run: ManagedRun): unknown[] {
  const items: unknown[] = [];
  for (const command of run.commands || []) {
    const callId = `call_${createHash("sha1").update(`${run.run_id}:${command.command}`).digest("hex").slice(0, 12)}`;
    items.push({
      type: "function_call",
      name: "terminal",
      arguments: JSON.stringify({ command: command.command }),
      call_id: callId,
    });
    items.push({
      type: "function_call_output",
      call_id: callId,
      output: [command.stdout, command.stderr].filter(Boolean).join("\n"),
    });
  }
  items.push({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: run.output || managedAssistantText(run.input) }],
  });

  return items;
}

async function waitForManagedRun(runsRoot: string, runId: string, timeoutMs = 30_000): Promise<ManagedRun> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const run = await readManagedRun(runsRoot, runId);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(`Hermes run ${runId} timed out after ${timeoutMs}ms`);
}

async function executeRunnerRun(runnerUrl: string, run: ManagedRun, input: RunCreateInput): Promise<RunnerExecutionResult> {
  const response = await fetch(`${runnerUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId: run.run_id,
      sessionId: run.session_id,
      taskId: typeof input.metadata?.taskId === "string" ? input.metadata.taskId : undefined,
      projectId: typeof input.metadata?.projectId === "string" ? input.metadata.projectId : undefined,
      title: typeof input.metadata?.title === "string" ? input.metadata.title : undefined,
      instructions: input.input || "",
      worktreePath: typeof input.metadata?.worktreePath === "string" ? input.metadata.worktreePath : undefined,
    }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as RunnerExecutionResult | { error?: string }) : {};
  if (!response.ok || !("status" in body) || body.status !== "completed") {
    throw new Error(`Runner execution failed: ${response.status} ${text}`);
  }

  return body;
}

async function completeManagedRun(
  runsRoot: string,
  runnerUrl: string | null,
  runId: string,
  input: RunCreateInput,
  localOutput: string,
  localArtifactPath: string,
  localChecksum: string,
): Promise<void> {
  const current = await readManagedRun(runsRoot, runId);
  if (current.status !== "running") {
    return;
  }

  appendRunEvent(current, "tool.started", {
    name: runnerUrl ? "runner_supervisor" : "artifact_writer",
  });

  if (runnerUrl) {
    const result = await executeRunnerRun(runnerUrl, current, input);
    current.status = "completed";
    current.output = result.output;
    current.artifact_uri = result.artifactUri;
    current.checksum = result.checksum;
    current.worktree_path = result.worktreePath;
    current.changed_files = result.changedFiles;
    current.commands = result.commands;
    current.usage = {
      input_tokens: Math.ceil((current.input.length + current.instructions.length) / 4),
      output_tokens: Math.ceil(result.output.length / 4),
      total_tokens: Math.ceil((current.input.length + current.instructions.length + result.output.length) / 4),
    };
    appendRunEvent(current, "tool.completed", {
      name: "runner_supervisor",
      artifact_uri: result.artifactUri,
      worktree_path: result.worktreePath,
      changed_files: result.changedFiles.map((file) => file.path),
      checksum: result.checksum,
    });
    appendRunEvent(current, "run.completed", {
      run_id: runId,
      artifact_uri: result.artifactUri,
      checksum: result.checksum,
    });
    await writeManagedRun(runsRoot, current);
    return;
  }

  current.status = "completed";
  current.output = localOutput;
  appendRunEvent(current, "tool.completed", {
    name: "artifact_writer",
    artifact_uri: localArtifactPath,
    checksum: localChecksum,
  });
  appendRunEvent(current, "run.completed", {
    run_id: runId,
    artifact_uri: localArtifactPath,
    checksum: localChecksum,
  });
  await writeManagedRun(runsRoot, current);
}

async function createManagedRun(runsRoot: string, runnerUrl: string | null, input: RunCreateInput): Promise<ManagedRun> {
  const runId = `run_${randomUUID()}`;
  const now = new Date().toISOString();
  const sessionId = input.session_id || `session_${randomUUID()}`;
  const instructions = input.instructions || "";
  const prompt = input.input || "";
  const artifactPath = path.join(runsRoot, runId, "artifact.md");
  const output = [
    "# Termes Hermes Run",
    "",
    `Run: ${runId}`,
    `Session: ${sessionId}`,
    `Profile: ${input.profile || "default"}`,
    "",
    "## Instructions",
    instructions || "(empty)",
    "",
    "## Input",
    prompt || "(empty)",
    "",
    "## Result",
    "Hermes manager accepted the run, recorded the execution state, emitted lifecycle events, and produced this durable artifact.",
  ].join("\n");
  const checksum = createHash("sha256").update(output).digest("hex");

  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${output}\n`);

  const run: ManagedRun = {
    object: "hermes.run",
    run_id: runId,
    status: "running",
    session_id: sessionId,
    model: process.env.HERMES_MODEL || "hermes-agent",
    input: prompt,
    instructions,
    output: "",
    usage: {
      input_tokens: Math.ceil((prompt.length + instructions.length) / 4),
      output_tokens: Math.ceil(output.length / 4),
      total_tokens: Math.ceil((prompt.length + instructions.length + output.length) / 4),
    },
    artifact_uri: artifactPath,
    checksum,
    events: [],
    created_at: now,
    updated_at: now,
  };

  appendRunEvent(run, "run.created", { run_id: runId, session_id: sessionId });
  appendRunEvent(run, "assistant.delta", { text: "Run accepted by Hermes manager." });
  await writeManagedRun(runsRoot, run);

  setTimeout(() => {
    completeManagedRun(runsRoot, runnerUrl, runId, input, output, artifactPath, checksum).catch(async (error: unknown) => {
      const current = await readManagedRun(runsRoot, runId).catch(() => null);
      if (!current || current.status !== "running") {
        return;
      }

      current.status = "failed";
      current.output = error instanceof Error ? error.message : String(error);
      appendRunEvent(current, "run.failed", { run_id: runId, message: current.output });
      await writeManagedRun(runsRoot, current);
    });
  }, 400);

  return run;
}

function encodeSse(event: ManagedEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function main(): Promise<void> {
  const profilesRoot = requiredEnv("HERMES_PROFILES_ROOT");
  const codexHomesRoot = requiredEnv("CODEX_HOMES_ROOT");
  const runsRoot = process.env.HERMES_RUNS_ROOT || "/data/docker_data/termes/hermes/runs";
  const stateRoot = process.env.HERMES_STATE_ROOT || path.dirname(runsRoot);
  const responsesRoot = path.join(stateRoot, "responses");
  const sessionsRoot = path.join(stateRoot, "sessions");
  const jobsRoot = path.join(stateRoot, "jobs");
  const baseUrl = optionalBaseUrl();
  const runnerUrl = optionalRunnerUrl();
  const officialAgentUrl = optionalOfficialAgentUrl();

  await mkdir(profilesRoot, { recursive: true });
  await mkdir(codexHomesRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await mkdir(responsesRoot, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(jobsRoot, { recursive: true });

  const app = Fastify({ logger: true });
  const idempotencyCache = new Map<string, { expiresAt: number; response: unknown }>();

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  async function upstreamHealth(): Promise<{
    status: "not_configured" | "ok" | "error";
    body: unknown;
    error?: string;
  }> {
    if (!baseUrl) {
      return { status: "not_configured", body: null };
    }

    try {
      return { status: "ok", body: await proxyJson(baseUrl, "/health") };
    } catch (error) {
      return {
        status: "error",
        body: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function officialAgentHealth(): Promise<{
    status: "not_configured" | "ok" | "error";
    body: unknown;
    error?: string;
  }> {
    if (!officialAgentUrl) {
      return { status: "not_configured", body: null };
    }

    try {
      return { status: "ok", body: await proxyJson(officialAgentUrl, "/health") };
    } catch (error) {
      return {
        status: "error",
        body: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function upstreamDiagnostics(): Promise<Record<string, unknown>> {
    const upstream = await upstreamHealth();
    const officialHealth = await officialAgentHealth();
    const agentStateRoot = process.env.HERMES_AGENT_STATE_ROOT || "/data/docker_data/termes/hermes-agent";
    const codexHome = path.join(agentStateRoot, ".codex");
    const modelConfig = await readFile(path.join(agentStateRoot, "config.yaml"), "utf8")
      .then(parseModelConfig)
      .catch(() => ({ provider: null, model: null, openaiRuntime: null }));
    const codexAuth = await readJsonFileIfPresent(path.join(codexHome, "auth.json"));
    const hermesAuth = await readJsonFileIfPresent(path.join(agentStateRoot, "auth.json"));
    const hermesAuthText = hermesAuth ? JSON.stringify(hermesAuth) : "";
    const codexAuthConfigured =
      Boolean(codexAuth?.auth_mode === "chatgpt" || codexAuth?.auth_mode === "oauth") ||
      truthyObject(codexAuth?.tokens) ||
      truthyObject(codexAuth?.OPENAI_API_KEY);
    const hermesOpenAiCodexOAuthConfigured =
      hermesAuthText.includes("openai-codex") &&
      (hermesAuthText.includes("access_token") || hermesAuthText.includes("refresh_token"));
    const providerKeys = {
      OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY_CONFIGURED === "true"),
      OPENROUTER_API_KEY: Boolean(
        process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY_CONFIGURED === "true",
      ),
      ANTHROPIC_API_KEY: Boolean(
        process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_API_KEY_CONFIGURED === "true",
      ),
    };
    const hasProvider = Object.values(providerKeys).some(Boolean);
    const codexRuntimeRequired = modelConfig.provider === "openai-codex" || modelConfig.openaiRuntime === "codex_app_server";
    const codexReady =
      modelConfig.provider === "openai-codex" &&
      modelConfig.openaiRuntime === "codex_app_server" &&
      codexAuthConfigured &&
      hermesOpenAiCodexOAuthConfigured;
    const baseUrlConfigured = Boolean(baseUrl);
    const apiKeyConfigured = Boolean(process.env.HERMES_API_KEY?.trim());
    const officialAgentUrlConfigured = Boolean(officialAgentUrl);
    const localProviderKeyRequired = officialAgentUrlConfigured || (baseUrlConfigured && baseUrl?.includes("hermes-agent"));
    const ready =
      baseUrlConfigured &&
      upstream.status === "ok" &&
      (localProviderKeyRequired ? (hasProvider || codexReady) && officialHealth.status === "ok" : true);

    return {
      baseUrlConfigured,
      apiKeyConfigured,
      upstreamStatus: upstream.status,
      upstreamError: upstream.error,
      officialAgentUrlConfigured,
      officialAgentStatus: officialHealth.status,
      officialAgentError: officialHealth.error,
      providerKeys,
      oauthProviders: {
        "openai-codex": codexAuthConfigured && hermesOpenAiCodexOAuthConfigured,
      },
      codex: {
        required: codexRuntimeRequired,
        home: codexHome,
        authConfigured: codexAuthConfigured,
        hermesAuthConfigured: hermesOpenAiCodexOAuthConfigured,
        modelProvider: modelConfig.provider,
        model: modelConfig.model,
        openaiRuntime: modelConfig.openaiRuntime,
        appServerRuntimeConfigured: modelConfig.openaiRuntime === "codex_app_server",
        ready: codexReady,
      },
      localProviderKeyRequired,
      ready,
      required: [
        "Set HERMES_API_BASE_URL to the official Hermes API server URL.",
        "Set HERMES_API_KEY when the upstream API server requires API_SERVER_KEY.",
        "Set at least one Hermes provider key, or complete OpenAI Codex OAuth with model.provider=openai-codex and model.openai_runtime=codex_app_server.",
        "Start the hermes-agent compose profile when using the bundled official Hermes container.",
      ],
    };
  }

  async function capabilities(): Promise<Record<string, unknown>> {
    const upstreamStatus = await upstreamHealth();
    const upstream = baseUrl ? await proxyJson(baseUrl, "/v1/capabilities").catch(() => null) : null;
    const diagnostics = await upstreamDiagnostics();
    const features = {
      profiles: true,
      chat_completions: true,
      responses_api: true,
      run_submission: true,
      run_status: true,
      run_events_sse: true,
      run_stop: true,
      run_approval: true,
      sessions: true,
      session_list: true,
      session_create: true,
      session_read: true,
      session_update: true,
      session_delete: true,
      session_messages: true,
      session_fork: true,
      session_chat: true,
      session_chat_stream: true,
      jobs: true,
      job_list: true,
      job_create: true,
      job_read: true,
      job_update: true,
      job_delete: true,
      job_pause: true,
      job_resume: true,
      job_run: true,
      skills: true,
      toolsets: true,
    };

    return {
      manager: {
        status: "ok",
        profilesRoot,
        codexHomesRoot,
        runsRoot,
        upstreamConfigured: Boolean(baseUrl),
        runnerConfigured: Boolean(runnerUrl),
        upstreamStatus: upstreamStatus.status,
        upstreamError: upstreamStatus.error,
        upstreamDiagnostics: diagnostics,
      },
      object: "hermes.api_server.capabilities",
      platform: "termes-hermes-manager",
      model: process.env.HERMES_MODEL || "hermes-agent",
      auth: { type: "internal", required: false },
      upstream,
      features,
      endpoints: {
        chat_completions: "/v1/chat/completions",
        responses: "/v1/responses",
        response_read: "/v1/responses/{id}",
        response_delete: "/v1/responses/{id}",
        models: "/v1/models",
        capabilities: "/v1/capabilities",
        health: "/health",
        health_v1: "/v1/health",
        health_detailed: "/health/detailed",
        runs: "/v1/runs",
        run_read: "/v1/runs/{run_id}",
        run_events: "/v1/runs/{run_id}/events",
        run_stop: "/v1/runs/{run_id}/stop",
        run_approval: "/v1/runs/{run_id}/approval",
        sessions: "/api/sessions",
        session_read: "/api/sessions/{id}",
        session_update: "/api/sessions/{id}",
        session_delete: "/api/sessions/{id}",
        session_messages: "/api/sessions/{id}/messages",
        session_fork: "/api/sessions/{id}/fork",
        session_chat: "/api/sessions/{id}/chat",
        session_chat_stream: "/api/sessions/{id}/chat/stream",
        jobs: "/api/jobs",
        job_read: "/api/jobs/{job_id}",
        job_update: "/api/jobs/{job_id}",
        job_delete: "/api/jobs/{job_id}",
        job_pause: "/api/jobs/{job_id}/pause",
        job_resume: "/api/jobs/{job_id}/resume",
        job_run: "/api/jobs/{job_id}/run",
        skills: "/v1/skills",
        toolsets: "/v1/toolsets",
      },
      session_key_header: "X-Hermes-Session-Key",
    };
  }

  async function readSession(sessionId: string): Promise<ManagedSession> {
    return readJsonFile<ManagedSession>(jsonPath(sessionsRoot, sessionId));
  }

  async function writeSession(session: ManagedSession): Promise<void> {
    await writeJsonFile(jsonPath(sessionsRoot, session.id), session);
  }

  async function createSession(
    input: { id?: string; title?: string; source?: string; parent_id?: string | null } = {},
  ): Promise<ManagedSession> {
    const now = new Date().toISOString();
    const session: ManagedSession = {
      id: input.id || `session_${randomUUID()}`,
      title: input.title || "New session",
      source: input.source || "termes",
      parent_id: input.parent_id ?? null,
      end_reason: null,
      messages: [],
      created_at: now,
      updated_at: now,
    };
    await writeSession(session);
    return session;
  }

  async function appendSessionMessage(session: ManagedSession, role: ManagedMessage["role"], content: string): Promise<ManagedMessage> {
    const message: ManagedMessage = {
      id: `msg_${randomUUID()}`,
      role,
      content,
      created_at: new Date().toISOString(),
    };
    session.messages.push(message);
    session.updated_at = message.created_at;
    await writeSession(session);
    return message;
  }

  async function ensureChatCompletionSession(sessionId: string | null, input: string): Promise<ManagedSession> {
    if (sessionId) {
      const existing = await readSession(sessionId).catch(() => null);
      if (existing) {
        return existing;
      }
      return createSession({
        id: sessionId,
        title: sessionTitleFromInput(input),
        source: "chat_completions",
      });
    }

    return createSession({
      title: sessionTitleFromInput(input),
      source: "chat_completions",
    });
  }

  app.get("/healthz", async () => {
    const upstream = await upstreamHealth();

    return {
      service: "hermes-manager",
      version: TERMES_VERSION,
      status: "ok",
      profilesRoot,
      codexHomesRoot,
      runsRoot,
      stateRoot,
      upstreamConfigured: Boolean(baseUrl),
      runnerConfigured: Boolean(runnerUrl),
      upstreamStatus: upstream.status,
      upstream: upstream.body,
      upstreamError: upstream.error,
      upstreamDiagnostics: await upstreamDiagnostics(),
      checkedAt: new Date().toISOString(),
    };
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/health", async () => ({ status: "ok" }));

  app.get("/health/detailed", async () => {
    const [sessions, jobs, runs] = await Promise.all([
      listJsonFiles<ManagedSession>(sessionsRoot),
      listJsonFiles<ManagedJob>(jobsRoot),
      listManagedRuns(runsRoot),
    ]);
    return {
      status: "ok",
      sessions: sessions.length,
      jobs: jobs.length,
      runs: runs.length,
      running_agents: runs.filter((run) => run.status === "running").length,
      checkedAt: new Date().toISOString(),
    };
  });

  app.get("/capabilities", async () => capabilities());
  app.get("/v1/capabilities", async () => capabilities());
  app.get("/upstream/diagnostics", async () => upstreamDiagnostics());
  app.get("/v1/upstream/diagnostics", async () => upstreamDiagnostics());

  app.get("/profiles", async () => {
    const profiles = await readdir(profilesRoot, { withFileTypes: true });
    return {
      profiles: profiles.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
    };
  });

  app.post("/profiles", async (request, reply) => {
    const body = request.body as { name?: string; codexRuntimeEnabled?: boolean };
    const name = body.name?.trim();
    if (!name || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
      return reply.code(400).send({ error: "profile name must be 2-63 lowercase letters, numbers, or hyphens" });
    }

    const hermesHome = path.join(profilesRoot, name);
    const codexHome = path.join(codexHomesRoot, name);
    await mkdir(hermesHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      path.join(hermesHome, "termes-profile.json"),
      `${JSON.stringify(
        {
          name,
          hermesHome,
          codexHome,
          codexRuntimeEnabled: Boolean(body.codexRuntimeEnabled),
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    ).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    });

    return reply.code(201).send({ profile: { name, hermesHome, codexHome } });
  });

  app.delete("/profiles/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    if (name === "default") {
      return reply.code(400).send({ error: "default profile cannot be deleted" });
    }

    await rm(path.join(profilesRoot, name), { recursive: true, force: true });
    await rm(path.join(codexHomesRoot, name), { recursive: true, force: true });
    return { deleted: true };
  });

  app.get("/v1/models", async () => {
    if (baseUrl) {
      return proxyJson(baseUrl, "/v1/models");
    }

    return {
      object: "list",
      data: [{ id: process.env.HERMES_MODEL || "hermes-agent", object: "model", owned_by: "termes" }],
    };
  });

  app.get("/v1/skills", async () =>
    baseUrl
      ? proxyJson(baseUrl, "/v1/skills")
      : [
          {
            name: "termes-orchestration",
            description: "Create runs, sessions, checkpoints, approvals, and jobs through Termes.",
            category: "runtime",
          },
          {
            name: "workspace-inspection",
            description: "Read runtime artifacts, events, and checkpoint summaries.",
            category: "workspace",
          },
        ],
  );
  app.get("/v1/toolsets", async () =>
    baseUrl
      ? proxyJson(baseUrl, "/v1/toolsets")
      : [
          {
            name: "core",
            label: "Core",
            description: "Managed Hermes-compatible control-plane tools.",
            enabled: true,
            configured: true,
            tools: ["runs", "responses", "sessions", "jobs", "approvals", "checkpoints"],
          },
          {
            name: "api_server",
            label: "API Server",
            description: "OpenAI-compatible and Hermes-compatible HTTP endpoints.",
            enabled: true,
            configured: true,
            tools: ["chat_completions", "responses_api", "run_events_sse", "session_chat_stream"],
          },
        ],
  );

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as {
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
    };
    const sessionKey = validateSessionKey(headerValue(request.headers["x-hermes-session-key"]));
    const requestedSessionId = validateSessionId(headerValue(request.headers["x-hermes-session-id"]));
    if (sessionKey) {
      reply.header("x-hermes-session-key", sessionKey);
    }
    if (requestedSessionId) {
      reply.header("x-hermes-session-id", requestedSessionId);
    }
    const unsupported = unsupportedContentType(body.messages || []);
    if (unsupported) {
      return reply.code(400).send({ error: unsupported });
    }
    const input = textFromChatMessages(body.messages || []);
    const latestInput = latestChatMessageText(body.messages || []) || input;
    if (baseUrl) {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json",
          ...forwardedHermesHeaders(request.headers),
          ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
        },
        body: JSON.stringify(request.body || {}),
      });
      applyHermesEchoHeaders(reply, response.headers, sessionKey, requestedSessionId);
      if (body.stream) {
        reply.hijack();
        reply.raw.writeHead(response.status, {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream",
          "x-accel-buffering": "no",
          ...(response.headers.get("x-hermes-session-id") || requestedSessionId
            ? { "x-hermes-session-id": (response.headers.get("x-hermes-session-id") || requestedSessionId) as string }
            : {}),
          ...(response.headers.get("x-hermes-session-key") || sessionKey
            ? { "x-hermes-session-key": (response.headers.get("x-hermes-session-key") || sessionKey) as string }
            : {}),
        });
        if (response.body) {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            reply.raw.write(Buffer.from(chunk));
          }
        }
        reply.raw.end();
        return;
      }

      const text = await response.text();
      if (!response.ok) {
        return reply.code(response.status).send(text ? JSON.parse(text) : {});
      }
      const output = text ? JSON.parse(text) : {};
      if (requestedSessionId) {
        const session = await ensureChatCompletionSession(requestedSessionId, latestInput || input);
        if (latestInput) {
          await appendSessionMessage(session, "user", latestInput);
        }
        const assistantText = textFromChatCompletionResponse(output);
        if (assistantText) {
          await appendSessionMessage(session, "assistant", assistantText);
        }
      }
      return output;
    }

    const session = await ensureChatCompletionSession(requestedSessionId, latestInput || input);
    reply.header("x-hermes-session-id", session.id);
    if (latestInput) {
      await appendSessionMessage(session, "user", latestInput);
    }
    const output = managedAssistantText(input);
    await appendSessionMessage(session, "assistant", output);
    const model = body.model || process.env.HERMES_MODEL || "hermes-agent";
    const id = `chatcmpl_${randomUUID()}`;

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
        "x-hermes-session-id": session.id,
        ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
      });
      reply.raw.write(
        sse("chat.completion.chunk", {
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }],
        }),
      );
      reply.raw.write(
        sse("hermes.tool.progress", {
          type: "managed.hermes.completed",
          message: "Managed Hermes chat completion produced a response.",
          session_id: session.id,
          session_key: sessionKey,
        }),
      );
      reply.raw.write(
        sse("chat.completion.chunk", {
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: output },
          finish_reason: "stop",
        },
      ],
      usage: openAiUsage(input, output),
    };
  });

  app.post("/v1/responses", async (request, reply) => {
    const body = request.body as {
      input?: unknown;
      instructions?: string;
      conversation?: string;
      previous_response_id?: string;
      stream?: boolean;
    };
    const sessionKey = validateSessionKey(headerValue(request.headers["x-hermes-session-key"]));
    let previousResponseId = body.previous_response_id || null;
    let conversation = body.conversation || null;
    if (!previousResponseId && conversation) {
      const responses = await listJsonFiles<ManagedResponse>(responsesRoot);
      previousResponseId =
        responses
          .filter((response) => response.conversation === conversation)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.id || null;
    }
    if (previousResponseId && !conversation) {
      const previous = await readJsonFile<ManagedResponse>(jsonPath(responsesRoot, previousResponseId)).catch(() => null);
      conversation = previous?.conversation || null;
    }
    if (baseUrl) {
      const upstreamBody = {
        ...(request.body as Record<string, unknown> | null | undefined),
        ...(conversation && !previousResponseId ? { conversation } : {}),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      };
      if (previousResponseId) {
        delete upstreamBody.conversation;
      }
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: body.stream ? "text/event-stream" : "application/json",
          ...forwardedHermesHeaders(request.headers),
          ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
        },
        body: JSON.stringify(upstreamBody),
      });
      applyHermesEchoHeaders(reply, response.headers, sessionKey);
      if (body.stream) {
        reply.hijack();
        reply.raw.writeHead(response.status, {
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream",
          "x-accel-buffering": "no",
          ...(response.headers.get("x-hermes-session-id")
            ? { "x-hermes-session-id": response.headers.get("x-hermes-session-id") as string }
            : {}),
          ...(response.headers.get("x-hermes-session-key") || sessionKey
            ? { "x-hermes-session-key": (response.headers.get("x-hermes-session-key") || sessionKey) as string }
            : {}),
        });
        if (response.body) {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            reply.raw.write(Buffer.from(chunk));
          }
        }
        reply.raw.end();
        return;
      }

      const text = await response.text();
      if (!response.ok) {
        return reply.code(response.status).send(text ? JSON.parse(text) : {});
      }
      const output = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (previousResponseId && output.previous_response_id === undefined) {
        output.previous_response_id = previousResponseId;
      }
      if (conversation && output.conversation === undefined) {
        output.conversation = conversation;
      }

      const responseId = typeof output.id === "string" ? output.id : `resp_${randomUUID()}`;
      const managedResponse: ManagedResponse = {
        id: responseId,
        object: "response",
        status: typeof output.status === "string" ? output.status : "completed",
        model: typeof output.model === "string" ? output.model : process.env.HERMES_MODEL || "hermes-agent",
        input: body.input || "",
        output: Array.isArray(output.output) ? output.output : [],
        usage:
          output.usage && typeof output.usage === "object"
            ? (output.usage as ManagedRun["usage"])
            : { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        run_id: typeof output.run_id === "string" ? output.run_id : "",
        conversation,
        previous_response_id: previousResponseId,
        session_key: sessionKey,
        created_at: new Date().toISOString(),
      };
      await writeJsonFile(jsonPath(responsesRoot, responseId), managedResponse);
      return output;
    }

    const unsupported = unsupportedContentType(body.input || "");
    if (unsupported) {
      return reply.code(400).send({ error: unsupported });
    }

    const idempotencyKey = headerValue(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      const cached = idempotencyCache.get(idempotencyKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
      }
    }

    if (sessionKey) {
      reply.header("x-hermes-session-key", sessionKey);
    }

    const responseRunInput: {
      input?: unknown;
      instructions?: string;
      conversation?: string;
      previous_response_id?: string;
      session_key?: string | null;
    } = {
      input: body.input,
      session_key: sessionKey,
    };
    if (body.instructions !== undefined) {
      responseRunInput.instructions = body.instructions;
    }
    if (conversation) {
      responseRunInput.conversation = conversation;
    }
    if (previousResponseId) {
      responseRunInput.previous_response_id = previousResponseId;
    }

    const run = await createManagedRun(runsRoot, runnerUrl, buildRunCreateInput(responseRunInput));
    const responseId = `resp_${randomUUID()}`;
    const completedRun = await waitForManagedRun(runsRoot, run.run_id);
    const response: ManagedResponse = {
      id: responseId,
      object: "response",
      status: completedRun.status,
      model: completedRun.model,
      input: body.input || "",
      output: responseOutputFromRun(completedRun),
      usage: completedRun.usage,
      run_id: completedRun.run_id,
      conversation,
      previous_response_id: previousResponseId,
      session_key: sessionKey,
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(jsonPath(responsesRoot, responseId), response);

    if (idempotencyKey) {
      idempotencyCache.set(idempotencyKey, { expiresAt: Date.now() + 300_000, response });
    }

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
        ...(sessionKey ? { "x-hermes-session-key": sessionKey } : {}),
      });
      reply.raw.write(sse("response.created", { id: response.id, object: "response", status: "in_progress" }));
      for (const item of response.output) {
        const outputItem = item as Record<string, unknown>;
        if (outputItem.type === "message") {
          const content = outputItem.content;
          const text =
            Array.isArray(content) && content[0] && typeof content[0] === "object"
              ? String((content[0] as { text?: unknown }).text || "")
              : "";
          reply.raw.write(sse("response.output_text.delta", { response_id: response.id, delta: text }));
        } else {
          reply.raw.write(sse("response.output_item.added", { response_id: response.id, item: outputItem }));
          reply.raw.write(sse("response.output_item.done", { response_id: response.id, item: outputItem }));
        }
      }
      reply.raw.write(sse("response.completed", response));
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    return response;
  });

  app.get("/v1/responses/:responseId", async (request) => {
    const { responseId } = request.params as { responseId: string };
    const localResponse = await readJsonFile<ManagedResponse>(jsonPath(responsesRoot, responseId)).catch(() => null);
    if (localResponse) {
      return localResponse;
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/v1/responses/${encodeURIComponent(responseId)}`, {
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    return readJsonFile<ManagedResponse>(jsonPath(responsesRoot, responseId));
  });

  app.delete("/v1/responses/:responseId", async (request) => {
    const { responseId } = request.params as { responseId: string };
    const localResponse = await readJsonFile<ManagedResponse>(jsonPath(responsesRoot, responseId)).catch(() => null);
    if (localResponse) {
      await rm(jsonPath(responsesRoot, responseId), { force: true });
      if (baseUrl) {
        await proxyJson(baseUrl, `/v1/responses/${encodeURIComponent(responseId)}`, {
          method: "DELETE",
          headers: forwardedHermesHeaders(request.headers),
        }).catch(() => null);
      }
      return { id: responseId, deleted: true };
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/v1/responses/${encodeURIComponent(responseId)}`, {
        method: "DELETE",
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    await rm(jsonPath(responsesRoot, responseId), { force: true });
    return { id: responseId, deleted: true };
  });

  app.post("/v1/runs", async (request, reply) => {
    if (baseUrl) {
      const sessionKey = validateSessionKey(headerValue(request.headers["x-hermes-session-key"]));
      if (sessionKey) {
        reply.header("x-hermes-session-key", sessionKey);
      }
      const upstreamRun = await proxyJson(baseUrl, "/v1/runs", {
        method: "POST",
        headers: forwardedHermesHeaders(request.headers),
        body: JSON.stringify(request.body || {}),
      });
      return reply.code(201).send(upstreamRun);
    }

    const body = request.body as RunCreateInput;
    const unsupported = unsupportedContentType(body.input || "");
    if (unsupported) {
      return reply.code(400).send({ error: unsupported });
    }
    const sessionKey = validateSessionKey(headerValue(request.headers["x-hermes-session-key"]));
    if (sessionKey) {
      reply.header("x-hermes-session-key", sessionKey);
      body.metadata = { ...(body.metadata || {}), sessionKey };
    }

    const run = await createManagedRun(runsRoot, runnerUrl, body);
    return reply.code(201).send({ run_id: run.run_id, status: "started", session_id: run.session_id });
  });

  app.get("/v1/runs/:runId", async (request) => {
    const { runId } = request.params as { runId: string };
    const localRun = await findManagedRun(runsRoot, runId);
    if (localRun) {
      return localRun;
    }

    if (baseUrl) {
      return proxyJson(baseUrl, `/v1/runs/${encodeURIComponent(runId)}`, {
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    return readManagedRun(runsRoot, runId);
  });

  app.get("/v1/runs/:runId/events", async (request, reply) => {
    const { runId } = request.params as { runId: string };
    let run = await findManagedRun(runsRoot, runId);
    if (!run && baseUrl) {
      const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
        headers: { ...authHeaders(), ...forwardedHermesHeaders(request.headers), accept: "text/event-stream" },
      });
      reply.hijack();
      reply.raw.writeHead(response.status, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
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

    if (!run) {
      run = await readManagedRun(runsRoot, runId);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });
    let emitted = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30_000) {
      for (const event of run.events.slice(emitted)) {
        reply.raw.write(encodeSse(event));
      }
      emitted = run.events.length;
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
      run = await readManagedRun(runsRoot, runId);
    }
    reply.raw.end();
  });

  app.post("/v1/runs/:runId/stop", async (request) => {
    const { runId } = request.params as { runId: string };
    const localRun = await findManagedRun(runsRoot, runId);
    if (localRun) {
      localRun.status = "cancelled";
      appendRunEvent(localRun, "run.cancelled", { run_id: runId });
      await writeManagedRun(runsRoot, localRun);
      return { status: "stopping" };
    }

    if (baseUrl) {
      return proxyJson(baseUrl, `/v1/runs/${encodeURIComponent(runId)}/stop`, {
        method: "POST",
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    const run = await readManagedRun(runsRoot, runId);
    run.status = "cancelled";
    appendRunEvent(run, "run.cancelled", { run_id: runId });
    await writeManagedRun(runsRoot, run);
    return { status: "stopping" };
  });

  app.post("/v1/runs/:runId/approval", async (request) => {
    const { runId } = request.params as { runId: string };
    const localRun = await findManagedRun(runsRoot, runId);
    if (localRun) {
      appendRunEvent(localRun, "approval.resolved", { run_id: runId, decision: request.body || {} });
      if (localRun.status === "waiting_approval") {
        localRun.status = "running";
      }
      await writeManagedRun(runsRoot, localRun);
      return { status: localRun.status };
    }

    if (baseUrl) {
      const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}/approval`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "content-type": "application/json",
          accept: "application/json",
          ...forwardedHermesHeaders(request.headers),
        },
        body: JSON.stringify(normalizeApprovalBody(request.body)),
      });
      const text = await response.text();
      if (!response.ok) {
        if (response.status === 409 && text.includes("approval_not_active")) {
          return { status: "not_required" };
        }
        throw new Error(`Hermes upstream /v1/runs/${encodeURIComponent(runId)}/approval returned ${response.status}: ${text}`);
      }
      return text ? JSON.parse(text) : { status: "accepted" };
    }

    const run = await readManagedRun(runsRoot, runId);
    appendRunEvent(run, "approval.resolved", { run_id: runId, decision: request.body || {} });
    if (run.status === "waiting_approval") {
      run.status = "running";
    }
    await writeManagedRun(runsRoot, run);
    return { status: run.status };
  });

  app.get("/api/sessions", async (request) => {
    if (baseUrl) {
      return proxyJson(baseUrl, request.url, { headers: forwardedHermesHeaders(request.headers) });
    }

    const query = request.query as {
      limit?: string;
      offset?: string;
      source?: string;
      include_children?: string;
    };
    const limit = Math.min(Math.max(Number.parseInt(query.limit || "50", 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(query.offset || "0", 10) || 0, 0);
    const includeChildren = query.include_children === "true" || query.include_children === "1";
    const sessions = await listJsonFiles<ManagedSession>(sessionsRoot);
    const filtered = sessions
      .filter((session) => (query.source ? session.source === query.source : true))
      .filter((session) => (includeChildren ? true : !session.parent_id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      sessions: filtered
        .slice(offset, offset + limit)
        .map(({ messages, ...session }) => ({
          ...session,
          message_count: messages.length,
        })),
      pagination: {
        limit,
        offset,
        total: filtered.length,
      },
      mode: "managed",
    };
  });

  app.post("/api/sessions", async (request, reply) => {
    if (baseUrl) {
      const upstreamSession = await proxyJson(baseUrl, "/api/sessions", {
        method: "POST",
        headers: forwardedHermesHeaders(request.headers),
        body: JSON.stringify(request.body || {}),
      });
      return withTopLevelSessionId(upstreamSession);
    }

    const session = await createSession(request.body as { title?: string; source?: string });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const localSession = await readSession(sessionId).catch(() => null);
    if (localSession) {
      const { messages, ...session } = localSession;
      return { ...session, message_count: messages.length };
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    const { messages, ...session } = await readSession(sessionId);
    return { ...session, message_count: messages.length };
  });

  app.patch("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const localSession = await readSession(sessionId).catch(() => null);
    if (localSession) {
      const body = request.body as { title?: string; end_reason?: string | null };
      if (body.title !== undefined) {
        localSession.title = body.title;
      }
      if (body.end_reason !== undefined) {
        localSession.end_reason = body.end_reason;
      }
      localSession.updated_at = new Date().toISOString();
      await writeSession(localSession);
      return localSession;
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: forwardedHermesHeaders(request.headers),
        body: JSON.stringify(request.body || {}),
      });
    }

    const body = request.body as { title?: string; end_reason?: string | null };
    const session = await readSession(sessionId);
    if (body.title !== undefined) {
      session.title = body.title;
    }
    if (body.end_reason !== undefined) {
      session.end_reason = body.end_reason;
    }
    session.updated_at = new Date().toISOString();
    await writeSession(session);
    return session;
  });

  app.delete("/api/sessions/:sessionId", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const localSession = await readSession(sessionId).catch(() => null);
    if (localSession) {
      await rm(jsonPath(sessionsRoot, sessionId), { force: true });
      return { id: sessionId, deleted: true };
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    await rm(jsonPath(sessionsRoot, sessionId), { force: true });
    return { id: sessionId, deleted: true };
  });

  app.get("/api/sessions/:sessionId/messages", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const localSession = await readSession(sessionId).catch(() => null);
    if (localSession) {
      return { session_id: localSession.id, messages: localSession.messages };
    }
    if (baseUrl) {
      return proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: forwardedHermesHeaders(request.headers),
      });
    }

    const session = await readSession(sessionId);
    return { session_id: session.id, messages: session.messages };
  });

  app.post("/api/sessions/:sessionId/fork", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const localParent = await readSession(sessionId).catch(() => null);
    if (localParent) {
      const body = request.body as { title?: string };
      const fork = await createSession({
        title: body.title || `${localParent.title} branch`,
        source: localParent.source,
        parent_id: localParent.id,
      });
      fork.messages = localParent.messages.slice();
      fork.updated_at = new Date().toISOString();
      await writeSession(fork);
      return reply.code(201).send(fork);
    }
    if (baseUrl) {
      const upstreamFork = await proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: "POST",
        headers: forwardedHermesHeaders(request.headers),
        body: JSON.stringify(request.body || {}),
      });
      return withTopLevelSessionId(upstreamFork);
    }

    const parent = await readSession(sessionId);
    const body = request.body as { title?: string };
    const fork = await createSession({
      title: body.title || `${parent.title} branch`,
      source: parent.source,
      parent_id: parent.id,
    });
    fork.messages = parent.messages.slice();
    fork.updated_at = new Date().toISOString();
    await writeSession(fork);
    return reply.code(201).send(fork);
  });

  app.post("/api/sessions/:sessionId/chat", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    if (baseUrl) {
      return proxyJson(baseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
        method: "POST",
        headers: forwardedHermesHeaders(request.headers),
        body: JSON.stringify(request.body || {}),
      });
    }

    const body = request.body as { input?: string; content?: unknown };
    const unsupported = unsupportedContentType(body.content || body.input || "");
    if (unsupported) {
      return reply.code(400).send({ error: unsupported });
    }
    const session = await readSession(sessionId);
    await appendSessionMessage(session, "user", body.input || "");
    const output = managedAssistantText(body.input || "");
    const assistant = await appendSessionMessage(session, "assistant", output);
    return {
      session_id: sessionId,
      message: assistant,
      output,
      status: "completed",
    };
  });

  app.post("/api/sessions/:sessionId/chat/stream", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    if (baseUrl) {
      const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          ...forwardedHermesHeaders(request.headers),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(request.body || {}),
      });
      reply.hijack();
      reply.raw.writeHead(response.status, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
      });
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          reply.raw.write(Buffer.from(chunk));
        }
      }
      reply.raw.end();
      return;
    }

    const body = request.body as { input?: string; content?: unknown };
    const unsupported = unsupportedContentType(body.content || body.input || "");
    if (unsupported) {
      return reply.code(400).send({ error: unsupported });
    }
    const session = await readSession(sessionId);
    await appendSessionMessage(session, "user", body.input || "");
    const output = managedAssistantText(body.input || "");
    const assistant = await appendSessionMessage(session, "assistant", output);
    reply.hijack();
    reply.raw.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    });
    reply.raw.write(sse("assistant.delta", { session_id: sessionId, delta: output }));
    reply.raw.write(sse("tool.started", { name: "managed_session_chat" }));
    reply.raw.write(sse("tool.completed", { name: "managed_session_chat", message_id: assistant.id }));
    reply.raw.write(sse("run.completed", { session_id: sessionId, status: "completed" }));
    reply.raw.end();
  });

  app.get("/api/jobs", async (request) => {
    const jobs = await listJsonFiles<ManagedJob>(jobsRoot);
    return {
      jobs: jobs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      mode: "managed",
    };
  });

  app.post("/api/jobs", async (request, reply) => {
    const body = request.body as {
      prompt?: string;
      schedule?: string;
      skills?: unknown[];
      provider?: string;
      delivery_target?: string;
    };
    const now = new Date().toISOString();
    const job: ManagedJob = {
      job_id: `job_${randomUUID()}`,
      prompt: body.prompt || "",
      schedule: body.schedule || null,
      skills: body.skills || [],
      provider: body.provider || null,
      delivery_target: body.delivery_target || null,
      paused: false,
      last_run_id: null,
      created_at: now,
      updated_at: now,
    };
    await writeJsonFile(jsonPath(jobsRoot, job.job_id), job);
    return reply.code(201).send(job);
  });

  app.get("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    return readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId));
  });

  app.patch("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const current = await readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId));
    const body = request.body as Partial<ManagedJob>;
    const next: ManagedJob = {
      ...current,
      ...body,
      job_id: current.job_id,
      updated_at: new Date().toISOString(),
    };
    await writeJsonFile(jsonPath(jobsRoot, jobId), next);
    return next;
  });

  app.delete("/api/jobs/:jobId", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = await readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId)).catch(() => null);
    if (job?.last_run_id) {
      const run = await readManagedRun(runsRoot, job.last_run_id).catch(() => null);
      if (run && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
        run.status = "cancelled";
        appendRunEvent(run, "run.cancelled", { run_id: run.run_id, reason: "job_deleted" });
        await writeManagedRun(runsRoot, run);
      }
    }
    await rm(jsonPath(jobsRoot, jobId), { force: true });
    return { id: jobId, deleted: true };
  });

  app.post("/api/jobs/:jobId/pause", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = await readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId));
    job.paused = true;
    job.updated_at = new Date().toISOString();
    await writeJsonFile(jsonPath(jobsRoot, jobId), job);
    return job;
  });

  app.post("/api/jobs/:jobId/resume", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = await readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId));
    job.paused = false;
    job.updated_at = new Date().toISOString();
    await writeJsonFile(jsonPath(jobsRoot, jobId), job);
    return job;
  });

  app.post("/api/jobs/:jobId/run", async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = await readJsonFile<ManagedJob>(jsonPath(jobsRoot, jobId));
    const run = await createManagedRun(runsRoot, runnerUrl, {
      input: job.prompt,
      instructions: `Run scheduled job ${job.job_id}`,
      session_id: `job-${job.job_id}`,
    });
    job.last_run_id = run.run_id;
    job.updated_at = new Date().toISOString();
    await writeJsonFile(jsonPath(jobsRoot, jobId), job);
    return { job, run_id: run.run_id, status: run.status };
  });

  app.all("/api/sessions*", async (request) => {
    if (!baseUrl) {
      return { sessions: [], mode: "managed" };
    }

    return proxyJson(baseUrl, request.url, proxyRequestInit(request.method, request.body, request.headers));
  });

  app.all("/api/jobs*", async (request) => {
    if (!baseUrl) {
      return { jobs: [], mode: "managed" };
    }

    return proxyJson(baseUrl, request.url, proxyRequestInit(request.method, request.body, request.headers));
  });

  await app.listen({ host: "0.0.0.0", port: port() });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import type {
  GitHubCloneProjectSummary,
  GitHubConnectionSummary,
  GitHubDeviceLoginPollSummary,
  GitHubDeviceLoginStartSummary,
  GitHubRepositoryGroupSummary,
  HermesCatalogSummary,
  HermesCapabilitySummary,
  HermesListResponse,
  HermesModelsResponse,
  HermesProfilesResponse,
  HermesUpstreamDiagnostics,
  HermesRunSummary,
  PlatformEvent,
  ProjectFolderSummary,
  ProjectSummary,
  ChatMessageSummary,
  CapabilityPackageSummary,
  DeviceCommandLogSummary,
  DeviceCommandSummary,
  DevicePlatform,
  DeviceSummary,
  DeviceTransport,
  TaskRuntimeSummary,
  TaskPlanSummary,
  TaskSummary,
  VerificationResultSummary,
} from "@termes/shared";

export interface HermesStreamEvent {
  event: string;
  data: unknown;
}

export interface TermesAccountPrincipal {
  memberId: string;
  accountId: string;
  displayName: string;
  workspaceKey: string;
  workspaceId: string;
  runtimeCellId: string;
  email: string;
  workspaceRoot: string;
  canManageSharedOAuth: boolean;
  canApproveMembers: boolean;
}

export interface PendingTermesMember {
  memberId: string;
  loginId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export async function fetchTermesSession(): Promise<TermesAccountPrincipal | null> {
  const response = await fetch("/api/account-auth/session");
  const body = await response.json() as { principal?: TermesAccountPrincipal | null; error?: string };
  if (!response.ok) throw new Error(body.error || `Account session failed: ${response.status}`);
  return body.principal || null;
}

export async function loginTermesAccount(loginId: string, password: string): Promise<TermesAccountPrincipal> {
  const response = await fetch("/api/account-auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ loginId, password }),
  });
  const body = await response.json() as { principal?: TermesAccountPrincipal; error?: string };
  if (!response.ok || !body.principal) throw new Error(body.error || `Account login failed: ${response.status}`);
  return body.principal;
}

export async function registerTermesMember(input: {
  displayName: string;
  loginId: string;
  email: string;
  password: string;
}): Promise<void> {
  const response = await fetch("/api/account-auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Member registration failed: ${response.status}`);
}

export async function changeTermesPassword(currentPassword: string, newPassword: string): Promise<void> {
  const response = await fetch("/api/account-auth/password", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (response.ok || response.status === 204) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || `Password change failed: ${response.status}`);
}

export async function fetchPendingTermesMembers(): Promise<PendingTermesMember[]> {
  const response = await fetch("/api/account-auth/members/pending");
  const body = await response.json().catch(() => ({})) as { members?: PendingTermesMember[]; error?: string };
  if (!response.ok) throw new Error(body.error || `Pending members failed: ${response.status}`);
  return body.members || [];
}

export async function approveTermesMember(memberId: string): Promise<void> {
  const response = await fetch(`/api/account-auth/members/${encodeURIComponent(memberId)}/approve`, { method: "POST" });
  if (response.ok || response.status === 204) return;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || `Member approval failed: ${response.status}`);
}

export async function logoutTermesAccount(): Promise<void> {
  const response = await fetch("/api/account-auth/session", { method: "DELETE" });
  if (!response.ok && response.status !== 204) throw new Error(`Account logout failed: ${response.status}`);
}

export interface CodexOAuthDeviceSession {
  id: string;
  status: "starting" | "awaiting_user" | "complete" | "error" | "expired" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  expiresAt: string;
}

export async function fetchOpenAiAccount(): Promise<Record<string, unknown>> {
  const response = await fetch("/api/openai-auth/account");
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || `OpenAI account read failed: ${response.status}`));
  return body;
}

export async function startCodexOAuthLogin(): Promise<CodexOAuthDeviceSession> {
  const response = await fetch("/api/openai-auth/device-sessions", { method: "POST" });
  const body = await response.json() as { session?: CodexOAuthDeviceSession; error?: string };
  if (!response.ok || !body.session) throw new Error(body.error || `Codex OAuth start failed: ${response.status}`);
  return body.session;
}

export async function pollCodexOAuthLogin(sessionId: string): Promise<CodexOAuthDeviceSession> {
  const response = await fetch(`/api/openai-auth/device-sessions/${encodeURIComponent(sessionId)}`);
  const body = await response.json() as { session?: CodexOAuthDeviceSession; error?: string };
  if (!response.ok || !body.session) throw new Error(body.error || `Codex OAuth poll failed: ${response.status}`);
  return body.session;
}

export interface GitHubCloneResult {
  workspaceId: string;
  repositoryFullName: string;
  name: string;
  path: string;
  workspacePath: string;
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch("/api/projects");
  if (!response.ok) {
    throw new Error(`Failed to fetch projects: ${response.status}`);
  }

  const data = (await response.json()) as { projects: ProjectSummary[] };
  return data.projects;
}

export async function createProject(input: {
  key: string;
  name: string;
  description?: string;
  workspacePath?: string;
}): Promise<ProjectSummary> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to create project: ${response.status}`);
  }

  const data = (await response.json()) as { project: ProjectSummary };
  return data.project;
}

export async function fetchGitHubStatus(): Promise<GitHubConnectionSummary> {
  const response = await fetch("/api/github/status");
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub status: ${response.status}`);
  }

  const data = (await response.json()) as { github: GitHubConnectionSummary };
  return data.github;
}

export async function fetchGitHubRepositories(query?: string): Promise<GitHubRepositoryGroupSummary[]> {
  const params = new URLSearchParams();
  if (query?.trim()) {
    params.set("q", query.trim());
  }
  const response = await fetch(`/api/github/repositories${params.size > 0 ? `?${params}` : ""}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch GitHub repositories: ${response.status}`);
  }

  const data = (await response.json()) as { groups: GitHubRepositoryGroupSummary[] };
  return data.groups;
}

export async function disconnectGitHub(): Promise<GitHubConnectionSummary> {
  const response = await fetch("/api/github/oauth/logout", {
    method: "POST",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to disconnect GitHub: ${response.status}`);
  }

  const data = (await response.json()) as { github: GitHubConnectionSummary };
  return data.github;
}

export async function startGitHubDeviceLogin(): Promise<GitHubDeviceLoginStartSummary> {
  const response = await fetch("/api/github/oauth/device/start", {
    method: "POST",
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to start GitHub device login: ${response.status}`);
  }
  return (await response.json()) as GitHubDeviceLoginStartSummary;
}

export async function pollGitHubDeviceLogin(sessionId: string): Promise<GitHubDeviceLoginPollSummary> {
  const response = await fetch("/api/github/oauth/device/poll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const body = JSON.parse(text) as { error?: string };
      message = body.error || text;
    } catch {
      message = text;
    }
    throw new Error(message || `Failed to poll GitHub device login: ${response.status}`);
  }
  return (await response.json()) as GitHubDeviceLoginPollSummary;
}

export async function createProjectFolder(input: {
  parentPath?: string;
  name: string;
}): Promise<{ workspaceId: string; name: string; path: string; absolutePath: string }> {
  const response = await fetch("/api/projects/folder/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to create project folder: ${response.status}`);
  }

  return (await response.json()) as { workspaceId: string; name: string; path: string; absolutePath: string };
}

export async function fetchProjectFolders(): Promise<ProjectFolderSummary[]> {
  const response = await fetch("/api/projects/folders");
  if (!response.ok) {
    throw new Error(`Failed to fetch project folders: ${response.status}`);
  }

  const data = (await response.json()) as { folders: ProjectFolderSummary[] };
  return data.folders;
}

export async function cloneGitHubRepository(input: {
  repositoryFullName: string;
  parentPath?: string;
}): Promise<GitHubCloneResult> {
  const response = await fetch("/api/projects/clone", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to clone GitHub repository: ${response.status}`);
  }

  return (await response.json()) as GitHubCloneResult;
}

export async function registerProjectFolder(input: {
  path: string;
  name?: string;
}): Promise<{ project: ProjectSummary; path: string; workspacePath: string }> {
  const response = await fetch("/api/projects/folder", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to register project folder: ${response.status}`);
  }

  return (await response.json()) as { project: ProjectSummary; path: string; workspacePath: string };
}

export async function cloneGitHubProject(input: {
  repositoryFullName: string;
  parentPath?: string;
}): Promise<GitHubCloneProjectSummary> {
  const response = await fetch("/api/projects/github-clone", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to clone GitHub project: ${response.status}`);
  }

  return (await response.json()) as GitHubCloneProjectSummary;
}

export async function updateProject(
  projectId: string,
  input: { name?: string; description?: string | null },
): Promise<ProjectSummary> {
  const response = await fetch(`/api/projects/${projectId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to update project: ${response.status}`);
  }

  const data = (await response.json()) as { project: ProjectSummary };
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${projectId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to delete project: ${response.status}`);
  }
}

export async function fetchTasks(projectId?: string): Promise<TaskSummary[]> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }

  const response = await fetch(`/api/tasks${params.size > 0 ? `?${params}` : ""}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${response.status}`);
  }

  const data = (await response.json()) as { tasks: TaskSummary[] };
  return data.tasks;
}

export async function updateTask(
  taskId: string,
  input: { title?: string; instructions?: string; status?: string },
): Promise<TaskSummary> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to update task: ${response.status}`);
  }

  const data = (await response.json()) as { task: TaskSummary };
  return data.task;
}

export async function deleteTask(taskId: string): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to delete task: ${response.status}`);
  }
}

export async function createTask(input: {
  projectId: string;
  title: string;
  instructions: string;
}): Promise<TaskSummary> {
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(`Failed to create task: ${response.status}`);
  }

  const data = (await response.json()) as { task: TaskSummary };
  return data.task;
}

export async function fetchTaskMessages(taskId: string): Promise<ChatMessageSummary[]> {
  const response = await fetch(`/api/tasks/${taskId}/messages`);
  if (!response.ok) {
    throw new Error(`Failed to fetch task messages: ${response.status}`);
  }

  const data = (await response.json()) as { messages: ChatMessageSummary[] };
  return data.messages;
}

export async function sendTaskMessage(taskId: string, content: string): Promise<ChatMessageSummary[]> {
  const response = await fetch(`/api/tasks/${taskId}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to send task message: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  const data = (await response.json()) as { messages: ChatMessageSummary[] };
  return data.messages;
}

export type HermesInteractionResponse =
  | { type: "approval"; choice: "once" | "session" | "always" | "deny" }
  | { type: "clarify"; requestId: string; answer: string }
  | { type: "sudo"; requestId: string; password: string }
  | { type: "secret"; requestId: string; value: string };

export async function respondHermesInteraction(
  taskId: string,
  input: HermesInteractionResponse,
): Promise<{ status: "ok"; resolved?: number }> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/hermes-interactions/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({})) as { status?: "ok"; resolved?: number; error?: string };
  if (!response.ok || body.status !== "ok") {
    throw new Error(body.error || `Hermes interaction response failed: ${response.status}`);
  }
  return { status: body.status, ...(body.resolved === undefined ? {} : { resolved: body.resolved }) };
}

export async function fetchHermesCapabilities(): Promise<HermesCapabilitySummary> {
  const response = await fetch("/api/runtime/hermes");
  if (!response.ok) {
    throw new Error(`Failed to fetch Hermes runtime: ${response.status}`);
  }

  return (await response.json()) as HermesCapabilitySummary;
}

export async function fetchDevices(projectId?: string): Promise<DeviceSummary[]> {
  const params = new URLSearchParams();
  if (projectId) {
    params.set("projectId", projectId);
  }
  const response = await fetch(`/api/devices${params.size > 0 ? `?${params}` : ""}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch devices: ${response.status}`);
  }
  const data = (await response.json()) as { devices: DeviceSummary[] };
  return data.devices;
}

export async function discoverDevices(projectId?: string): Promise<DeviceSummary[]> {
  const response = await fetch("/api/devices/discover", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(projectId ? { projectId } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to discover devices: ${response.status}`);
  }
  const data = (await response.json()) as { devices: DeviceSummary[] };
  return data.devices;
}

export async function createDevice(input: {
  projectId?: string;
  key?: string;
  name: string;
  platform: DevicePlatform;
  transport: DeviceTransport;
  endpoint?: string | null;
  labels?: Record<string, string>;
  status?: string;
}): Promise<DeviceSummary> {
  const response = await fetch("/api/devices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to create device: ${response.status}`);
  }
  const data = (await response.json()) as { device: DeviceSummary };
  return data.device;
}

export async function updateDevice(
  deviceId: string,
  input: {
    name?: string;
    transport?: DeviceTransport;
    endpoint?: string | null;
    labels?: Record<string, string>;
    status?: string;
  },
): Promise<DeviceSummary> {
  const response = await fetch(`/api/devices/${deviceId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to update device: ${response.status}`);
  }
  const data = (await response.json()) as { device: DeviceSummary };
  return data.device;
}

export async function deleteDevice(deviceId: string): Promise<void> {
  const response = await fetch(`/api/devices/${deviceId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to delete device: ${response.status}`);
  }
}

export async function runDeviceCommand(
  deviceId: string,
  input: {
    taskId?: string | null;
    action: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  },
): Promise<{ command: DeviceCommandSummary; verificationResult?: VerificationResultSummary }> {
  const response = await fetch(`/api/devices/${deviceId}/commands`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to run device command: ${response.status}`);
  }
  return (await response.json()) as { command: DeviceCommandSummary; verificationResult?: VerificationResultSummary };
}

export async function fetchDeviceCommand(commandId: string): Promise<DeviceCommandSummary> {
  const response = await fetch(`/api/device-commands/${commandId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch device command: ${response.status}`);
  }
  const data = (await response.json()) as { command: DeviceCommandSummary };
  return data.command;
}

export async function fetchDeviceCommandLogs(commandId: string): Promise<DeviceCommandLogSummary> {
  const response = await fetch(`/api/device-commands/${commandId}/logs`);
  if (!response.ok) {
    throw new Error(`Failed to fetch device command logs: ${response.status}`);
  }
  return (await response.json()) as DeviceCommandLogSummary;
}

export async function fetchCapabilities(): Promise<CapabilityPackageSummary[]> {
  const response = await fetch("/api/capabilities");
  if (!response.ok) {
    throw new Error(`Failed to fetch capabilities: ${response.status}`);
  }
  const data = (await response.json()) as { capabilities: CapabilityPackageSummary[] };
  return data.capabilities;
}

export async function fetchTaskPlan(taskId: string): Promise<TaskPlanSummary | null> {
  const response = await fetch(`/api/tasks/${taskId}/plan`);
  if (!response.ok) {
    throw new Error(`Failed to fetch task plan: ${response.status}`);
  }
  const data = (await response.json()) as { taskPlan: TaskPlanSummary | null };
  return data.taskPlan;
}

export async function fetchVerificationResults(taskId: string): Promise<VerificationResultSummary[]> {
  const response = await fetch(`/api/tasks/${taskId}/verification-results`);
  if (!response.ok) {
    throw new Error(`Failed to fetch verification results: ${response.status}`);
  }
  const data = (await response.json()) as { verificationResults: VerificationResultSummary[] };
  return data.verificationResults;
}

async function hermesGet<T>(path: string): Promise<T> {
  const response = await fetch(`/api/hermes${path}`);
  if (!response.ok) {
    throw new Error(`Hermes request failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function hermesPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/hermes${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Hermes request failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function hermesPatch<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/hermes${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Hermes request failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function hermesDelete<T>(path: string): Promise<T> {
  const response = await fetch(`/api/hermes${path}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Hermes request failed ${path}: ${response.status}`);
  }

  return (await response.json()) as T;
}

async function readHermesStream(
  response: Response,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`Hermes stream failed: ${response.status}`);
  }
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function emit(rawBlock: string): void {
    const lines = rawBlock.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const dataText = dataLines.join("\n");
    if (!dataText) {
      return;
    }
    if (dataText === "[DONE]") {
      onEvent({ event: "done", data: "[DONE]" });
      return;
    }

    try {
      onEvent({ event, data: JSON.parse(dataText) as unknown });
    } catch {
      onEvent({ event, data: dataText });
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      emit(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    emit(buffer);
  }
}

async function hermesPostStream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/hermes${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });
  await readHermesStream(response, onEvent);
}

async function hermesGetStream(
  path: string,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  const response = await fetch(`/api/hermes${path}`, {
    headers: {
      accept: "text/event-stream",
    },
  });
  await readHermesStream(response, onEvent);
}

function listData(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data;
    }
  }

  return [];
}

export async function fetchHermesCatalog(includeGlobalAdminState = true): Promise<HermesCatalogSummary> {
  const [capabilities, models, skills, toolsets] = await Promise.all([
    fetchHermesCapabilities(),
    hermesGet<HermesModelsResponse>("/v1/models"),
    hermesGet<unknown>("/v1/skills"),
    hermesGet<unknown>("/v1/toolsets"),
  ]);
  const [profiles, sessions, jobs] = includeGlobalAdminState
    ? await Promise.all([
        hermesGet<HermesProfilesResponse>("/profiles"),
        hermesGet<HermesListResponse>("/api/sessions"),
        hermesGet<HermesListResponse>("/api/jobs"),
      ])
    : [{ profiles: [] }, { sessions: [] }, { jobs: [] }];

  return {
    capabilities,
    profiles,
    models,
    skills: listData(skills),
    toolsets: listData(toolsets),
    sessions,
    jobs,
  };
}

export async function fetchHermesRun(runId: string): Promise<HermesRunSummary> {
  return hermesGet<HermesRunSummary>(`/v1/runs/${encodeURIComponent(runId)}`);
}

export async function fetchHermesHealthDetailed(): Promise<Record<string, unknown>> {
  return hermesGet<Record<string, unknown>>("/health/detailed");
}

export async function fetchHermesUpstreamDiagnostics(): Promise<HermesUpstreamDiagnostics> {
  return hermesGet<HermesUpstreamDiagnostics>("/upstream/diagnostics");
}

export async function createHermesChatCompletion(input: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/v1/chat/completions", {
    model: "hermes-agent",
    messages: [{ role: "user", content: input }],
  });
}

export async function streamHermesChatCompletion(
  input: string,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  await hermesPostStream(
    "/v1/chat/completions",
    {
      model: "hermes-agent",
      messages: [{ role: "user", content: input }],
      stream: true,
    },
    onEvent,
  );
}

export async function createHermesResponse(
  input: string,
  previousResponseId?: string | null,
): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/v1/responses", {
    model: "hermes-agent",
    input,
    conversation: "termes-mobile",
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
  });
}

export async function streamHermesResponse(
  input: string,
  previousResponseId: string | null,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  await hermesPostStream(
    "/v1/responses",
    {
      model: "hermes-agent",
      input,
      conversation: "termes-mobile",
      stream: true,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    },
    onEvent,
  );
}

export async function deleteHermesResponse(responseId: string): Promise<Record<string, unknown>> {
  return hermesDelete<Record<string, unknown>>(`/v1/responses/${encodeURIComponent(responseId)}`);
}

export async function createHermesRun(input: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/v1/runs", {
    input,
    instructions: "Run from the Termes mobile Hermes panel.",
    metadata: {
      source: "termes-mobile",
    },
  });
}

export async function streamHermesRunEvents(
  runId: string,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  await hermesGetStream(`/v1/runs/${encodeURIComponent(runId)}/events`, onEvent);
}

export async function stopHermesRun(runId: string): Promise<{ status: string }> {
  return hermesPost<{ status: string }>(`/v1/runs/${encodeURIComponent(runId)}/stop`);
}

export async function createHermesProfile(name: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/profiles", {
    name,
    codexRuntimeEnabled: true,
  });
}

export async function deleteHermesProfile(name: string): Promise<Record<string, unknown>> {
  return hermesDelete<Record<string, unknown>>(`/profiles/${encodeURIComponent(name)}`);
}

export async function resolveHermesApproval(
  runId: string,
  decision: "approved" | "rejected",
): Promise<{ status: string }> {
  return hermesPost<{ status: string }>(`/v1/runs/${encodeURIComponent(runId)}/approval`, {
    decision,
    approved: decision === "approved",
  });
}

export async function createHermesSession(title: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/api/sessions", { title, source: "termes-mobile" });
}

export async function updateHermesSession(
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return hermesPatch<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}`, body);
}

export async function deleteHermesSession(sessionId: string): Promise<Record<string, unknown>> {
  return hermesDelete<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function forkHermesSession(sessionId: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
    title: "Mobile Hermes branch",
  });
}

export async function sendHermesSessionChat(
  sessionId: string,
  input: string,
): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, { input });
}

export async function streamHermesSessionChat(
  sessionId: string,
  input: string,
  onEvent: (event: HermesStreamEvent) => void,
): Promise<void> {
  await hermesPostStream(
    `/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    { input },
    onEvent,
  );
}

export async function createHermesJob(prompt: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>("/api/jobs", {
    prompt,
    schedule: "manual",
    skills: ["termes-orchestration"],
    delivery_target: "mobile",
  });
}

export async function runHermesJob(jobId: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}/run`);
}

export async function updateHermesJob(
  jobId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return hermesPatch<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}`, body);
}

export async function pauseHermesJob(jobId: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}/pause`);
}

export async function resumeHermesJob(jobId: string): Promise<Record<string, unknown>> {
  return hermesPost<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}/resume`);
}

export async function deleteHermesJob(jobId: string): Promise<Record<string, unknown>> {
  return hermesDelete<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchTaskRuntime(taskId: string): Promise<TaskRuntimeSummary> {
  const response = await fetch(`/api/tasks/${taskId}/runtime`);
  if (!response.ok) {
    throw new Error(`Failed to fetch task runtime: ${response.status}`);
  }

  return (await response.json()) as TaskRuntimeSummary;
}

export function connectEvents(onEvent: (event: PlatformEvent) => void): EventSource {
  const source = new EventSource("/events/stream");

  const eventTypes = [
    "project.created",
    "project.updated",
    "project.deleted",
    "task.created",
    "task.updated",
    "task.deleted",
    "task.started",
    "agent.created",
    "agent.started",
    "agent.delta",
    "agent.tool.started",
    "agent.tool.completed",
    "agent.command.started",
    "agent.command.completed",
    "agent.file.changed",
    "hermes.projection.updated",
    "checkpoint.created",
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "chat.message.created",
    "chat.message.completed",
    "task.plan.created",
    "task.plan.step.started",
    "task.plan.step.completed",
    "task.plan.step.failed",
    "device.command.created",
    "device.command.queued",
    "device.command.running",
    "device.command.completed",
    "device.command.failed",
    "device.command.blocked",
    "verification.created",
    "task.completed",
    "task.failed",
  ];

  for (const type of eventTypes) {
    source.addEventListener(type, (message) => {
      onEvent(JSON.parse((message as MessageEvent<string>).data) as PlatformEvent);
    });
  }

  return source;
}

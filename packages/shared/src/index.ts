export const TERMES_VERSION = "0.1.0";

export const taskStatuses = [
  "created",
  "queued",
  "running",
  "reviewing",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export const eventTypes = [
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
  "checkpoint.created",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "chat.message.created",
  "chat.message.completed",
  "task.completed",
  "task.failed",
] as const;

export type EventType = (typeof eventTypes)[number];

export interface HealthReport {
  service: string;
  version: string;
  status: "ok";
  checkedAt: string;
  dependencies?: Record<string, "ok">;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubConnectionSummary {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  linkedAt: string | null;
  oauthConfigured: boolean;
  callbackUrl: string;
}

export interface GitHubRepositorySummary {
  owner: string;
  name: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
}

export interface GitHubRepositoryGroupSummary {
  groupId: string;
  label: string;
  owner: string;
  scope: "personal" | "group";
  repositories: GitHubRepositorySummary[];
  error?: string;
}

export interface GitHubCloneProjectSummary {
  project: ProjectSummary;
  repositoryFullName: string;
  workspacePath: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  instructions: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  projectId: string | null;
  taskId: string | null;
  type: EventType;
  payload: TPayload;
  createdAt: string;
}

export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessageSummary {
  id: string;
  projectId: string;
  taskId: string;
  role: ChatMessageRole;
  source: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeProfileSummary {
  id: string;
  projectId: string;
  name: string;
  hermesHome: string;
  codexHome: string;
  codexRuntimeEnabled: boolean;
  createdAt: string;
}

export interface RuntimeSessionSummary {
  id: string;
  taskId: string;
  runtimeProfileId: string | null;
  hermesSessionId: string | null;
  hermesRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunSummary {
  id: string;
  taskId: string;
  soulId: string | null;
  runtimeSessionId: string | null;
  status: "created" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  branchName: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointSummary {
  id: string;
  taskId: string;
  agentRunId: string | null;
  summary: string;
  gitCommitSha: string | null;
  snapshotUri: string | null;
  checksum: string | null;
  changedFiles: unknown[];
  testResult: Record<string, unknown>;
  createdAt: string;
}

export interface ArtifactSummary {
  id: string;
  projectId: string | null;
  taskId: string | null;
  kind: string;
  uri: string;
  checksum: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TaskRuntimeSummary {
  task: TaskSummary;
  messages: ChatMessageSummary[];
  sessions: RuntimeSessionSummary[];
  runs: AgentRunSummary[];
  checkpoints: CheckpointSummary[];
  artifacts: ArtifactSummary[];
  events: PlatformEvent[];
}

export interface HermesCapabilitySummary {
  manager: {
    status: "ok";
    profilesRoot: string;
    codexHomesRoot: string;
    runsRoot: string;
    upstreamConfigured: boolean;
    runnerConfigured?: boolean;
    upstreamStatus?: "not_configured" | "ok" | "error";
    upstreamError?: string;
    upstreamDiagnostics?: HermesUpstreamDiagnostics;
  };
  upstream: Record<string, unknown> | null;
  features: Record<string, boolean>;
}

export interface HermesUpstreamDiagnostics {
  baseUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  upstreamStatus: "not_configured" | "ok" | "error";
  upstreamError?: string;
  officialAgentUrlConfigured: boolean;
  officialAgentStatus: "not_configured" | "ok" | "error";
  officialAgentError?: string;
  providerKeys: Record<string, boolean>;
  oauthProviders?: Record<string, boolean>;
  codex?: {
    required: boolean;
    home: string;
    authConfigured: boolean;
    hermesAuthConfigured: boolean;
    modelProvider: string | null;
    model: string | null;
    openaiRuntime: string | null;
    appServerRuntimeConfigured: boolean;
    ready: boolean;
  };
  localProviderKeyRequired: boolean;
  ready: boolean;
  required: string[];
}

export interface HermesProfilesResponse {
  profiles: string[];
}

export interface HermesModelSummary {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface HermesModelsResponse {
  object: string;
  data: HermesModelSummary[];
}

export interface HermesRunSummary {
  object?: string;
  run_id: string;
  status: string;
  session_id?: string;
  model?: string;
  output?: string;
  usage?: Record<string, unknown>;
  artifact_uri?: string;
  checksum?: string;
  created_at?: string;
  updated_at?: string;
}

export interface HermesListResponse<T = Record<string, unknown>> {
  mode?: string;
  sessions?: T[];
  jobs?: T[];
  data?: T[];
}

export interface HermesCatalogSummary {
  capabilities: HermesCapabilitySummary;
  profiles: HermesProfilesResponse;
  models: HermesModelsResponse;
  skills: unknown[];
  toolsets: unknown[];
  sessions: HermesListResponse;
  jobs: HermesListResponse;
}

export function assertTaskStatus(value: string): TaskStatus {
  if (taskStatuses.includes(value as TaskStatus)) {
    return value as TaskStatus;
  }

  throw new Error(`Unsupported task status: ${value}`);
}

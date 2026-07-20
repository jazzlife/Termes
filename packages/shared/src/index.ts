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
  "hermes.projection.updated",
  "checkpoint.created",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "chat.message.created",
  "chat.message.completed",
  "task.turn.requested",
  "routing.started",
  "routing.ready",
  "routing.decided",
  "routing.failed",
  "execution.direct.started",
  "execution.specialists.planned",
  "execution.escalated",
  "task.turn.completed",
  "task.turn.failed",
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
] as const;

export type EventType = (typeof eventTypes)[number];

export const devicePlatforms = ["android", "tizen", "linux", "windows", "local_mock"] as const;
export type DevicePlatform = (typeof devicePlatforms)[number];

export const deviceTransports = ["adb", "sdb", "ssh", "winrm", "local_mock"] as const;
export type DeviceTransport = (typeof deviceTransports)[number];

export const deviceStatuses = ["unknown", "offline", "online", "busy", "error"] as const;
export type DeviceStatus = (typeof deviceStatuses)[number];

export const deviceCommandStatuses = [
  "created",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "blocked",
] as const;
export type DeviceCommandStatus = (typeof deviceCommandStatuses)[number];

export const verificationStatuses = ["passed", "failed", "warning", "unknown"] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];

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

export interface ProjectFolderSummary {
  path: string;
  name: string;
  type: "directory";
  depth: number;
}

export interface GitHubConnectionSummary {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  linkedAt: string | null;
  oauthConfigured: boolean;
  browserOAuthEnabled: boolean;
  deviceConfigured: boolean;
  callbackUrl: string;
}

export interface GitHubDeviceLoginStartSummary {
  configured: boolean;
  message: string;
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresAt: string;
  interval: number;
  scope: string;
}

export interface GitHubDeviceLoginPollSummary {
  status: "pending" | "complete";
  message: string;
  nextInterval: number | null;
  github: GitHubConnectionSummary;
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

export type RouteIntent = "conversation" | "question" | "analysis" | "implementation" | "operation" | "destructive" | "control";
export type ExecutionRoute = "system-control" | "instant" | "direct" | "single-specialist" | "parallel-specialists" | "critical-synthesis" | "clarification";
export type TaskTurnStatus = "requested" | "routing" | "routed" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface SemanticFrameSummary {
  action: "converse" | "read" | "analyze" | "implement" | "operate" | "delete" | "control" | "clarify";
  target: "project.identity" | "workspace.identity" | "system.status" | "code" | "runtime" | "data" | "security" | "product" | "research" | "general" | "unknown";
  scope: "current-turn" | "recent-summary" | "project-state" | "system-context";
  requiresMutation: boolean;
  requiresInspection: boolean;
  primaryDomain: string;
  secondaryDomains: string[];
  riskSignals: string[];
  reasonCodes: string[];
}

export interface RouteDecisionSummary {
  intent: RouteIntent;
  route: ExecutionRoute;
  primaryDomain: string;
  secondaryDomains: string[];
  riskSignals: string[];
  evidenceRequirement: "none" | "context" | "tool" | "independent-review";
  contextRequirement: "current-turn" | "recent-summary" | "project-state";
  reasonCodes: string[];
  source: "deterministic-policy" | "routing-specialist";
  routingDurationMs: number;
  semanticFrame?: SemanticFrameSummary;
}

export interface TaskTurnSummary {
  id: string;
  taskId: string;
  userMessageId: string;
  status: TaskTurnStatus;
  failureCode: string | null;
  createdAt: string;
  completedAt: string | null;
  decision: RouteDecisionSummary | null;
}

export interface PlatformEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  projectId: string | null;
  taskId: string | null;
  type: EventType;
  payload: TPayload;
  createdAt: string;
}

export interface DeviceSummary {
  id: string;
  projectId: string;
  key: string;
  name: string;
  platform: DevicePlatform;
  transport: DeviceTransport;
  endpoint: string | null;
  labels: Record<string, string>;
  status: DeviceStatus;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCommandSummary {
  id: string;
  projectId: string;
  taskId: string | null;
  deviceId: string;
  action: string;
  params: Record<string, unknown>;
  status: DeviceCommandStatus;
  approvalId: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  artifactUri: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceCommandLogSummary {
  commandId: string;
  stdout: string;
  stderr: string;
  artifactUri: string | null;
}

export interface CapabilityPackageSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  platforms: DevicePlatform[];
  actions: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskPlanStepSummary {
  id: string;
  type: "hermes.run" | "runner.run" | "device.command" | "approval.required" | "verification.check";
  title: string;
  status: "created" | "running" | "completed" | "failed" | "blocked";
  capabilityKey: string | null;
  deviceCommandId: string | null;
  verificationResultId: string | null;
  order: number;
}

export interface TaskPlanSummary {
  id: string;
  taskId: string;
  selectedCapabilities: string[];
  steps: TaskPlanStepSummary[];
  status: "created" | "running" | "completed" | "failed" | "blocked";
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResultSummary {
  id: string;
  projectId: string | null;
  taskId: string | null;
  deviceCommandId: string | null;
  kind: string;
  status: VerificationStatus;
  confidence: number;
  summary: string;
  metadata: Record<string, unknown>;
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
  hermesLiveSessionId: string | null;
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

export interface SpecialistAssignmentSummary {
  id: string;
  key: string;
  role: string;
  mission: string;
  toolsets: string[];
  required: boolean;
  status: "planned" | "running" | "completed" | "failed" | "cancelled";
  hermesSubagentId: string | null;
  resultSummary: string | null;
}

export interface OrchestrationBlueprintSummary {
  id: string;
  domain: "software" | "security" | "operations" | "data" | "research" | "product" | "general";
  secondaryDomains: string[];
  weight: "light" | "standard" | "heavy" | "critical";
  riskSignals: string[];
  collaboration: "direct" | "parallel-review" | "parallel-synthesis";
  requireEvidence: boolean;
  requireIndependentReview: boolean;
  status: "planned" | "delegating" | "synthesizing" | "verified" | "failed";
  specialists: SpecialistAssignmentSummary[];
}

export type HermesProjectionPartSummary =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: Record<string, unknown>;
      isError?: boolean;
    };

export type HermesPendingInteractionSummary =
  | { type: "clarify"; requestId: string; question: string; choices: string[] | null }
  | { type: "approval"; command: string; description: string; allowPermanent: boolean }
  | { type: "sudo"; requestId: string }
  | { type: "secret"; requestId: string; envVar: string; prompt: string };

export interface HermesSessionProjectionSummary {
  sessionId: string;
  parts: HermesProjectionPartSummary[];
  pending: boolean;
  busy: boolean;
  needsInput: boolean;
  interaction: HermesPendingInteractionSummary | null;
  error: string | null;
  updatedAt: string;
}

export interface TaskRuntimeSummary {
  task: TaskSummary;
  messages: ChatMessageSummary[];
  turns?: TaskTurnSummary[];
  sessions: RuntimeSessionSummary[];
  runs: AgentRunSummary[];
  checkpoints: CheckpointSummary[];
  artifacts: ArtifactSummary[];
  events: PlatformEvent[];
  taskPlan?: TaskPlanSummary | null;
  verificationResults?: VerificationResultSummary[];
  orchestration?: OrchestrationBlueprintSummary | null;
  hermesProjection?: HermesSessionProjectionSummary | null;
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

export function assertDevicePlatform(value: string): DevicePlatform {
  if (devicePlatforms.includes(value as DevicePlatform)) {
    return value as DevicePlatform;
  }

  throw new Error(`Unsupported device platform: ${value}`);
}

export function assertDeviceTransport(value: string): DeviceTransport {
  if (deviceTransports.includes(value as DeviceTransport)) {
    return value as DeviceTransport;
  }

  throw new Error(`Unsupported device transport: ${value}`);
}

export function assertDeviceStatus(value: string): DeviceStatus {
  if (deviceStatuses.includes(value as DeviceStatus)) {
    return value as DeviceStatus;
  }

  throw new Error(`Unsupported device status: ${value}`);
}

export function assertDeviceCommandStatus(value: string): DeviceCommandStatus {
  if (deviceCommandStatuses.includes(value as DeviceCommandStatus)) {
    return value as DeviceCommandStatus;
  }

  throw new Error(`Unsupported device command status: ${value}`);
}

export function assertVerificationStatus(value: string): VerificationStatus {
  if (verificationStatuses.includes(value as VerificationStatus)) {
    return value as VerificationStatus;
  }

  throw new Error(`Unsupported verification status: ${value}`);
}

import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Command,
  FileCode2,
  Files,
  FolderOpen,
  FolderPlus,
  Github,
  GitBranch,
  History,
  Loader2,
  LogOut,
  Menu,
  Mic,
  MicOff,
  Moon,
  MessageSquare,
  PanelRight,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Trash2,
  UserCircle2,
  Wifi,
  X,
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import remarkGfm from "remark-gfm";
import { decideMaximumAutonomyApproval, maximumAutonomyPolicy } from "@termes/shared";
import type {
  CapabilityPackageSummary,
  DeviceCommandSummary,
  DevicePlatform,
  DeviceStatus,
  DeviceSummary,
  DeviceTransport,
  EventType,
  GitHubConnectionSummary,
  GitHubDeviceLoginStartSummary,
  GitHubRepositoryGroupSummary,
  HermesCatalogSummary,
  HermesCapabilitySummary,
  HermesRunSummary,
  HermesUpstreamDiagnostics,
  PlatformEvent,
  ProjectFolderSummary,
  ProjectSummary,
  ChatMessageSummary,
  TaskPlanSummary,
  TaskRuntimeSummary,
  TaskSummary,
  VerificationResultSummary,
} from "@termes/shared";
import {
  connectEvents,
  approveTermesMember,
  changeTermesPassword,
  cloneGitHubProject,
  createDevice,
  createHermesChatCompletion,
  createHermesJob,
  createHermesProfile,
  createHermesResponse,
  createHermesRun,
  createHermesSession,
  createProject,
  createProjectFolder,
  createTask,
  deleteDevice,
  deleteProject,
  deleteHermesJob,
  deleteHermesProfile,
  deleteHermesResponse,
  deleteHermesSession,
  deleteTask,
  discoverDevices,
  disconnectGitHub,
  fetchCapabilities,
  fetchDeviceCommandLogs,
  fetchDevices,
  fetchGitHubRepositories,
  fetchGitHubStatus,
  fetchHermesCatalog,
  fetchHermesCapabilities,
  fetchHermesHealthDetailed,
  fetchProjectFolders,
  fetchHermesRun,
  fetchHermesUpstreamDiagnostics,
  fetchOpenAiAccount,
  fetchPendingTermesMembers,
  fetchTermesSession,
  fetchProjects,
  fetchTaskPlan,
  fetchTaskRuntime,
  fetchTasks,
  fetchVerificationResults,
  forkHermesSession,
  pauseHermesJob,
  pollGitHubDeviceLogin,
  pollCodexOAuthLogin,
  loginTermesAccount,
  logoutTermesAccount,
  registerTermesMember,
  resolveHermesApproval,
  resumeHermesJob,
  runDeviceCommand,
  runHermesJob,
  startGitHubDeviceLogin,
  startCodexOAuthLogin,
  registerProjectFolder,
  respondHermesInteraction,
  sendTaskMessage,
  sendHermesSessionChat,
  stopHermesRun,
  streamHermesChatCompletion,
  updateDevice,
  type HermesStreamEvent,
  type CodexOAuthDeviceSession,
  type PendingTermesMember,
  type TermesAccountPrincipal,
  streamHermesResponse,
  streamHermesRunEvents,
  streamHermesSessionChat,
  updateHermesJob,
  updateHermesSession,
  updateProject,
  updateTask,
} from "./api";
import { HermesRealtimeClient } from "./hermes-realtime-client";
import { ApprovalGate } from "./components/ApprovalGate";
import { DesktopConnectorSection } from "./features/desktop-connectors/DesktopConnectorSection";
import { resolveExistingSelectionId } from "./selection-state";
import { readExperienceEnvironment, resolveExperience, type ExperienceKind } from "./app/experience";
import { readStoredTheme, resolveTheme, THEME_STORAGE_KEY, type ThemeMode } from "./app/theme";
import { shouldSubmitChatOnEnter } from "./experiences/chat-composer";
import { MobileExperience, type MobileScreen } from "./experiences/mobile/MobileExperience";
import {
  bootstrapTermesPwa,
  dismissTermesPwaInstallPrompt,
  isIosPwaInstallCandidate,
  isTermesPwaInstallPromptDismissed,
  isTermesPwaStandalone,
  type TermesBeforeInstallPromptEvent,
  type TermesPwaInstallMode,
} from "./pwa";
import "./styles.css";

type WorkbenchTab = "diff" | "terminal" | "files" | "logs" | "hermes";
type MobileView = "list" | "chat" | "workbench";
type ProjectFolderCreateTarget = "folder" | "github";

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const workbenchTabs: Array<{ id: WorkbenchTab; label: string }> = [
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
  { id: "files", label: "Files" },
  { id: "logs", label: "Logs" },
  { id: "hermes", label: "Hermes" },
];

function isRenderableChatMessage(message: ChatMessageSummary): boolean {
  return (message.role === "user" || message.role === "assistant") && message.content.trim().length > 0;
}

function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="markdownMessage">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

const devicePlatforms: DevicePlatform[] = ["local_mock", "windows", "macos", "linux", "android", "tizen"];
const deviceStatusFilters: Array<DeviceStatus | "all"> = ["all", "online", "unknown", "busy", "offline", "error"];

function devicePlatformLabel(platform: DevicePlatform): string {
  const labels: Record<DevicePlatform, string> = {
    local_mock: "Local",
    windows: "Windows",
    macos: "macOS",
    linux: "Linux",
    android: "Android",
    tizen: "Tizen",
  };
  return labels[platform];
}

function transportOptions(platform: DevicePlatform): DeviceTransport[] {
  const options: Record<DevicePlatform, DeviceTransport[]> = {
    local_mock: ["local_mock"],
    windows: ["winrm", "ssh", "connector"],
    macos: ["connector"],
    linux: ["ssh"],
    android: ["adb"],
    tizen: ["sdb"],
  };
  return options[platform];
}

function defaultActionForPlatform(platform: DevicePlatform): string {
  const actions: Record<DevicePlatform, string> = {
    local_mock: "local_mock.echo",
    windows: "windows.system.info",
    macos: "macos.system.info",
    linux: "linux.system.info",
    android: "android.system.info",
    tizen: "tizen.system.info",
  };
  return actions[platform];
}

function quickActionsForPlatform(platform: DevicePlatform): string[] {
  const actions: Record<DevicePlatform, string[]> = {
    local_mock: ["local_mock.echo", "local_mock.health", "local_mock.fail", "local_mock.sleep"],
    windows: ["windows.system.info", "windows.process.list", "windows.screen.capture", "windows.accessibility.snapshot", "windows.logs.query", "windows.debug.process"],
    macos: ["macos.system.info", "macos.process.list", "macos.screen.capture", "macos.accessibility.snapshot", "macos.logs.query", "macos.debug.process"],
    linux: ["linux.system.info", "linux.service.status", "linux.journal.query", "linux.shell"],
    android: ["android.system.info", "android.logcat", "android.shell"],
    tizen: ["tizen.system.info", "tizen.dlog", "tizen.shell"],
  };
  return actions[platform];
}

function defaultParamsForAction(action: string): string {
  if (action === "local_mock.echo") {
    return JSON.stringify({ payload: "hello from Termes" }, null, 2);
  }
  if (action === "local_mock.sleep") {
    return JSON.stringify({ ms: 250 }, null, 2);
  }
  if (action.endsWith(".service.status")) {
    return JSON.stringify({ service: "ssh" }, null, 2);
  }
  if (action === "linux.journal.query") {
    return JSON.stringify({ unit: "ssh", lines: 80 }, null, 2);
  }
  if (action === "windows.eventlog.query") {
    return JSON.stringify({ logName: "System", maxEvents: 20 }, null, 2);
  }
  if (action === "android.logcat" || action === "tizen.dlog") {
    return JSON.stringify({ lines: 80 }, null, 2);
  }
  if (action.endsWith(".shell") || action.endsWith(".powershell")) {
    return JSON.stringify({ command: "echo Termes" }, null, 2);
  }
  return "{}";
}

function dangerousDeviceCommandReason(action: string, paramsText: string): string | null {
  const joined = `${action} ${paramsText}`.toLowerCase();
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
  const match = patterns.find((pattern) => joined.includes(pattern));
  return match ? `Blocked dangerous command pattern: ${match}` : null;
}

const fileTree = [
  "apps/web/src/main.tsx",
  "apps/web/src/styles.css",
  "apps/api/src/server.ts",
  "services/orchestrator/src/main.ts",
  "infra/compose/docker-compose.yml",
  "infra/db/migrations/001_initial.sql",
];

const eventTone: Partial<Record<EventType, "success" | "warning" | "danger" | "info">> = {
  "task.created": "info",
  "task.started": "success",
  "agent.created": "info",
  "agent.started": "success",
  "approval.requested": "warning",
  "approval.rejected": "danger",
  "task.failed": "danger",
  "task.completed": "success",
};

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "Created",
    queued: "Queued",
    running: "Running",
    reviewing: "Review",
    blocked: "Blocked",
    completed: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  return labels[status] || status;
}

function eventTime(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventDateTime(value: string | null): string {
  if (!value) {
    return "never";
  }
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function commandDuration(command: DeviceCommandSummary): string {
  if (!command.startedAt || !command.completedAt) {
    return "n/a";
  }
  const durationMs = Date.parse(command.completedAt) - Date.parse(command.startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "n/a";
  }
  return `${durationMs}ms`;
}

function commandOutputText(command: DeviceCommandSummary): string {
  const stdout = command.stdout || "";
  const stderr = command.stderr || "";
  if (!stdout && !stderr) {
    return "no output";
  }
  return [`stdout:\n${stdout || "(empty)"}`, `stderr:\n${stderr || "(empty)"}`].join("\n\n");
}

function deriveTitleFromPrompt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized || "New Termes chat";
}

function projectKeyFromName(value: string): string {
  const key = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return key.length >= 2 ? key : `project-${Date.now().toString(36)}`;
}

function defaultProjectWorkspacePath(projectKey: string): string {
  return `/data/docker_data/termes/workspaces/projects/${projectKey}`;
}

function normalizeProjectFolderPath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function projectFolderLabel(value: string): string {
  return value ? `/${value}` : "/";
}

type ProjectDirectoryTreeNode = {
  folder: ProjectFolderSummary;
  children: ProjectDirectoryTreeNode[];
};

function buildProjectDirectoryTree(folders: ProjectFolderSummary[]): ProjectDirectoryTreeNode[] {
  const nodes = new Map(folders.map((folder) => [folder.path, { folder, children: [] as ProjectDirectoryTreeNode[] }]));
  const roots: ProjectDirectoryTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = node.folder.path.split("/").slice(0, -1).join("/");
    const parent = nodes.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: ProjectDirectoryTreeNode[]) => {
    items.sort((left, right) => left.folder.name.localeCompare(right.folder.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function ProjectDirectoryTreeNode({
  node,
  selectedPath,
  collapsedPaths,
  onSelect,
  onToggle,
}: {
  node: ProjectDirectoryTreeNode;
  selectedPath: string;
  collapsedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}): React.ReactElement {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && (!collapsedPaths.has(node.folder.path) || selectedPath.startsWith(`${node.folder.path}/`));
  return (
    <div className="projectDirectoryTreeNode" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div className={node.folder.path === selectedPath ? "projectDirectoryTreeRow active" : "projectDirectoryTreeRow"}>
        {hasChildren ? (
          <button className="projectDirectoryTreeToggle" type="button" aria-label={`${node.folder.name} ${expanded ? "접기" : "펼치기"}`} onClick={() => onToggle(node.folder.path)}>
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : <span className="projectDirectoryTreeSpacer" aria-hidden="true" />}
        <button className="projectDirectoryTreeSelect" type="button" onClick={() => onSelect(node.folder.path)}>
          <FolderOpen size={15} />
          <span>{node.folder.name || projectFolderLabel(node.folder.path)}</span>
        </button>
      </div>
      {hasChildren && expanded ? (
        <div className="projectDirectoryTreeChildren" role="group">
          {node.children.map((child) => <ProjectDirectoryTreeNode key={child.folder.path} node={child} selectedPath={selectedPath} collapsedPaths={collapsedPaths} onSelect={onSelect} onToggle={onToggle} />)}
        </div>
      ) : null}
    </div>
  );
}

function ProjectDirectoryTree({
  folders,
  selectedPath,
  onSelect,
  emptyLabel,
  label,
  onCreateFolder,
  createDisabled,
}: {
  folders: ProjectFolderSummary[];
  selectedPath: string;
  onSelect: (path: string) => void;
  emptyLabel: string;
  label: string;
  onCreateFolder: () => void;
  createDisabled: boolean;
}): React.ReactElement {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const nodes = useMemo(() => buildProjectDirectoryTree(folders), [folders]);
  const rootExpanded = nodes.some((node) => !collapsedPaths.has(node.folder.path) || selectedPath === node.folder.path || selectedPath.startsWith(`${node.folder.path}/`));
  const toggle = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="projectDirectoryTreeSection">
      <div className="projectDirectoryTreeHeader">
        <strong>{label}</strong>
        <button className="projectDirectoryTreeCreateAction" type="button" disabled={createDisabled} onClick={onCreateFolder}>
          <FolderPlus size={14} /> 새 폴더
        </button>
      </div>
      {folders.length === 0 ? <div className="projectDirectoryEmpty">{emptyLabel}</div> : (
        <div className="projectDirectoryTree" role="tree">
          <div className="projectDirectoryTreeNode" role="treeitem" aria-expanded={rootExpanded}>
            <div className={selectedPath === "" ? "projectDirectoryTreeRow active" : "projectDirectoryTreeRow"}>
              <span className="projectDirectoryTreeSpacer" aria-hidden="true" />
              <button className="projectDirectoryTreeSelect" type="button" onClick={() => onSelect("")}>
                <FolderOpen size={15} />
                <span>Workspace root</span>
              </button>
            </div>
            <div className="projectDirectoryTreeChildren" role="group">
              {nodes.map((node) => <ProjectDirectoryTreeNode key={node.folder.path} node={node} selectedPath={selectedPath} collapsedPaths={collapsedPaths} onSelect={onSelect} onToggle={toggle} />)}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const record = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return record.SpeechRecognition || record.webkitSpeechRecognition || null;
}

function compactTaskId(taskId: string): string {
  return taskId.slice(0, 8);
}

function payloadText(event: PlatformEvent): string {
  const payload = event.payload || {};
  const text = payload.text || payload.summary || payload.message || payload.status;
  if (typeof text === "string" && text.trim()) {
    return text;
  }

  if (typeof payload.hermesRunId === "string") {
    return `Hermes run ${payload.hermesRunId} updated.`;
  }

  return `${event.type} received for ${event.taskId ? `task ${compactTaskId(event.taskId)}` : "workspace"}.`;
}

function listCount(value: unknown, key: "sessions" | "jobs" | "data"): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === "object") {
    const nested = (value as Record<string, unknown>)[key];
    return Array.isArray(nested) ? nested.length : 0;
  }

  return 0;
}

function stringifyShort(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return String(value ?? "none");
  }

  const record = value as Record<string, unknown>;
  const label = record.name || record.id || record.label || record.description;
  if (typeof label === "string") {
    return label;
  }

  return JSON.stringify(record).slice(0, 90);
}

function changedFileName(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return String(value ?? "unknown");
  }

  const record = value as Record<string, unknown>;
  return typeof record.path === "string" ? record.path : JSON.stringify(record).slice(0, 90);
}

function artifactMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function artifactOutput(value: unknown): string | null {
  const metadata = artifactMetadata(value);
  return typeof metadata.output === "string" && metadata.output.trim() ? metadata.output : null;
}

function artifactChangedFiles(value: unknown): unknown[] {
  const metadata = artifactMetadata(value);
  return Array.isArray(metadata.changedFiles) ? metadata.changedFiles : [];
}

function firstId(value: unknown, listKey: "sessions" | "jobs", idKeys: string[]): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const list = (value as Record<string, unknown>)[listKey];
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }

  const first = list[0];
  if (!first || typeof first !== "object") {
    return null;
  }

  for (const key of idKeys) {
    const candidate = (first as Record<string, unknown>)[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return null;
}

function App(): JSX.Element {
  const [accountPrincipal, setAccountPrincipal] = useState<TermesAccountPrincipal | null>(null);
  const [accountAuthMode, setAccountAuthMode] = useState<"login" | "register">("login");
  const [accountLoginId, setAccountLoginId] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [registrationName, setRegistrationName] = useState("");
  const [registrationLoginId, setRegistrationLoginId] = useState("");
  const [registrationEmail, setRegistrationEmail] = useState("");
  const [registrationPassword, setRegistrationPassword] = useState("");
  const [registrationPasswordConfirm, setRegistrationPasswordConfirm] = useState("");
  const [memberDialog, setMemberDialog] = useState<"password" | "approval" | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [pendingMembers, setPendingMembers] = useState<PendingTermesMember[]>([]);
  const [memberActionBusy, setMemberActionBusy] = useState(false);
  const [approvingMemberId, setApprovingMemberId] = useState<string | null>(null);
  const [memberApprovalLoadFailed, setMemberApprovalLoadFailed] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);
  const [accountAuthLoading, setAccountAuthLoading] = useState(true);
  const [accountAuthBusy, setAccountAuthBusy] = useState(false);
  const [accountAuthError, setAccountAuthError] = useState<string | null>(null);
  const [accountAuthNotice, setAccountAuthNotice] = useState<string | null>(null);
  const memberDialogRef = useRef<HTMLElement | null>(null);
  const memberDialogOpenerRef = useRef<HTMLElement | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [taskRuntime, setTaskRuntime] = useState<TaskRuntimeSummary | null>(null);
  const [hermesCapabilities, setHermesCapabilities] = useState<HermesCapabilitySummary | null>(null);
  const [capabilityPackages, setCapabilityPackages] = useState<CapabilityPackageSummary[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [taskPlan, setTaskPlan] = useState<TaskPlanSummary | null>(null);
  const [verificationResults, setVerificationResults] = useState<VerificationResultSummary[]>([]);
  const [devicesPanelOpen, setDevicesPanelOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [devicePlatform, setDevicePlatform] = useState<DevicePlatform>("local_mock");
  const [deviceTransport, setDeviceTransport] = useState<DeviceTransport>("local_mock");
  const [deviceStatusFilter, setDeviceStatusFilter] = useState<DeviceStatus | "all">("all");
  const [deviceName, setDeviceName] = useState("Local Mock Device");
  const [deviceEndpoint, setDeviceEndpoint] = useState("");
  const [deviceAction, setDeviceAction] = useState("local_mock.echo");
  const [deviceParamsText, setDeviceParamsText] = useState(defaultParamsForAction("local_mock.echo"));
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceMessage, setDeviceMessage] = useState("local_mock으로 외부 장치 없이 command 경로를 검증할 수 있습니다.");
  const [lastDeviceCommand, setLastDeviceCommand] = useState<DeviceCommandSummary | null>(null);
  const [lastDeviceVerification, setLastDeviceVerification] = useState<VerificationResultSummary | null>(null);
  const [hermesCatalog, setHermesCatalog] = useState<HermesCatalogSummary | null>(null);
  const [hermesRun, setHermesRun] = useState<HermesRunSummary | null>(null);
  const [hermesUpstreamDiagnostics, setHermesUpstreamDiagnostics] = useState<HermesUpstreamDiagnostics | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [interactionInput, setInteractionInput] = useState("");
  const [interactionSending, setInteractionSending] = useState(false);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [projectCreateMode, setProjectCreateMode] = useState<"folder" | "github">("folder");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectWorkspacePath, setProjectWorkspacePath] = useState("");
  const [projectFolders, setProjectFolders] = useState<ProjectFolderSummary[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [projectFolderCreateDialog, setProjectFolderCreateDialog] = useState<ProjectFolderCreateTarget | null>(null);
  const [projectFolderCreateName, setProjectFolderCreateName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderMessage, setFolderMessage] = useState("워크스페이스 폴더를 선택하거나 새로 만들어 프로젝트로 등록할 수 있습니다.");
  const [githubStatus, setGithubStatus] = useState<GitHubConnectionSummary | null>(null);
  const [githubRepositoryGroups, setGithubRepositoryGroups] = useState<GitHubRepositoryGroupSummary[]>([]);
  const [githubSearch, setGithubSearch] = useState("");
  const [selectedGithubRepository, setSelectedGithubRepository] = useState("");
  const [githubCloneParentPath, setGithubCloneParentPath] = useState("");
  const [githubDeviceLogin, setGithubDeviceLogin] = useState<GitHubDeviceLoginStartSummary | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubMessage, setGithubMessage] = useState("GitHub 로그인 후 저장소를 clone해서 프로젝트로 등록할 수 있습니다.");
  const [hermesPrompt, setHermesPrompt] = useState("Inspect Termes runtime and report status.");
  const [lastHermesResponseId, setLastHermesResponseId] = useState<string | null>(null);
  const [lastHermesProfileName, setLastHermesProfileName] = useState<string | null>(null);
  const [hermesStreamEvents, setHermesStreamEvents] = useState<string[]>([]);
  const [hermesAuditResults, setHermesAuditResults] = useState<string[]>([]);
  const [hermesRpcMethod, setHermesRpcMethod] = useState("session.list");
  const [hermesRpcParams, setHermesRpcParams] = useState('{"limit": 20}');
  const [hermesRpcResult, setHermesRpcResult] = useState("아직 실행하지 않았습니다.");
  const [hermesRpcBusy, setHermesRpcBusy] = useState(false);
  const [openAiConnected, setOpenAiConnected] = useState(false);
  const [codexOAuthSession, setCodexOAuthSession] = useState<CodexOAuthDeviceSession | null>(null);
  const [newTaskMode, setNewTaskMode] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>(readStoredTheme);
  const [pwaStandalone, setPwaStandalone] = useState(isTermesPwaStandalone);
  const [pwaInstalled, setPwaInstalled] = useState(isTermesPwaStandalone);
  const [pwaInstallMode, setPwaInstallMode] = useState<TermesPwaInstallMode | null>(() => {
    if (isTermesPwaStandalone()) return null;
    return isIosPwaInstallCandidate() ? "ios" : "manual";
  });
  const [deferredPwaInstallPrompt, setDeferredPwaInstallPrompt] = useState<TermesBeforeInstallPromptEvent | null>(null);
  const [pwaInstallBannerVisible, setPwaInstallBannerVisible] = useState(
    () => !isTermesPwaStandalone() && !isTermesPwaInstallPromptDismissed(),
  );
  const [pwaInstallBusy, setPwaInstallBusy] = useState(false);
  const [pwaInstallHelpVisible, setPwaInstallHelpVisible] = useState(false);
  const [experience, setExperience] = useState<ExperienceKind>(() => resolveExperience(readExperienceEnvironment()));
  const [openAiAuthBusy, setOpenAiAuthBusy] = useState(false);
  const [openAiAuthMessage, setOpenAiAuthMessage] = useState("OpenAI 계정 연결 상태를 확인하는 중입니다.");
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState<WorkbenchTab>("diff");
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>("tasks");
  const [searchOpen, setSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedProjectIdRef = useRef("");
  const selectedTaskIdRef = useRef("");
  const listRefreshGenerationRef = useRef(0);
  const accountDataGenerationRef = useRef(0);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const projectDrawerRef = useRef<HTMLElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const latestChatMessageRef = useRef<HTMLDivElement | null>(null);
  const hermesRpcClientRef = useRef<HermesRealtimeClient | null>(null);

  useEffect(() => {
    if (!memberDialog) return undefined;
    const dialog = memberDialogRef.current;
    const opener = memberDialogOpenerRef.current;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
    const frame = window.requestAnimationFrame(() => {
      const initialFocus = dialog?.querySelector<HTMLElement>("[autofocus]")
        ?? dialog?.querySelector<HTMLElement>(focusableSelector);
      initialFocus?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMemberDialog(null);
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      opener?.focus();
    };
  }, [memberDialog]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = resolveTheme(theme, media.matches);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = theme;
      document.documentElement.style.colorScheme = resolved;
    };
    applyTheme();
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => {
      setError((current) => current === error ? null : current);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const syncDisplayMode = () => {
      const standalone = isTermesPwaStandalone();
      setPwaStandalone(standalone);
      if (standalone) setPwaInstalled(true);
      document.documentElement.dataset.pwaDisplayMode = standalone ? "standalone" : "browser";
    };
    const handleBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as TermesBeforeInstallPromptEvent;
      if (typeof promptEvent.prompt !== "function") return;
      promptEvent.preventDefault();
      setDeferredPwaInstallPrompt(promptEvent);
      setPwaInstallMode("native");
      if (!isTermesPwaInstallPromptDismissed()) setPwaInstallBannerVisible(true);
    };
    const handleAppInstalled = () => {
      setPwaInstalled(true);
      setDeferredPwaInstallPrompt(null);
      setPwaInstallMode(null);
      setPwaInstallBannerVisible(false);
      setPwaInstallHelpVisible(false);
    };

    syncDisplayMode();
    if (!isTermesPwaStandalone() && isIosPwaInstallCandidate()) {
      setPwaInstallMode("ios");
      if (!isTermesPwaInstallPromptDismissed()) setPwaInstallBannerVisible(true);
    }
    displayMode.addEventListener("change", syncDisplayMode);
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      displayMode.removeEventListener("change", syncDisplayMode);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    const finePointer = window.matchMedia("(pointer: fine)");
    const hover = window.matchMedia("(hover: hover)");
    const updateExperience = () => setExperience(resolveExperience(readExperienceEnvironment()));
    updateExperience();
    finePointer.addEventListener("change", updateExperience);
    hover.addEventListener("change", updateExperience);
    window.addEventListener("resize", updateExperience);
    return () => {
      finePointer.removeEventListener("change", updateExperience);
      hover.removeEventListener("change", updateExperience);
      window.removeEventListener("resize", updateExperience);
    };
  }, []);

  useEffect(() => {
    hermesRpcClientRef.current?.close();
    hermesRpcClientRef.current = null;
    setHermesRpcResult("현재 Account/Task scope에 연결할 준비가 됐습니다.");
    return () => {
      hermesRpcClientRef.current?.close();
      hermesRpcClientRef.current = null;
    };
  }, [accountPrincipal?.accountId, selectedProjectId, selectedTaskId]);

  useEffect(() => {
    fetchTermesSession()
      .then(setAccountPrincipal)
      .catch((cause: unknown) => {
        setAccountAuthError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setAccountAuthLoading(false));
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || projects[0],
    [projects, selectedProjectId],
  );

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks[0],
    [tasks, selectedTaskId],
  );

  const filteredDevicesForPanel = useMemo(
    () =>
      devices.filter(
        (device) =>
          device.platform === devicePlatform && (deviceStatusFilter === "all" || device.status === deviceStatusFilter),
      ),
    [devices, devicePlatform, deviceStatusFilter],
  );
  const selectedDevice = useMemo(() => {
    const explicitDevice = devices.find((device) => device.id === selectedDeviceId);
    if (
      explicitDevice?.platform === devicePlatform &&
      (deviceStatusFilter === "all" || explicitDevice.status === deviceStatusFilter)
    ) {
      return explicitDevice;
    }
    return filteredDevicesForPanel[0] || null;
  }, [devices, filteredDevicesForPanel, devicePlatform, deviceStatusFilter, selectedDeviceId]);
  const deviceCommandBlockedReason = dangerousDeviceCommandReason(deviceAction, deviceParamsText);

  const selectedTaskEvents = useMemo(
    () => events.filter((event) => !selectedTask || event.taskId === selectedTask.id),
    [events, selectedTask],
  );
  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    if (!query) {
      return tasks;
    }

    return tasks.filter((task) =>
      `${task.title} ${task.instructions} ${task.status}`.toLowerCase().includes(query),
    );
  }, [tasks, taskSearch]);

  const runningTaskCount = tasks.filter((task) => task.status === "running").length;
  const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
  const runtimeMatchesSelected = Boolean(selectedTask && taskRuntime?.task.id === selectedTask.id);
  const latestRun = runtimeMatchesSelected ? taskRuntime?.runs[0] || null : null;
  const latestSession = runtimeMatchesSelected ? taskRuntime?.sessions[0] || null : null;
  const latestCheckpoint = runtimeMatchesSelected ? taskRuntime?.checkpoints[0] || null : null;
  const latestArtifact = runtimeMatchesSelected ? taskRuntime?.artifacts[0] || null : null;
  const orchestration = runtimeMatchesSelected ? taskRuntime?.orchestration || null : null;
  const latestTurn = runtimeMatchesSelected ? taskRuntime?.turns?.at(-1) || null : null;
  const hermesProjection = runtimeMatchesSelected ? taskRuntime?.hermesProjection || null : null;
  const showLiveHermesProjection = Boolean(
    hermesProjection && (hermesProjection.pending || hermesProjection.busy || hermesProjection.needsInput),
  );
  const projectedHermesInteraction = hermesProjection?.interaction ?? null;
  const pendingHermesInteraction = projectedHermesInteraction?.type === "approval"
    && decideMaximumAutonomyApproval(projectedHermesInteraction).choice !== "manual"
    ? null
    : projectedHermesInteraction;
  const pendingHermesInteractionKey = pendingHermesInteraction
    ? pendingHermesInteraction.type === "approval"
      ? `approval:${hermesProjection?.sessionId || ""}:${pendingHermesInteraction.command}`
      : `${pendingHermesInteraction.type}:${pendingHermesInteraction.requestId}`
    : "";
  const displayedTaskEvents = runtimeMatchesSelected ? taskRuntime?.events || [] : selectedTaskEvents;
  const displayedMessages: ChatMessageSummary[] = runtimeMatchesSelected ? taskRuntime?.messages || [] : [];
  const displayedChatMessages = useMemo(
    () => displayedMessages.filter(isRenderableChatMessage),
    [displayedMessages],
  );
  const latestDisplayedMessageId = displayedChatMessages[displayedChatMessages.length - 1]?.id || "";
  const runnerConfigured = Boolean(hermesCapabilities?.manager.runnerConfigured);
  const upstreamStatus = hermesCapabilities?.manager.upstreamStatus || "checking";
  const upstreamError = hermesCapabilities?.manager.upstreamError;
  const upstreamDiagnostics =
    hermesUpstreamDiagnostics || hermesCapabilities?.manager.upstreamDiagnostics || null;
  const hermesMode = hermesCapabilities?.manager.upstreamConfigured
    ? "Hermes API"
    : runnerConfigured
      ? "Managed Hermes + Runner"
      : "Managed Hermes";
  const hermesRuntimeDetail = hermesCapabilities
    ? `upstream=${upstreamStatus} runner=${runnerConfigured ? "enabled" : "disabled"}`
    : "Runtime checking";
  const currentHermesRunId = latestSession?.hermesRunId || hermesRun?.run_id || "";
  const draftProjectKey = projectKeyFromName(projectName || "new-project");
  const suggestedProjectWorkspacePath = defaultProjectWorkspacePath(draftProjectKey);
  const filteredGithubRepositoryGroups = useMemo(() => {
    const query = githubSearch.trim().toLowerCase();
    if (!query) {
      return githubRepositoryGroups;
    }
    return githubRepositoryGroups
      .map((group) => ({
        ...group,
        repositories: group.repositories.filter((repository) =>
          `${repository.fullName} ${repository.visibility} ${repository.defaultBranch}`.toLowerCase().includes(query),
        ),
      }))
      .filter((group) => group.repositories.length > 0 || group.error);
  }, [githubRepositoryGroups, githubSearch]);
  const githubConnected = githubStatus?.connected === true;

  function selectProjectState(projectId: string): void {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }

  function selectTaskState(taskId: string): void {
    selectedTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
  }

  async function refresh(projectId?: string, taskId?: string): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const generation = ++listRefreshGenerationRef.current;
    const nextProjects = await fetchProjects();
    const requestedProjectId = projectId ?? selectedProjectIdRef.current;
    const nextProjectId = resolveExistingSelectionId(nextProjects, requestedProjectId);
    const nextTasks = nextProjectId ? await fetchTasks(nextProjectId) : [];
    const requestedTaskId = taskId ?? selectedTaskIdRef.current;
    const nextTaskId = resolveExistingSelectionId(nextTasks, requestedTaskId);

    if (generation !== listRefreshGenerationRef.current || accountGeneration !== accountDataGenerationRef.current) return;

    setProjects(nextProjects);
    selectProjectState(nextProjectId);
    setTasks(nextTasks);
    selectTaskState(nextTaskId);
  }

  async function refreshTaskList(projectId?: string): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const generation = ++listRefreshGenerationRef.current;
    const nextProjects = await fetchProjects();
    const requestedProjectId = projectId ?? selectedProjectIdRef.current;
    const nextProjectId = resolveExistingSelectionId(nextProjects, requestedProjectId);
    const nextTasks = nextProjectId ? await fetchTasks(nextProjectId) : [];
    const nextTaskId = resolveExistingSelectionId(nextTasks, selectedTaskIdRef.current);

    if (generation !== listRefreshGenerationRef.current || accountGeneration !== accountDataGenerationRef.current) return;

    setProjects(nextProjects);
    selectProjectState(nextProjectId);
    setTasks(nextTasks);
    selectTaskState(nextTaskId);
  }

  async function refreshRuntime(taskId = selectedTask?.id): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const [capabilities, runtime] = await Promise.all([
      fetchHermesCapabilities(),
      taskId ? fetchTaskRuntime(taskId) : Promise.resolve(null),
    ]);
    if (accountGeneration !== accountDataGenerationRef.current) return;
    setHermesCapabilities(capabilities);
    setTaskRuntime(runtime);
    setTaskPlan(runtime?.taskPlan || null);
    setVerificationResults(runtime?.verificationResults || []);
    const runId = runtime?.sessions[0]?.hermesRunId;
    if (runId) {
      const fallbackRun = runtime?.runs[0] || null;
      const syntheticRun = (): HermesRunSummary => {
        const syntheticRun: HermesRunSummary = {
          object: "hermes.run",
          run_id: runId,
          status: fallbackRun?.status || "unknown",
          model: capabilities.manager.upstreamConfigured ? "hermes-upstream" : "termes-managed",
        };
        if (runtime?.sessions[0]?.hermesSessionId) {
          syntheticRun.session_id = runtime.sessions[0].hermesSessionId;
        }
        if (fallbackRun?.createdAt) {
          syntheticRun.created_at = fallbackRun.createdAt;
        }
        if (fallbackRun?.updatedAt) {
          syntheticRun.updated_at = fallbackRun.updatedAt;
        }
        return syntheticRun;
      };
      const run = runId.startsWith("jsonrpc-")
        ? syntheticRun()
        : await fetchHermesRun(runId).catch(syntheticRun);
      if (accountGeneration !== accountDataGenerationRef.current) return;
      setHermesRun(run);
    } else {
      setHermesRun(null);
    }
  }

  async function refreshDevices(projectId = selectedProject?.id): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const [nextDevices, nextCapabilities] = await Promise.all([
      fetchDevices(projectId),
      fetchCapabilities(),
    ]);
    if (accountGeneration !== accountDataGenerationRef.current) return;
    setDevices(nextDevices);
    setCapabilityPackages(nextCapabilities);
    setSelectedDeviceId((current) => {
      const currentDevice = nextDevices.find((device) => device.id === current);
      if (
        currentDevice?.platform === devicePlatform &&
        (deviceStatusFilter === "all" || currentDevice.status === deviceStatusFilter)
      ) {
        return current;
      }
      return (
        nextDevices.find(
          (device) =>
            device.platform === devicePlatform &&
            (deviceStatusFilter === "all" || device.status === deviceStatusFilter),
        )?.id || ""
      );
    });
  }

  async function refreshPlan(taskId = selectedTask?.id): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    if (!taskId) {
      setTaskPlan(null);
      setVerificationResults([]);
      return;
    }
    const [nextPlan, nextVerificationResults] = await Promise.all([
      fetchTaskPlan(taskId),
      fetchVerificationResults(taskId),
    ]);
    if (accountGeneration !== accountDataGenerationRef.current) return;
    setTaskPlan(nextPlan);
    setVerificationResults(nextVerificationResults);
  }

  async function loadProjectFolders(): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const folders = await fetchProjectFolders();
    if (accountGeneration !== accountDataGenerationRef.current) return;
    setProjectFolders(folders);
    setFolderPath((current) => current && folders.some((folder) => folder.path === current) ? current : folders[0]?.path || "");
  }

  async function loadGitHubProjectState(): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    setGithubBusy(true);
    try {
      const status = await fetchGitHubStatus();
      if (accountGeneration !== accountDataGenerationRef.current) return;
      setGithubStatus(status);
      if (!status.connected) {
        setGithubRepositoryGroups([]);
        setGithubMessage(
          status.deviceConfigured
            ? status.browserOAuthEnabled
              ? `Device 코드와 Browser OAuth를 사용할 수 있습니다. Callback URL: ${status.callbackUrl}`
              : `Device 코드 로그인을 사용할 수 있습니다. Browser OAuth는 callback 등록 후 서버에서 활성화해야 합니다: ${status.callbackUrl}`
            : "GitHub OAuth 설정이 필요합니다. 서버 .env에 GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET_ENC를 설정해 주세요.",
        );
        return;
      }

      const groups = await fetchGitHubRepositories();
      if (accountGeneration !== accountDataGenerationRef.current) return;
      setGithubRepositoryGroups(groups);
      setGithubMessage(`${status.login || "GitHub"} 계정의 저장소를 불러왔습니다.`);
    } catch (cause) {
      if (accountGeneration === accountDataGenerationRef.current) {
        setGithubMessage(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (accountGeneration === accountDataGenerationRef.current) setGithubBusy(false);
    }
  }

  function handleDevicePlatformChange(platform: DevicePlatform): void {
    const nextTransport = transportOptions(platform)[0] || "local_mock";
    const nextAction = defaultActionForPlatform(platform);
    const nextDevice = devices.find(
      (device) => device.platform === platform && (deviceStatusFilter === "all" || device.status === deviceStatusFilter),
    );
    setDevicePlatform(platform);
    setDeviceTransport(nextTransport);
    setSelectedDeviceId(nextDevice?.id || "");
    setDeviceAction(nextAction);
    setDeviceParamsText(defaultParamsForAction(nextAction));
    setDeviceName(platform === "local_mock" ? "Local Mock Device" : `${devicePlatformLabel(platform)} Device`);
    setDeviceEndpoint("");
    setLastDeviceCommand(null);
    setLastDeviceVerification(null);
  }

  async function handleDiscoverDevices(): Promise<void> {
    if (!selectedProject) {
      setDeviceMessage("프로젝트를 먼저 선택해 주세요.");
      return;
    }
    setDeviceBusy(true);
    setDeviceMessage("device-gateway에서 장치를 검색하는 중입니다.");
    try {
      const discovered = await discoverDevices(selectedProject.id);
      setDevices(discovered);
      setSelectedDeviceId(
        discovered.find(
          (device) =>
            device.platform === devicePlatform &&
            (deviceStatusFilter === "all" || device.status === deviceStatusFilter),
        )?.id || "",
      );
      setDeviceMessage(`${discovered.length}개 장치를 동기화했습니다.`);
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleRegisterDevice(): Promise<void> {
    if (!selectedProject) {
      setDeviceMessage("프로젝트를 먼저 선택해 주세요.");
      return;
    }
    const name = deviceName.trim();
    if (!name) {
      setDeviceMessage("장치 이름을 입력해 주세요.");
      return;
    }
    setDeviceBusy(true);
    setDeviceMessage(`${name} 장치를 등록하는 중입니다.`);
    try {
      const device = await createDevice({
        projectId: selectedProject.id,
        name,
        platform: devicePlatform,
        transport: deviceTransport,
        endpoint: deviceEndpoint.trim() || null,
        labels: { source: "mobile-pwa" },
        status: devicePlatform === "local_mock" ? "online" : "unknown",
      });
      await refreshDevices(selectedProject.id);
      setSelectedDeviceId(device.id);
      setDeviceMessage(`${device.name} 장치를 등록했습니다.`);
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleUpdateSelectedDevice(): Promise<void> {
    if (!selectedDevice) {
      setDeviceMessage("수정할 장치를 선택해 주세요.");
      return;
    }
    const name = deviceName.trim();
    if (!name) {
      setDeviceMessage("장치 이름을 입력해 주세요.");
      return;
    }

    setDeviceBusy(true);
    setDeviceMessage(`${selectedDevice.name} 장치를 저장하는 중입니다.`);
    try {
      const updated = await updateDevice(selectedDevice.id, {
        name,
        transport: deviceTransport,
        endpoint: deviceEndpoint.trim() || null,
        labels: selectedDevice.labels,
        status: selectedDevice.status,
      });
      await refreshDevices(selectedProject?.id);
      setSelectedDeviceId(updated.id);
      setDeviceMessage(`${updated.name} 장치를 저장했습니다.`);
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleDeleteSelectedDevice(): Promise<void> {
    if (!selectedDevice) {
      setDeviceMessage("삭제할 장치를 선택해 주세요.");
      return;
    }
    const confirmed = window.confirm(`${selectedDevice.name} 장치를 삭제할까요? 관련 command 이력은 보존됩니다.`);
    if (!confirmed) {
      return;
    }

    setDeviceBusy(true);
    setDeviceMessage(`${selectedDevice.name} 장치를 삭제하는 중입니다.`);
    try {
      await deleteDevice(selectedDevice.id);
      setSelectedDeviceId("");
      setLastDeviceCommand(null);
      setLastDeviceVerification(null);
      await refreshDevices(selectedProject?.id);
      setDeviceMessage(`${selectedDevice.name} 장치를 삭제했습니다.`);
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleRunDeviceCommand(): Promise<void> {
    if (!selectedDevice) {
      setDeviceMessage("명령을 실행할 장치를 선택해 주세요.");
      return;
    }
    let params: Record<string, unknown>;
    try {
      const parsed = JSON.parse(deviceParamsText || "{}") as unknown;
      params = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : "params JSON을 확인해 주세요.");
      return;
    }

    setDeviceBusy(true);
    setDeviceMessage(`${deviceAction} 명령을 실행하는 중입니다.`);
    try {
      const result = await runDeviceCommand(selectedDevice.id, {
        taskId: selectedTask?.id || null,
        projectId: selectedProject?.id || null,
        action: deviceAction,
        params,
      });
      setLastDeviceCommand(result.command);
      setLastDeviceVerification(result.verificationResult || null);
      setDeviceMessage(`${result.command.action} ${result.command.status}`);
      await refreshDevices(selectedProject?.id);
      if (selectedTask?.id) {
        await refreshRuntime(selectedTask.id);
        await refreshPlan(selectedTask.id);
      }
    } catch (cause) {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeviceBusy(false);
    }
  }

  async function handleCopyDeviceLogs(): Promise<void> {
    if (!lastDeviceCommand) {
      return;
    }
    const logs = await fetchDeviceCommandLogs(lastDeviceCommand.id);
    await navigator.clipboard?.writeText(`stdout:\n${logs.stdout}\n\nstderr:\n${logs.stderr}`);
    setDeviceMessage("명령 로그를 클립보드에 복사했습니다.");
  }

  function openProjectDrawer(mode: "folder" | "github" = "folder"): void {
    setProjectCreateMode(mode);
    setSelectedGithubRepository("");
    setGithubDeviceLogin(null);
    setProjectPanelOpen(true);
    setFolderMessage("워크스페이스 폴더를 선택하거나 새로 만들어 프로젝트로 등록할 수 있습니다.");
  }

  function startGitHubLogin(): void {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/github/oauth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function handleStartGitHubDeviceLogin(): Promise<void> {
    setGithubBusy(true);
    setGithubMessage("GitHub device login 코드를 발급하는 중입니다.");
    try {
      const device = await startGitHubDeviceLogin();
      if (!device.configured) {
        setGithubDeviceLogin(null);
        setGithubMessage(device.message);
        return;
      }
      setGithubDeviceLogin(device);
      setGithubMessage("GitHub 승인 페이지에서 코드를 입력하면 Termes가 자동으로 연결 상태를 확인합니다.");
      navigator.clipboard?.writeText(device.userCode).catch(() => undefined);
      window.open(device.verificationUriComplete || device.verificationUri, "_blank", "noopener,noreferrer");
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function handlePollGitHubDeviceLogin(): Promise<void> {
    if (!githubDeviceLogin?.sessionId) {
      setGithubMessage("진행 중인 GitHub device login이 없습니다.");
      return;
    }
    if (Date.parse(githubDeviceLogin.expiresAt) <= Date.now()) {
      setGithubDeviceLogin(null);
      setGithubMessage("GitHub device login 코드가 만료되었습니다. 새 코드를 발급해 주세요.");
      return;
    }

    setGithubBusy(true);
    setGithubMessage("GitHub 승인 완료 여부를 확인하는 중입니다.");
    try {
      const result = await pollGitHubDeviceLogin(githubDeviceLogin.sessionId);
      setGithubStatus(result.github);
      if (result.status === "pending") {
        setGithubDeviceLogin((current) => current ? { ...current, interval: result.nextInterval || current.interval } : current);
        setGithubMessage(`${result.message}. 승인 완료 후 자동으로 연결됩니다.`);
        return;
      }
      setGithubDeviceLogin(null);
      setGithubMessage(result.message);
      const groups = await fetchGitHubRepositories();
      setGithubRepositoryGroups(groups);
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function handleDisconnectGitHub(): Promise<void> {
    setGithubBusy(true);
    setGithubMessage("GitHub 연결을 해제하는 중입니다.");
    try {
      const status = await disconnectGitHub();
      setGithubStatus(status);
      setGithubRepositoryGroups([]);
      setSelectedGithubRepository("");
      setGithubDeviceLogin(null);
      setGithubMessage("GitHub 연결을 해제했습니다.");
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  function openProjectFolderCreateDialog(target: ProjectFolderCreateTarget): void {
    setProjectFolderCreateName("");
    setProjectFolderCreateDialog(target);
  }

  async function handleCreateProjectFolderFromDialog(): Promise<void> {
    const target = projectFolderCreateDialog;
    const name = projectFolderCreateName.trim();
    if (!target || !name) return;

    const parentPath = target === "github" ? githubCloneParentPath : folderPath;
    const setBusy = target === "github" ? setGithubBusy : setFolderBusy;
    const setMessage = target === "github" ? setGithubMessage : setFolderMessage;
    setBusy(true);
    setMessage("선택한 폴더 아래에 새 폴더를 생성하는 중입니다.");
    try {
      const created = await createProjectFolder({
        ...(parentPath.trim() ? { parentPath: parentPath.trim() } : {}),
        name,
      });
      if (target === "github") {
        setGithubCloneParentPath(created.path);
      } else {
        setFolderPath(created.path);
      }
      await loadProjectFolders();
      setMessage(`${projectFolderLabel(created.path)} 폴더를 선택했습니다.`);
      setProjectFolderCreateDialog(null);
      setProjectFolderCreateName("");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterFolderWorkspace(): Promise<void> {
    const selectedPath = normalizeProjectFolderPath(folderPath);
    if (!selectedPath) {
      setFolderMessage("등록할 폴더를 선택해 주세요.");
      return;
    }

    setFolderBusy(true);
    setFolderMessage(`${projectFolderLabel(selectedPath)} 폴더를 프로젝트로 등록하는 중입니다.`);
    try {
      const result = await registerProjectFolder({ path: selectedPath });
      setProjectPanelOpen(false);
      setProjectCreateMode("folder");
      setFolderMessage(`${projectFolderLabel(selectedPath)} 프로젝트를 등록했습니다.`);
      selectProjectState(result.project.id);
      selectTaskState("");
      setTaskRuntime(null);
      await refresh(result.project.id, "");
    } catch (cause) {
      setFolderMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleCloneGitHubProject(repositoryFullName: string): Promise<void> {
    const fullName = repositoryFullName.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!fullName) {
      setGithubMessage("clone할 GitHub 저장소를 선택하거나 owner/repo 형식으로 입력해 주세요.");
      return;
    }

    setGithubBusy(true);
    setGithubMessage(`${fullName} 저장소를 clone하고 프로젝트 폴더로 선택하는 중입니다.`);
    try {
      const result = await cloneGitHubProject({
        repositoryFullName: fullName,
        ...(githubCloneParentPath.trim() ? { parentPath: githubCloneParentPath.trim() } : {}),
      });
      setSelectedGithubRepository("");
      setGithubCloneParentPath("");
      setProjectPanelOpen(false);
      setProjectCreateMode("folder");
      setGithubMessage(`${result.repositoryFullName}을 ${result.workspacePath}에 clone하고 프로젝트 폴더로 선택했습니다.`);
      selectProjectState(result.project.id);
      selectTaskState("");
      setTaskRuntime(null);
      await refresh(result.project.id, "");
      await loadProjectFolders();
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function refreshHermesCatalog(): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const catalog = await fetchHermesCatalog(accountPrincipal?.canManageSharedOAuth === true);
    if (accountGeneration !== accountDataGenerationRef.current) return;
    setHermesCatalog(catalog);
    setHermesCapabilities(catalog.capabilities);
    setHermesUpstreamDiagnostics(catalog.capabilities.manager.upstreamDiagnostics || null);
  }

  async function refreshOpenAiAccount(): Promise<void> {
    const accountGeneration = accountDataGenerationRef.current;
    const account = await fetchOpenAiAccount();
    if (accountGeneration !== accountDataGenerationRef.current) return;
    const connected = Boolean(account.account) && account.requiresOpenaiAuth !== true;
    setOpenAiConnected(connected);
    setOpenAiAuthMessage(connected
      ? "ChatGPT 계정이 Codex app-server에 연결되었습니다."
      : "API key 없이 ChatGPT 계정 OAuth 연결이 필요합니다.");
  }

  async function handleOpenAiConnect(): Promise<void> {
    setOpenAiAuthBusy(true);
    try {
      const session = await startCodexOAuthLogin();
      setCodexOAuthSession(session);
      setOpenAiAuthMessage("ChatGPT 계정 승인을 완료해 주세요.");
      if (session.verificationUrl) window.open(session.verificationUrl, "_blank", "noopener,noreferrer");
    } finally {
      setOpenAiAuthBusy(false);
    }
  }

  async function handleAccountLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!accountLoginId.trim() || !accountPassword) return;
    setAccountAuthBusy(true);
    setAccountAuthError(null);
    try {
      const principal = await loginTermesAccount(accountLoginId, accountPassword);
      setAccountPrincipal(principal);
      setAccountPassword("");
    } catch (cause) {
      setAccountAuthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccountAuthBusy(false);
    }
  }

  async function handleAccountRegistration(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAccountAuthError(null);
    setAccountAuthNotice(null);
    if (registrationPassword !== registrationPasswordConfirm) {
      setAccountAuthError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setAccountAuthBusy(true);
    try {
      await registerTermesMember({
        displayName: registrationName,
        loginId: registrationLoginId,
        email: registrationEmail,
        password: registrationPassword,
      });
      setRegistrationPassword("");
      setRegistrationPasswordConfirm("");
      setAccountLoginId(registrationLoginId.trim().toLowerCase());
      setAccountAuthMode("login");
      setAccountAuthNotice("승인 요청을 보냈습니다. 관리자가 승인한 뒤 로그인할 수 있습니다.");
    } catch (cause) {
      setAccountAuthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccountAuthBusy(false);
    }
  }

  async function openMemberApproval(): Promise<void> {
    memberDialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMemberDialog("approval");
    setMemberActionBusy(true);
    setMemberActionError(null);
    setMemberApprovalLoadFailed(false);
    setPendingMembers([]);
    try {
      setPendingMembers(await fetchPendingTermesMembers());
    } catch (cause) {
      setMemberApprovalLoadFailed(true);
      setMemberActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemberActionBusy(false);
    }
  }

  function openPasswordDialog(): void {
    memberDialogOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMemberActionError(null);
    setMemberDialog("password");
  }

  async function handleMemberApproval(memberId: string): Promise<void> {
    setApprovingMemberId(memberId);
    setMemberActionError(null);
    try {
      await approveTermesMember(memberId);
      setPendingMembers((members) => members.filter((member) => member.memberId !== memberId));
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApprovingMemberId(null);
    }
  }

  function clearAuthenticatedShell(): void {
    accountDataGenerationRef.current += 1;
    hermesRpcClientRef.current?.close();
    hermesRpcClientRef.current = null;
    setAccountPrincipal(null);
    setProjects([]);
    setTasks([]);
    setEvents([]);
    setTaskRuntime(null);
    setHermesCapabilities(null);
    setCapabilityPackages([]);
    setDevices([]);
    setTaskPlan(null);
    setVerificationResults([]);
    setSelectedDeviceId("");
    setLastDeviceCommand(null);
    setLastDeviceVerification(null);
    setHermesCatalog(null);
    setHermesRun(null);
    setHermesUpstreamDiagnostics(null);
    setPendingMembers([]);
    setMemberDialog(null);
    setProjectPanelOpen(false);
    setProjectFolders([]);
    setFolderPath("");
    setGithubStatus(null);
    setGithubRepositoryGroups([]);
    setGithubSearch("");
    setSelectedGithubRepository("");
    setGithubDeviceLogin(null);
    setHermesStreamEvents([]);
    setHermesAuditResults([]);
    setHermesRpcResult("아직 실행하지 않았습니다.");
    setOpenAiConnected(false);
    setCodexOAuthSession(null);
    listRefreshGenerationRef.current += 1;
    selectProjectState("");
    selectTaskState("");
    setMobileView("list");
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMemberActionError(null);
    if (newPassword !== newPasswordConfirm) {
      setMemberActionError("새 비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    setMemberActionBusy(true);
    try {
      await changeTermesPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
      setMemberDialog(null);
      clearAuthenticatedShell();
      setAccountAuthMode("login");
      setAccountAuthNotice("비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해 주세요.");
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMemberActionBusy(false);
    }
  }

  async function handleAccountLogout(): Promise<void> {
    setAccountAuthBusy(true);
    setAccountAuthError(null);
    try {
      await logoutTermesAccount();
      clearAuthenticatedShell();
    } catch (cause) {
      setAccountAuthError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAccountAuthBusy(false);
    }
  }

  function handleDismissPwaInstall(): void {
    dismissTermesPwaInstallPrompt();
    setPwaInstallBannerVisible(false);
    setPwaInstallHelpVisible(false);
  }

  async function handleInstallPwa(): Promise<void> {
    if (pwaInstallMode !== "native" && !deferredPwaInstallPrompt) {
      setPwaInstallHelpVisible(true);
      setPwaInstallBannerVisible(true);
      return;
    }
    if (!deferredPwaInstallPrompt || pwaInstallBusy) return;

    setPwaInstallBusy(true);
    try {
      await deferredPwaInstallPrompt.prompt();
      const choice = await deferredPwaInstallPrompt.userChoice;
      setPwaInstalled(choice.outcome === "accepted");
      setDeferredPwaInstallPrompt(null);
      setPwaInstallMode(null);
      setPwaInstallBannerVisible(false);
    } finally {
      setPwaInstallBusy(false);
    }
  }

  useEffect(() => {
    if (!selectedDevice) {
      return;
    }
    setDeviceName(selectedDevice.name);
    setDeviceTransport(selectedDevice.transport);
    setDeviceEndpoint(selectedDevice.endpoint || "");
  }, [selectedDevice?.id]);

  useEffect(() => {
    accountDataGenerationRef.current += 1;
  }, [accountPrincipal?.memberId]);

  useEffect(() => {
    if (!accountPrincipal) return;
    const accountGeneration = accountDataGenerationRef.current;
    let refreshTimer: number | null = null;
    let refreshListPending = false;
    let refreshRuntimePending = false;
    let refreshDevicesPending = false;
    const scheduleEventRefresh = (options: { list: boolean; runtime: boolean; devices: boolean }) => {
      refreshListPending ||= options.list;
      refreshRuntimePending ||= options.runtime;
      refreshDevicesPending ||= options.devices;
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        const projectId = selectedProjectIdRef.current || undefined;
        const taskId = selectedTaskIdRef.current || undefined;
        if (refreshListPending) {
          refreshListPending = false;
          refreshTaskList(projectId).catch((cause: unknown) => {
            if (accountGeneration === accountDataGenerationRef.current) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          });
        }
        if (refreshRuntimePending && taskId) {
          refreshRuntimePending = false;
          refreshRuntime(taskId).catch((cause: unknown) => {
            if (accountGeneration === accountDataGenerationRef.current) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          });
        } else {
          refreshRuntimePending = false;
        }
        if (refreshDevicesPending) {
          refreshDevicesPending = false;
          refreshDevices(projectId).catch((cause: unknown) => {
            if (accountGeneration === accountDataGenerationRef.current) {
              setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
            }
          });
        }
      }, 50);
    };
    setVoiceSupported(Boolean(getSpeechRecognitionConstructor()));

    refresh()
      .catch((cause: unknown) => {
        if (accountGeneration === accountDataGenerationRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (accountGeneration === accountDataGenerationRef.current) setLoading(false);
      });

    refreshRuntime().catch((cause: unknown) => {
      if (accountGeneration === accountDataGenerationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    refreshHermesCatalog().catch((cause: unknown) => {
      if (accountGeneration === accountDataGenerationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    refreshOpenAiAccount().catch((cause: unknown) => {
      if (accountGeneration === accountDataGenerationRef.current) setOpenAiAuthMessage(cause instanceof Error ? cause.message : String(cause));
    });
    fetchHermesUpstreamDiagnostics()
      .then((diagnostics) => {
        if (accountGeneration === accountDataGenerationRef.current) setHermesUpstreamDiagnostics(diagnostics);
      })
      .catch((cause: unknown) => {
        if (accountGeneration === accountDataGenerationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    refreshDevices().catch((cause: unknown) => {
      if (accountGeneration === accountDataGenerationRef.current) setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    });

    const source = connectEvents((event) => {
      if (accountGeneration !== accountDataGenerationRef.current) return;
      setEvents((current) => [event, ...current.filter((entry) => entry.id !== event.id)].slice(0, 80));
      if (
        event.type === "project.created" ||
        event.type === "project.updated" ||
        event.type === "project.deleted" ||
        event.type === "task.created" ||
        event.type === "task.updated" ||
        event.type === "task.deleted" ||
        event.type === "task.started" ||
        event.type === "agent.delta" ||
        event.type === "hermes.projection.updated" ||
        event.type === "checkpoint.created" ||
        event.type === "chat.message.created" ||
        event.type === "chat.message.completed" ||
        event.type === "task.turn.requested" ||
        event.type === "routing.started" ||
        event.type === "routing.ready" ||
        event.type === "routing.decided" ||
        event.type === "routing.failed" ||
        event.type === "execution.direct.started" ||
        event.type === "execution.specialists.planned" ||
        event.type === "execution.escalated" ||
        event.type === "task.turn.completed" ||
        event.type === "task.turn.failed" ||
        event.type === "task.plan.created" ||
        event.type === "task.plan.step.started" ||
        event.type === "task.plan.step.completed" ||
        event.type === "task.plan.step.failed" ||
        event.type === "device.command.created" ||
        event.type === "device.command.queued" ||
        event.type === "device.command.running" ||
        event.type === "device.command.completed" ||
        event.type === "device.command.failed" ||
        event.type === "device.command.blocked" ||
        event.type === "verification.created" ||
        event.type === "task.completed" ||
        event.type === "task.failed"
      ) {
        const selectedTaskEvent = Boolean(event.taskId && event.taskId === selectedTaskIdRef.current);
        scheduleEventRefresh({
          list: true,
          runtime: selectedTaskEvent,
          devices: event.type.startsWith("device.command") || event.type === "verification.created",
        });
      }
    });

    return () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      source.close();
      recognitionRef.current?.stop();
    };
  }, [accountPrincipal?.accountId]);

  useEffect(() => {
    if (!codexOAuthSession || !["starting", "awaiting_user"].includes(codexOAuthSession.status)) return;
    const timer = window.setTimeout(() => {
      pollCodexOAuthLogin(codexOAuthSession.id)
        .then(async (session) => {
          setCodexOAuthSession(session);
          if (session.status === "complete") {
            setOpenAiConnected(true);
            setOpenAiAuthMessage("ChatGPT OAuth 연결이 완료되었습니다. 모든 Account Cell이 이 계정을 공유합니다.");
            await refreshHermesCatalog();
          } else if (session.status === "error") {
            setOpenAiAuthMessage(session.error || "Codex OAuth 연결에 실패했습니다.");
          }
        })
        .catch((cause: unknown) => setOpenAiAuthMessage(cause instanceof Error ? cause.message : String(cause)));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [codexOAuthSession?.id, codexOAuthSession?.status]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get("github_oauth");
    if (!oauthStatus) {
      return;
    }
    setProjectPanelOpen(true);
    setProjectCreateMode("github");
    setGithubMessage(params.get("github_oauth_message") || (oauthStatus === "success" ? "GitHub 로그인이 완료되었습니다." : "GitHub 로그인에 실패했습니다."));
    params.delete("github_oauth");
    params.delete("github_oauth_message");
    window.history.replaceState({}, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`);
  }, []);

  useEffect(() => {
    if (!projectPanelOpen || projectCreateMode !== "github") {
      return;
    }
    loadGitHubProjectState().catch((cause: unknown) => {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    });
  }, [projectPanelOpen, projectCreateMode]);

  useEffect(() => {
    if (!projectPanelOpen || projectCreateMode !== "github" || !githubDeviceLogin || githubBusy || githubConnected) {
      return;
    }
    if (Date.parse(githubDeviceLogin.expiresAt) <= Date.now()) {
      setGithubDeviceLogin(null);
      setGithubMessage("GitHub device login 코드가 만료되었습니다. 새 코드를 발급해 주세요.");
      return;
    }

    const timeoutId = window.setTimeout(() => {
      handlePollGitHubDeviceLogin().catch((cause: unknown) => {
        setGithubMessage(cause instanceof Error ? cause.message : String(cause));
      });
    }, Math.max(5, githubDeviceLogin.interval) * 1000);

    return () => window.clearTimeout(timeoutId);
  }, [githubDeviceLogin, githubBusy, githubConnected, projectCreateMode, projectPanelOpen]);

  useEffect(() => {
    if (!projectPanelOpen) {
      return;
    }
    loadProjectFolders().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      setFolderMessage(message);
      setGithubMessage(message);
    });
  }, [projectPanelOpen, projectCreateMode]);

  useEffect(() => {
    if (!projectPanelOpen) {
      return;
    }
    requestAnimationFrame(() => {
      if (projectDrawerRef.current) {
        projectDrawerRef.current.scrollTop = 0;
      }
    });
  }, [projectPanelOpen, projectCreateMode]);

  useEffect(() => {
    if (!devicesPanelOpen) {
      return;
    }
    refreshDevices(selectedProject?.id).catch((cause: unknown) => {
      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
    });
  }, [devicesPanelOpen, selectedProject?.id]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    selectedTaskIdRef.current = selectedTaskId;
    if (!selectedTaskId) {
      setTaskRuntime(null);
      setTaskPlan(null);
      setVerificationResults([]);
      return;
    }

    refreshRuntime(selectedTaskId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [selectedTaskId]);

  useEffect(() => {
    setInteractionInput("");
    setInteractionSending(false);
  }, [pendingHermesInteractionKey]);

  useEffect(() => {
    window.requestAnimationFrame(() => {
      latestChatMessageRef.current?.scrollIntoView({ block: "end" });
    });
  }, [latestDisplayedMessageId, selectedTaskId, mobileView]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedProject) {
      return;
    }

    setError(null);
    const prompt = instructions.trim();
    const nextTitle = title.trim();
    if (!prompt) {
      return;
    }

    setSendingMessage(true);
    setMobileView("chat");
    setMobileScreen("conversation");
    try {
      if (selectedTask && !newTaskMode) {
        await sendTaskMessage(selectedTask.id, prompt);
        setInstructions("");
        await refreshTaskList(selectedProject.id);
        await refreshRuntime(selectedTask.id);
        return;
      }

      const task = await createTask({
        projectId: selectedProject.id,
        title: nextTitle || deriveTitleFromPrompt(prompt),
        instructions: prompt,
      });

      setTasks((current) => [task, ...current]);
      selectTaskState(task.id);
      setMobileView("chat");
      setMobileScreen("conversation");
      setTitle("");
      setInstructions("");
      setNewTaskMode(false);
      await refreshRuntime(task.id);
      await refreshHermesCatalog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSendingMessage(false);
    }
  }

  async function handleHermesInteractionResponse(
    input:
      | { type: "approval"; choice: "once" | "session" | "always" | "deny" }
      | { type: "clarify"; requestId: string; answer: string }
      | { type: "sudo"; requestId: string; password: string }
      | { type: "secret"; requestId: string; value: string },
  ): Promise<void> {
    if (!selectedTask || interactionSending) return;
    setInteractionSending(true);
    setError(null);
    try {
      await respondHermesInteraction(selectedTask.id, input);
      setInteractionInput("");
      await refreshRuntime(selectedTask.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setInteractionSending(false);
    }
  }

  async function handleCreateProject(): Promise<void> {
    const name = projectName.trim();
    if (!name) {
      return;
    }
    const description = projectDescription.trim();
    const key = projectKeyFromName(name);
    const workspacePath = projectWorkspacePath.trim() || defaultProjectWorkspacePath(key);

    const project = await createProject({
      key,
      name,
      workspacePath,
      ...(description ? { description } : {}),
    });
    setProjectName("");
    setProjectDescription("");
    setProjectWorkspacePath("");
    setProjectPanelOpen(false);
    selectProjectState(project.id);
    selectTaskState("");
    setTaskRuntime(null);
    await refresh(project.id, "");
  }

  async function handleRenameProject(): Promise<void> {
    if (!selectedProject) {
      return;
    }

    const nextName = window.prompt("프로젝트 이름", selectedProject.name)?.trim();
    if (!nextName || nextName === selectedProject.name) {
      return;
    }

    await updateProject(selectedProject.id, { name: nextName });
    await refresh(selectedProject.id, selectedTask?.id);
  }

  async function handleDeleteProject(): Promise<void> {
    if (!selectedProject) {
      return;
    }

    const ok = window.confirm(`${selectedProject.name} 프로젝트와 하위 대화를 삭제할까요?`);
    if (!ok) {
      return;
    }

    const deletedProjectId = selectedProject.id;
    await deleteProject(deletedProjectId);
    if (selectedProjectIdRef.current === deletedProjectId) {
      listRefreshGenerationRef.current += 1;
      selectProjectState("");
      selectTaskState("");
      setTasks([]);
      setTaskRuntime(null);
      setTaskPlan(null);
      setVerificationResults([]);
      setNewTaskMode(false);
      setMobileView("list");
    }
    await refresh("", "");
  }

  async function handleRenameTask(targetTask = selectedTask): Promise<void> {
    if (!targetTask) {
      return;
    }

    const nextTitle = window.prompt("대화 제목", targetTask.title)?.trim();
    if (!nextTitle || nextTitle === targetTask.title) {
      return;
    }

    const task = await updateTask(targetTask.id, { title: nextTitle });
    setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
    if (selectedTaskIdRef.current === task.id) await refreshRuntime(task.id);
  }

  async function handleDeleteTask(targetTask = selectedTask): Promise<void> {
    if (!targetTask) {
      return;
    }

    const ok = window.confirm(`${targetTask.title} 대화를 삭제할까요?`);
    if (!ok) {
      return;
    }

    await deleteTask(targetTask.id);
    const remaining = tasks.filter((task) => task.id !== targetTask.id);
    setTasks(remaining);
    if (selectedTaskIdRef.current === targetTask.id) {
      selectTaskState(remaining[0]?.id || "");
      setTaskRuntime(null);
      setMobileView("list");
      setMobileScreen("tasks");
    }
    await refreshTaskList(selectedProject?.id);
  }

  function toggleVoiceInput(): void {
    if (voiceListening) {
      recognitionRef.current?.stop();
      setVoiceListening(false);
      return;
    }

    const Recognition = getSpeechRecognitionConstructor();
    if (!Recognition) {
      setError("현재 브라우저가 음성 입력을 지원하지 않습니다. Chrome 계열 브라우저에서 사용할 수 있습니다.");
      setVoiceSupported(false);
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "ko-KR";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0].transcript)
        .join(" ")
        .trim();
      if (transcript) {
        setInstructions((current) => `${current}${current.trim() ? " " : ""}${transcript}`);
      }
    };
    recognition.onerror = (event) => {
      setError(`음성 입력 오류: ${event.error}`);
      setVoiceListening(false);
    };
    recognition.onend = () => {
      setVoiceListening(false);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setVoiceListening(true);
  }

  async function handleStopRun(): Promise<void> {
    if (!currentHermesRunId) {
      return;
    }

    const result = await stopHermesRun(currentHermesRunId);
    setActionMessage(`Run ${currentHermesRunId} ${result.status}`);
    await refreshRuntime(selectedTask?.id);
  }

  async function handleApproval(decision: "approved" | "rejected"): Promise<void> {
    if (!currentHermesRunId) {
      return;
    }

    const result = await resolveHermesApproval(currentHermesRunId, decision);
    setActionMessage(`Approval ${decision}: ${result.status}`);
    await refreshRuntime(selectedTask?.id);
  }

  async function handleCreateSession(): Promise<void> {
    const session = await createHermesSession("Mobile Hermes session");
    setActionMessage(`Session created: ${String(session.id || "created")}`);
    await refreshHermesCatalog();
  }

  async function handleHealthDetailed(): Promise<void> {
    const health = await fetchHermesHealthDetailed();
    setActionMessage(
      `Health ${String(health.status || "ok")}: sessions=${String(health.sessions ?? 0)} jobs=${String(
        health.jobs ?? 0,
      )} running=${String(health.running_agents ?? 0)}`,
    );
  }

  async function handleUpstreamDiagnostics(): Promise<void> {
    const diagnostics = await fetchHermesUpstreamDiagnostics();
    setHermesUpstreamDiagnostics(diagnostics);
    const providers = Object.entries(diagnostics.providerKeys || {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name.replace("_API_KEY", ""))
      .join(", ");
    const oauthProviders = Object.entries(diagnostics.oauthProviders || {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ");
    setActionMessage(
      `Upstream ${diagnostics.ready ? "ready" : "not ready"}: status=${diagnostics.upstreamStatus} base=${String(
        diagnostics.baseUrlConfigured,
      )} provider=${providers || oauthProviders || "none"}`,
    );
  }

  async function handleChatCompletion(): Promise<void> {
    const result = await createHermesChatCompletion(hermesPrompt || "Verify Hermes chat completions.");
    const choices = Array.isArray(result.choices) ? result.choices.length : 0;
    setActionMessage(`Chat completion: choices=${choices}`);
  }

  function appendHermesStreamEvent(source: string, event: HermesStreamEvent): void {
    setHermesStreamEvents((current) => [
      `${source}:${event.event} ${stringifyShort(event.data)}`,
      ...current,
    ].slice(0, 24));
  }

  async function handleChatStream(): Promise<void> {
    setHermesStreamEvents([]);
    await streamHermesChatCompletion(hermesPrompt || "Verify Hermes chat completion stream.", (event) => {
      appendHermesStreamEvent("chat", event);
    });
    setActionMessage("Chat stream completed");
  }

  async function handleCreateProfile(): Promise<void> {
    const name = `mobile-${Date.now().toString(36)}`;
    const result = await createHermesProfile(name);
    const profile = result.profile && typeof result.profile === "object" ? result.profile : {};
    const profileName =
      typeof (profile as Record<string, unknown>).name === "string"
        ? ((profile as Record<string, unknown>).name as string)
        : name;
    setLastHermesProfileName(profileName);
    setActionMessage(`Profile created: ${profileName}`);
    await refreshHermesCatalog();
  }

  async function handleDeleteProfile(): Promise<void> {
    if (!lastHermesProfileName) {
      throw new Error("No mobile-created Hermes profile to delete");
    }

    const result = await deleteHermesProfile(lastHermesProfileName);
    setActionMessage(`Profile deleted: ${String(result.deleted || "done")}`);
    setLastHermesProfileName(null);
    await refreshHermesCatalog();
  }

  async function handleSessionChat(): Promise<void> {
    let sessionId = firstId(hermesCatalog?.sessions, "sessions", ["id", "session_id"]);
    if (!sessionId) {
      const session = await createHermesSession("Mobile Hermes session");
      sessionId = typeof session.id === "string" ? session.id : null;
    }
    if (!sessionId) {
      throw new Error("Hermes session was not created");
    }

    const result = await sendHermesSessionChat(sessionId, hermesPrompt || "Verify mobile Hermes session chat.");
    setActionMessage(`Session chat: ${String(result.status || "completed")}`);
    await refreshHermesCatalog();
  }

  async function handleForkSession(): Promise<void> {
    const sessionId = firstId(hermesCatalog?.sessions, "sessions", ["id", "session_id"]);
    if (!sessionId) {
      throw new Error("No Hermes session to fork");
    }

    const result = await forkHermesSession(sessionId);
    setActionMessage(`Session forked: ${String(result.id || result.session_id || "created")}`);
    await refreshHermesCatalog();
  }

  async function handleUpdateSession(): Promise<void> {
    const sessionId = firstId(hermesCatalog?.sessions, "sessions", ["id", "session_id"]);
    if (!sessionId) {
      throw new Error("No Hermes session to update");
    }

    const result = await updateHermesSession(sessionId, {
      title: `Mobile Hermes ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    });
    setActionMessage(`Session updated: ${String(result.id || result.session_id || sessionId)}`);
    await refreshHermesCatalog();
  }

  async function handleDeleteSession(): Promise<void> {
    const sessionId = firstId(hermesCatalog?.sessions, "sessions", ["id", "session_id"]);
    if (!sessionId) {
      throw new Error("No Hermes session to delete");
    }

    const result = await deleteHermesSession(sessionId);
    setActionMessage(`Session deleted: ${String(result.deleted || "done")}`);
    await refreshHermesCatalog();
  }

  async function handleSessionStream(): Promise<void> {
    let sessionId = firstId(hermesCatalog?.sessions, "sessions", ["id", "session_id"]);
    if (!sessionId) {
      const session = await createHermesSession("Mobile Hermes stream session");
      sessionId = typeof session.id === "string" ? session.id : null;
    }
    if (!sessionId) {
      throw new Error("Hermes session was not created");
    }

    setHermesStreamEvents([]);
    await streamHermesSessionChat(sessionId, hermesPrompt || "Verify Hermes session stream.", (event) => {
      appendHermesStreamEvent("session", event);
    });
    setActionMessage(`Session stream completed: ${sessionId}`);
    await refreshHermesCatalog();
  }

  async function handleCreateResponse(): Promise<void> {
    const response = await createHermesResponse(hermesPrompt || "Inspect Termes runtime.", lastHermesResponseId);
    const responseId = typeof response.id === "string" ? response.id : null;
    setLastHermesResponseId(responseId);
    setActionMessage(`Response ${String(response.status || "completed")}: ${responseId || "created"}`);
    await refreshHermesCatalog();
  }

  async function handleResponseStream(): Promise<void> {
    setHermesStreamEvents([]);
    await streamHermesResponse(hermesPrompt || "Inspect Termes runtime.", lastHermesResponseId, (event) => {
      appendHermesStreamEvent("response", event);
    });
    setActionMessage("Response stream completed");
    await refreshHermesCatalog();
  }

  async function handleDeleteResponse(): Promise<void> {
    if (!lastHermesResponseId) {
      throw new Error("No stored response to delete");
    }

    const result = await deleteHermesResponse(lastHermesResponseId);
    setActionMessage(`Response deleted: ${String(result.deleted || "done")}`);
    setLastHermesResponseId(null);
  }

  async function handleCreateRun(): Promise<void> {
    const result = await createHermesRun(hermesPrompt || "Run Termes mobile Hermes probe.");
    const runId = typeof result.run_id === "string" ? result.run_id : "";
    setActionMessage(`Run ${String(result.status || "started")}: ${runId || "created"}`);
    if (runId) {
      setHermesRun(await fetchHermesRun(runId));
    }
    await refreshHermesCatalog();
  }

  async function handleRunEventStream(): Promise<void> {
    let runId = currentHermesRunId;
    if (!runId) {
      const result = await createHermesRun(hermesPrompt || "Run Termes mobile Hermes stream probe.");
      runId = typeof result.run_id === "string" ? result.run_id : "";
    }
    if (!runId) {
      throw new Error("Hermes run was not created");
    }

    setHermesStreamEvents([]);
    await streamHermesRunEvents(runId, (event) => {
      appendHermesStreamEvent("run", event);
    });
    setActionMessage(`Run stream completed: ${runId}`);
    setHermesRun(await fetchHermesRun(runId));
  }

  async function handleCreateJob(): Promise<void> {
    const job = await createHermesJob(hermesPrompt || "Verify mobile Hermes job execution.");
    setActionMessage(`Job created: ${String(job.job_id || "created")}`);
    await refreshHermesCatalog();
  }

  async function handleRunJob(): Promise<void> {
    let jobId = firstId(hermesCatalog?.jobs, "jobs", ["job_id", "id"]);
    if (!jobId) {
      const job = await createHermesJob("Verify mobile Hermes job execution.");
      jobId = typeof job.job_id === "string" ? job.job_id : null;
    }
    if (!jobId) {
      throw new Error("Hermes job was not created");
    }

    const result = await runHermesJob(jobId);
    setActionMessage(`Job run: ${String(result.status || "started")}`);
    await refreshHermesCatalog();
  }

  async function handlePatchJob(): Promise<void> {
    const jobId = firstId(hermesCatalog?.jobs, "jobs", ["job_id", "id"]);
    if (!jobId) {
      throw new Error("No Hermes job to update");
    }

    const result = await updateHermesJob(jobId, {
      prompt: hermesPrompt || "Verify mobile Hermes job execution.",
      delivery_target: "mobile",
    });
    setActionMessage(`Job updated: ${String(result.job_id || result.id || jobId)}`);
    await refreshHermesCatalog();
  }

  async function handlePauseJob(): Promise<void> {
    const jobId = firstId(hermesCatalog?.jobs, "jobs", ["job_id", "id"]);
    if (!jobId) {
      throw new Error("No Hermes job to pause");
    }

    const result = await pauseHermesJob(jobId);
    setActionMessage(`Job paused: ${String(result.paused)}`);
    await refreshHermesCatalog();
  }

  async function handleResumeJob(): Promise<void> {
    const jobId = firstId(hermesCatalog?.jobs, "jobs", ["job_id", "id"]);
    if (!jobId) {
      throw new Error("No Hermes job to resume");
    }

    const result = await resumeHermesJob(jobId);
    setActionMessage(`Job resumed: ${String(result.paused === false)}`);
    await refreshHermesCatalog();
  }

  async function handleDeleteJob(): Promise<void> {
    const jobId = firstId(hermesCatalog?.jobs, "jobs", ["job_id", "id"]);
    if (!jobId) {
      throw new Error("No Hermes job to delete");
    }

    const result = await deleteHermesJob(jobId);
    setActionMessage(`Job deleted: ${String(result.deleted || "done")}`);
    await refreshHermesCatalog();
  }

  async function handleHermesAudit(): Promise<void> {
    if (!accountPrincipal?.canManageSharedOAuth) {
      throw new Error("Hermes 전역 감사는 공유 OAuth 관리 Account에서만 실행할 수 있습니다.");
    }
    const auditId = Date.now().toString(36);
    const prompt = hermesPrompt || "Run Termes Hermes audit.";
    const auditLine = (label: string, status = "ok") => {
      setHermesAuditResults((current) => [`audit:${label} ${status}`, ...current].slice(0, 40));
    };

    setError(null);
    setHermesAuditResults([]);
    setHermesStreamEvents([]);
    setActionMessage("Hermes audit running");

    const catalog = await fetchHermesCatalog(true);
    auditLine(`catalog features=${Object.values(catalog.capabilities.features).filter(Boolean).length}`);

    const health = await fetchHermesHealthDetailed();
    auditLine(`health ${String(health.status || "ok")}`);

    const chat = await createHermesChatCompletion(prompt);
    auditLine(`chat choices=${Array.isArray(chat.choices) ? chat.choices.length : 0}`);

    let chatEvents = 0;
    await streamHermesChatCompletion(prompt, (event) => {
      chatEvents += 1;
      appendHermesStreamEvent("audit-chat", event);
    });
    auditLine(`chat_sse events=${chatEvents}`);

    const response = await createHermesResponse(prompt, null);
    const responseId = typeof response.id === "string" ? response.id : null;
    auditLine(`response ${String(response.status || "created")}`);

    let responseEvents = 0;
    await streamHermesResponse(prompt, responseId, (event) => {
      responseEvents += 1;
      appendHermesStreamEvent("audit-response", event);
    });
    auditLine(`response_sse events=${responseEvents}`);
    if (responseId) {
      await deleteHermesResponse(responseId);
      auditLine("response_delete");
    }

    const run = await createHermesRun(prompt);
    const runId = typeof run.run_id === "string" ? run.run_id : "";
    auditLine(`run_create ${runId ? "ok" : "missing_id"}`);
    if (runId) {
      let runEvents = 0;
      await streamHermesRunEvents(runId, (event) => {
        runEvents += 1;
        appendHermesStreamEvent("audit-run", event);
      });
      const runStatus = await fetchHermesRun(runId);
      auditLine(`run_sse events=${runEvents}`);
      auditLine(`run_status ${runStatus.status}`);
      const approval = await resolveHermesApproval(runId, "approved");
      auditLine(`run_approval ${approval.status}`);
    }

    const stopRun = await createHermesRun("Stop endpoint audit.");
    const stopRunId = typeof stopRun.run_id === "string" ? stopRun.run_id : "";
    if (stopRunId) {
      const stopped = await stopHermesRun(stopRunId);
      auditLine(`run_stop ${stopped.status}`);
    }

    const profileName = `audit-${auditId}`;
    await createHermesProfile(profileName);
    auditLine(`profile_create ${profileName}`);
    await deleteHermesProfile(profileName);
    auditLine("profile_delete");

    const session = await createHermesSession(`Audit ${auditId}`);
    const sessionId = typeof session.id === "string" ? session.id : "";
    auditLine(`session_create ${sessionId ? "ok" : "missing_id"}`);
    if (sessionId) {
      await updateHermesSession(sessionId, { title: `Audit ${auditId} updated` });
      auditLine("session_update");
      const sessionChat = await sendHermesSessionChat(sessionId, prompt);
      auditLine(`session_chat ${String(sessionChat.status || "completed")}`);
      let sessionEvents = 0;
      await streamHermesSessionChat(sessionId, prompt, (event) => {
        sessionEvents += 1;
        appendHermesStreamEvent("audit-session", event);
      });
      auditLine(`session_sse events=${sessionEvents}`);
      const fork = await forkHermesSession(sessionId);
      const forkId = typeof fork.id === "string" ? fork.id : "";
      auditLine(`session_fork ${forkId ? "ok" : "missing_id"}`);
      if (forkId) {
        await deleteHermesSession(forkId);
        auditLine("session_fork_delete");
      }
      await deleteHermesSession(sessionId);
      auditLine("session_delete");
    }

    const job = await createHermesJob(prompt);
    const jobId = typeof job.job_id === "string" ? job.job_id : "";
    auditLine(`job_create ${jobId ? "ok" : "missing_id"}`);
    if (jobId) {
      await updateHermesJob(jobId, { prompt, delivery_target: "mobile" });
      auditLine("job_update");
      await pauseHermesJob(jobId);
      auditLine("job_pause");
      await resumeHermesJob(jobId);
      auditLine("job_resume");
      const jobRun = await runHermesJob(jobId);
      auditLine(`job_run ${String(jobRun.status || "started")}`);
      await deleteHermesJob(jobId);
      auditLine("job_delete");
    }

    await refreshHermesCatalog();
    setActionMessage("Hermes audit completed");
  }

  async function handleHermesRpc(): Promise<void> {
    const method = hermesRpcMethod.trim();
    if (!method) throw new Error("Hermes JSON-RPC method를 입력해 주세요.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(hermesRpcParams || "{}");
    } catch {
      throw new Error("JSON-RPC params는 올바른 JSON object여야 합니다.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON-RPC params는 JSON object여야 합니다.");
    }
    setHermesRpcBusy(true);
    setHermesRpcResult(`${method} 실행 중…`);
    try {
      let client = hermesRpcClientRef.current;
      if (!client) {
        client = new HermesRealtimeClient();
        await client.connect({
          projectId: selectedProject?.id || null,
          taskId: selectedTask?.id || null,
        });
        hermesRpcClientRef.current = client;
      }
      const result = await client.request(method, parsed as Record<string, unknown>);
      setHermesRpcResult(JSON.stringify(result, null, 2));
    } catch (cause) {
      hermesRpcClientRef.current?.close();
      hermesRpcClientRef.current = null;
      throw cause;
    } finally {
      setHermesRpcBusy(false);
    }
  }

  function renderWorkbench(): JSX.Element {
    if (activeWorkbenchTab === "hermes") {
      const features = hermesCatalog?.capabilities.features || hermesCapabilities?.features || {};
      const enabledFeatures = Object.entries(features).filter(([, enabled]) => enabled);
      const disabledFeatures = Object.entries(features).filter(([, enabled]) => !enabled);
      const skills = hermesCatalog?.skills || [];
      const toolsets = hermesCatalog?.toolsets || [];

      return (
        <div className="hermesPanel">
          <div className="hermesHeader">
            <div>
              <strong>{hermesMode}</strong>
              <span>{currentHermesRunId || hermesRuntimeDetail}</span>
            </div>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                refreshHermesCatalog().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <RefreshCw size={14} />
              <span>Refresh</span>
            </button>
          </div>

          <div className={`runtimeLine ${upstreamStatus === "error" ? "runtimeLineDanger" : ""}`}>
            <ShieldCheck size={15} />
            {hermesRuntimeDetail}
          </div>
          {upstreamError ? <div className="actionNote danger">{upstreamError}</div> : null}

          <section className={openAiConnected ? "openAiAuthCard connected" : "openAiAuthCard"}>
            <div>
              <strong>OpenAI OAuth</strong>
              <span>{openAiAuthMessage}</span>
            </div>
            {codexOAuthSession?.status === "awaiting_user" ? (
              <a href={codexOAuthSession.verificationUrl || "#"} target="_blank" rel="noreferrer">
                <code>{codexOAuthSession.userCode}</code>
                <span>계정 승인</span>
              </a>
            ) : null}
            {!openAiConnected && !codexOAuthSession && accountPrincipal?.canManageSharedOAuth ? (
              <button className="miniButton success" type="button" disabled={openAiAuthBusy} onClick={() => void handleOpenAiConnect()}>
                <UserCircle2 size={14} />
                <span>ChatGPT로 연결</span>
              </button>
            ) : null}
            {!openAiConnected && !accountPrincipal?.canManageSharedOAuth ? (
              <p className="mutedLine">공유 ChatGPT OAuth 연결은 지정된 관리 Account에서만 변경할 수 있습니다.</p>
            ) : null}
          </section>

          <details className="hermesRpcConsole">
            <summary>
              <span>원본 JSON-RPC Operator</span>
              <small>119 exact · 현재 Account Cell</small>
            </summary>
            <div className="hermesRpcFields">
              <label>
                <span>Method</span>
                <input value={hermesRpcMethod} onChange={(event) => setHermesRpcMethod(event.target.value)} spellCheck={false} />
              </label>
              <label>
                <span>Params</span>
                <textarea value={hermesRpcParams} onChange={(event) => setHermesRpcParams(event.target.value)} spellCheck={false} />
              </label>
              <button
                className="miniButton success"
                type="button"
                disabled={hermesRpcBusy}
                onClick={() => {
                  handleHermesRpc().catch((cause: unknown) => {
                    const message = cause instanceof Error ? cause.message : String(cause);
                    setHermesRpcResult(message);
                    setError(message);
                  });
                }}
              >
                {hermesRpcBusy ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                <span>{hermesRpcBusy ? "실행 중" : "실행"}</span>
              </button>
              <pre>{hermesRpcResult}</pre>
            </div>
          </details>

          <div className="hermesCommand">
            <textarea
              value={hermesPrompt}
              onChange={(event) => setHermesPrompt(event.target.value)}
              placeholder="Hermes prompt"
            />
            <div className="runtimeActions">
              <button
                className="miniButton success"
                type="button"
                onClick={() => {
                  handleHermesAudit().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                    setActionMessage("Hermes audit failed");
                  });
                }}
              >
                <CheckCircle2 size={14} />
                <span>Audit</span>
              </button>
              <button
                className="miniButton success"
                type="button"
                onClick={() => {
                  handleCreateResponse().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Bot size={14} />
                <span>Response</span>
              </button>
              <button
                className="miniButton"
                disabled={!lastHermesResponseId}
                type="button"
                onClick={() => {
                  handleDeleteResponse().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <CircleAlert size={14} />
                <span>Del Resp</span>
              </button>
              <button
                className="miniButton success"
                type="button"
                onClick={() => {
                  handleChatCompletion().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <MessageSquare size={14} />
                <span>Chat API</span>
              </button>
              <button
                className="miniButton"
                type="button"
                onClick={() => {
                  handleChatStream().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Terminal size={14} />
                <span>Chat SSE</span>
              </button>
              <button
                className="miniButton"
                type="button"
                onClick={() => {
                  handleHealthDetailed().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Activity size={14} />
                <span>Health</span>
              </button>
              <button
                className={upstreamDiagnostics?.ready ? "miniButton success" : "miniButton"}
                type="button"
                onClick={() => {
                  handleUpstreamDiagnostics().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <ShieldCheck size={14} />
                <span>Upstream</span>
              </button>
              <button
                className="miniButton success"
                type="button"
                onClick={() => {
                  handleCreateRun().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Play size={14} />
                <span>Run</span>
              </button>
            </div>
          </div>

          <div className="runtimeActions">
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleResponseStream().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Bot size={14} />
              <span>Resp SSE</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleSessionStream().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Send size={14} />
              <span>Sess SSE</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleRunEventStream().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Activity size={14} />
              <span>Run SSE</span>
            </button>
          </div>

          <div className="runtimeActions">
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleCreateProfile().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <UserCircle2 size={14} />
              <span>Profile</span>
            </button>
            <button
              className="miniButton danger"
              disabled={!lastHermesProfileName}
              type="button"
              onClick={() => {
                handleDeleteProfile().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <CircleAlert size={14} />
              <span>Del Prof</span>
            </button>
          </div>

          <div className="runtimeActions">
            <button
              className="miniButton danger"
              disabled={!currentHermesRunId || hermesRun?.status === "completed"}
              type="button"
              onClick={() => {
                handleStopRun().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Square size={13} />
              <span>Stop</span>
            </button>
            <button
              className="miniButton success"
              disabled={!currentHermesRunId}
              type="button"
              onClick={() => {
                handleApproval("approved").catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <CheckCircle2 size={14} />
              <span>Approve</span>
            </button>
            <button
              className="miniButton"
              disabled={!currentHermesRunId}
              type="button"
              onClick={() => {
                handleApproval("rejected").catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <CircleAlert size={14} />
              <span>Reject</span>
            </button>
          </div>

          <div className="runtimeActions">
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleCreateSession().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <MessageSquare size={14} />
              <span>Session</span>
            </button>
            <button
              className="miniButton success"
              type="button"
              onClick={() => {
                handleSessionChat().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Send size={14} />
              <span>Chat</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleForkSession().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <GitBranch size={14} />
              <span>Fork</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleUpdateSession().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Command size={14} />
              <span>Rename</span>
            </button>
            <button
              className="miniButton danger"
              type="button"
              onClick={() => {
                handleDeleteSession().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <CircleAlert size={14} />
              <span>Del Sess</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handleCreateJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <History size={14} />
              <span>Job</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handlePatchJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Command size={14} />
              <span>Patch</span>
            </button>
          </div>

          <div className="runtimeActions">
            <button
              className="miniButton success"
              type="button"
              onClick={() => {
                handleRunJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Play size={14} />
              <span>Run Job</span>
            </button>
            <button
              className="miniButton"
              type="button"
              onClick={() => {
                handlePauseJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Square size={13} />
              <span>Pause</span>
            </button>
            <button
              className="miniButton success"
              type="button"
              onClick={() => {
                handleResumeJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <Play size={14} />
              <span>Resume</span>
            </button>
            <button
              className="miniButton danger"
              type="button"
              onClick={() => {
                handleDeleteJob().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <CircleAlert size={14} />
              <span>Del Job</span>
            </button>
          </div>

          {actionMessage ? <div className="actionNote">{actionMessage}</div> : null}
          {upstreamDiagnostics ? (
            <div className={upstreamDiagnostics.ready ? "actionNote" : "actionNote warning"}>
              Official Hermes: {upstreamDiagnostics.ready ? "ready" : "not ready"} · status=
              {upstreamDiagnostics.upstreamStatus} · base=
              {String(upstreamDiagnostics.baseUrlConfigured)} · key=
              {String(upstreamDiagnostics.apiKeyConfigured)} · provider=
              {Object.entries(upstreamDiagnostics.providerKeys || {})
                .filter(([, enabled]) => enabled)
                .map(([name]) => name.replace("_API_KEY", ""))
                .join(", ") ||
                Object.entries(upstreamDiagnostics.oauthProviders || {})
                  .filter(([, enabled]) => enabled)
                  .map(([name]) => name)
                  .join(", ") ||
                "none"}
              {upstreamDiagnostics.codex ? (
                <>
                  {" "}
                  · runtime={upstreamDiagnostics.codex.openaiRuntime || "auto"} · codex=
                  {upstreamDiagnostics.codex.ready ? "ready" : "not ready"}
                </>
              ) : null}
            </div>
          ) : null}
          {lastHermesResponseId ? <div className="mutedLine">response={lastHermesResponseId}</div> : null}
          {hermesAuditResults.length > 0 ? (
            <div className="streamRail">
              {hermesAuditResults.map((result, index) => (
                <div className="streamRow" key={`${result}-${index}`}>
                  {result}
                </div>
              ))}
            </div>
          ) : null}
          {hermesStreamEvents.length > 0 ? (
            <div className="streamRail">
              {hermesStreamEvents.map((event, index) => (
                <div className="streamRow" key={`${event}-${index}`}>
                  {event}
                </div>
              ))}
            </div>
          ) : null}

          <div className="capabilityGrid">
            <div>
              <strong>{hermesCatalog?.profiles.profiles.length ?? 0}</strong>
              <span>Profiles</span>
            </div>
            <div>
              <strong>{hermesCatalog?.models.data.length ?? 0}</strong>
              <span>Models</span>
            </div>
            <div>
              <strong>{skills.length}</strong>
              <span>Skills</span>
            </div>
            <div>
              <strong>{toolsets.length}</strong>
              <span>Toolsets</span>
            </div>
            <div>
              <strong>{listCount(hermesCatalog?.sessions, "sessions")}</strong>
              <span>Sessions</span>
            </div>
            <div>
              <strong>{listCount(hermesCatalog?.jobs, "jobs")}</strong>
              <span>Jobs</span>
            </div>
          </div>

          <div className="featureBands">
            <section>
              <span className="sectionLabel">Enabled</span>
              <div className="featurePills">
                {enabledFeatures.map(([feature]) => (
                  <em key={feature}>{feature}</em>
                ))}
              </div>
            </section>
            <section>
              <span className="sectionLabel">Unavailable</span>
              <div className="featurePills muted">
                {disabledFeatures.map(([feature]) => (
                  <em key={feature}>{feature}</em>
                ))}
              </div>
            </section>
          </div>

          <div className="hermesLists">
            <section>
              <span className="sectionLabel">Models</span>
              {(hermesCatalog?.models.data || []).map((model) => (
                <div className="compactRow" key={model.id}>
                  <Bot size={13} />
                  <span>{model.id}</span>
                </div>
              ))}
            </section>
            <section>
              <span className="sectionLabel">Skills</span>
              {skills.length === 0 ? (
                <div className="mutedLine">No skills reported</div>
              ) : (
                skills.slice(0, 8).map((skill, index) => (
                  <div className="compactRow" key={`${stringifyShort(skill)}-${index}`}>
                    <Sparkles size={13} />
                    <span>{stringifyShort(skill)}</span>
                  </div>
                ))
              )}
            </section>
            <section>
              <span className="sectionLabel">Toolsets</span>
              {toolsets.length === 0 ? (
                <div className="mutedLine">No toolsets reported</div>
              ) : (
                toolsets.slice(0, 8).map((toolset, index) => (
                  <div className="compactRow" key={`${stringifyShort(toolset)}-${index}`}>
                    <Command size={13} />
                    <span>{stringifyShort(toolset)}</span>
                  </div>
                ))
              )}
            </section>
            <section>
              <span className="sectionLabel">Sessions / Jobs</span>
              <div className="compactRow">
                <MessageSquare size={13} />
                <span>{listCount(hermesCatalog?.sessions, "sessions")} sessions</span>
              </div>
              <div className="compactRow">
                <History size={13} />
                <span>{listCount(hermesCatalog?.jobs, "jobs")} jobs</span>
              </div>
            </section>
          </div>
        </div>
      );
    }

    if (activeWorkbenchTab === "terminal") {
      return (
        <div className="terminalSurface" aria-label="Terminal output">
          <div>$ termes task inspect {selectedTask ? compactTaskId(selectedTask.id) : "pending"}</div>
          <div>
            project={selectedProject?.key || "none"} runtime=hermes run=
            {latestSession?.hermesRunId || "pending"}
          </div>
          {displayedTaskEvents.slice(0, 12).map((event) => (
            <div key={event.id}>
              [{eventTime(event.createdAt)}] {event.type} {payloadText(event)}
            </div>
          ))}
          <div className="terminalCursor">_</div>
        </div>
      );
    }

    if (activeWorkbenchTab === "files") {
      const generatedFiles = artifactChangedFiles(latestArtifact?.metadata).map((file) => {
        const name = changedFileName(file);
        return latestRun?.worktreePath ? `${latestRun.worktreePath}/${name}` : name;
      });
      const runtimeFiles = [
        latestRun?.worktreePath,
        latestCheckpoint?.snapshotUri,
        latestArtifact?.uri,
        ...generatedFiles,
      ].filter((value): value is string => Boolean(value));
      const files = runtimeFiles.length > 0 ? runtimeFiles : fileTree;

      return (
        <div className="fileMatrix">
          {files.map((file) => (
            <div className="fileMatrixRow" key={file}>
              <FileCode2 size={15} />
              <span>{file}</span>
            </div>
          ))}
        </div>
      );
    }

    if (activeWorkbenchTab === "logs") {
      return (
        <div className="logList">
          {displayedTaskEvents.length === 0 ? (
            <div className="mutedLine">No runtime events yet.</div>
          ) : (
            displayedTaskEvents.map((event) => (
              <div className="logRow" key={event.id}>
                <span>{eventTime(event.createdAt)}</span>
                <strong>{event.type}</strong>
                <em>{event.taskId ? compactTaskId(event.taskId) : "global"}</em>
              </div>
            ))
          )}
        </div>
      );
    }

    return (
      <div className="diffSurface">
        <div className="diffHeader">
          <span>{latestCheckpoint ? "checkpoint.patch" : "runtime.patch"}</span>
          <span>{latestSession?.hermesRunId || (selectedTask ? compactTaskId(selectedTask.id) : "no-task")}</span>
        </div>
        <pre>
          {latestCheckpoint
            ? (() => {
                const generatedFiles = artifactChangedFiles(latestArtifact?.metadata);
                const files = generatedFiles.length > 0 ? generatedFiles : latestCheckpoint.changedFiles;
                return [
                  `checkpoint=${latestCheckpoint.id}`,
                  `snapshot=${latestCheckpoint.snapshotUri || "none"}`,
                  `artifact=${latestArtifact?.uri || "none"}`,
                  `checksum=${latestCheckpoint.checksum || "none"}`,
                  `changedFiles=${files.length}`,
                  ...files.map((file) => `  - ${changedFileName(file)}`),
                  "",
                  artifactOutput(latestArtifact?.metadata) || latestCheckpoint.summary,
                ].join("\n");
              })()
            : selectedTask
              ? "Hermes run is preparing runtime output. Events will appear as the task advances."
              : "Select or create a task to inspect runtime output."}
        </pre>
      </div>
    );
  }

  function renderMemberDialog(): JSX.Element | null {
    if (!memberDialog) return null;
    const closeDialog = () => {
      if (memberActionBusy) return;
      setMemberDialog(null);
      setMemberActionError(null);
      setCurrentPassword("");
      setNewPassword("");
      setNewPasswordConfirm("");
    };
    return (
      <div className="memberDialogBackdrop">
        <section
          ref={memberDialogRef}
          className="memberDialog"
          role="dialog"
          tabIndex={-1}
          aria-modal="true"
          aria-labelledby="member-dialog-title"
          aria-busy={memberActionBusy || approvingMemberId !== null}
        >
          <header className="memberDialogHeader">
            <img className="memberDialogAppIcon" src="/termes-icon-launcher-v3-512.png" alt="" />
            <div>
              <p className="accountGateEyebrow">TERMES MEMBERSHIP</p>
              <h2 id="member-dialog-title">{memberDialog === "password" ? "비밀번호 변경" : "회원 승인"}</h2>
              <p>{memberDialog === "password"
                ? "변경 후 모든 기기에서 다시 로그인해야 합니다."
                : "가입 요청을 검토하고 현재 Account 사용을 승인합니다."}</p>
            </div>
            <button className="memberDialogClose" type="button" aria-label="닫기" disabled={memberActionBusy} onClick={closeDialog}>
              <X size={20} />
            </button>
          </header>

          {memberDialog === "password" ? (
            <form className="memberDialogForm" onSubmit={(event) => void handlePasswordChange(event)}>
              <label className="accountAccessField">
                <span>현재 비밀번호</span>
                <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} disabled={memberActionBusy} required autoFocus />
              </label>
              <label className="accountAccessField">
                <span>새 비밀번호</span>
                <input type="password" autoComplete="new-password" minLength={12} maxLength={512} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} disabled={memberActionBusy} required />
                <small>12자 이상이며 현재 비밀번호와 달라야 합니다.</small>
              </label>
              <label className="accountAccessField">
                <span>새 비밀번호 확인</span>
                <input type="password" autoComplete="new-password" minLength={12} maxLength={512} value={newPasswordConfirm} onChange={(event) => setNewPasswordConfirm(event.target.value)} disabled={memberActionBusy} aria-invalid={Boolean(newPasswordConfirm && newPassword !== newPasswordConfirm)} aria-describedby={memberActionError ? "member-password-error" : undefined} required />
              </label>
              <p className="memberDialogNotice"><ShieldCheck size={19} />현재 세션을 포함한 모든 로그인 세션이 종료됩니다.</p>
              {memberActionError ? <p id="member-password-error" className="accountGateError" role="alert">{memberActionError}</p> : null}
              <button className="accountGateSubmit" type="submit" disabled={memberActionBusy}>
                {memberActionBusy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
                <span>{memberActionBusy ? "변경 중" : "비밀번호 변경"}</span>
              </button>
            </form>
          ) : (
            <div className="memberApprovalBody">
              {!memberApprovalLoadFailed ? <p className="memberApprovalSummary">승인 대기 {pendingMembers.length}명</p> : null}
              {memberApprovalLoadFailed ? (
                <div className="memberApprovalEmpty memberApprovalFailure"><CircleAlert size={22} />승인 요청을 불러오지 못했습니다.</div>
              ) : memberActionBusy && pendingMembers.length === 0 ? (
                <div className="memberApprovalEmpty"><Loader2 className="spin" size={20} />승인 요청을 불러오고 있습니다.</div>
              ) : pendingMembers.length === 0 ? (
                <div className="memberApprovalEmpty"><CheckCircle2 size={22} />대기 중인 가입 요청이 없습니다.</div>
              ) : (
                <div className="memberApprovalList">
                  {pendingMembers.map((member) => (
                    <article className="memberApprovalRow" key={member.memberId}>
                      <UserCircle2 size={30} aria-hidden="true" />
                      <div>
                        <strong>{member.displayName}</strong>
                        <span>{member.loginId} · {member.email}</span>
                      </div>
                      <button type="button" aria-label={`${member.displayName} 회원 승인`} disabled={approvingMemberId !== null} onClick={() => void handleMemberApproval(member.memberId)}>
                        {approvingMemberId === member.memberId ? <Loader2 className="spin" size={16} /> : null}승인
                      </button>
                    </article>
                  ))}
                </div>
              )}
              {memberActionError ? <p className="accountGateError" role="alert">{memberActionError}</p> : null}
              <p className="memberDialogBoundary">승인은 회원을 현재 관리자의 Account에 연결합니다. 새 Runtime Cell은 생성하지 않습니다.</p>
            </div>
          )}
        </section>
      </div>
    );
  }

  if (accountAuthLoading) {
    return (
      <main className="accountGate" aria-busy="true">
        <section className="accountGateCard compact">
          <span className="accountGateMark"><Sparkles size={20} /></span>
          <p>Termes workspace를 확인하고 있습니다.</p>
          <Loader2 className="spin" size={20} aria-hidden="true" />
        </section>
      </main>
    );
  }

  if (!accountPrincipal) {
    return (
      <main className="accountGate">
        <aside className="accountGateBrand" aria-hidden="true">
          <img src="/termes-icon-launcher-v3-512.png" alt="" />
          <h2>함께 일할 준비를<br />안전하게 마치세요</h2>
          <p>회원가입 후 관리자의 승인을 받으면 기존 Account Workspace에서 작업할 수 있습니다.</p>
        </aside>
        <section className="accountGateCard" aria-labelledby="account-gate-title">
          <div className="accountGateIntro">
            <img className="accountGateAppIcon" src="/termes-icon-launcher-v3-512.png" alt="" />
            <div>
              <p className="accountGateEyebrow">TERMES MEMBERSHIP</p>
              <h1 id="account-gate-title">{accountAuthMode === "login" ? "회원 로그인" : "회원가입"}</h1>
            </div>
          </div>
          <p className="accountGateDescription">
            {accountAuthMode === "login"
              ? "로그인한 회원의 Workspace에서 작업을 이어갑니다."
              : "가입 정보를 보내면 관리자 승인 후 로그인할 수 있습니다."}
          </p>
          <div className="accountAuthTabs" role="tablist" aria-label="인증 방식">
            <button type="button" role="tab" aria-selected={accountAuthMode === "login"} className={accountAuthMode === "login" ? "active" : ""} disabled={accountAuthBusy} onClick={() => { setAccountAuthMode("login"); setAccountAuthError(null); }}>
              로그인
            </button>
            <button type="button" role="tab" aria-selected={accountAuthMode === "register"} className={accountAuthMode === "register" ? "active" : ""} disabled={accountAuthBusy} onClick={() => { setAccountAuthMode("register"); setAccountAuthError(null); setAccountAuthNotice(null); }}>
              회원가입
            </button>
          </div>
          {accountAuthMode === "login" ? (
            <form className="accountGateForm" aria-busy={accountAuthBusy} onSubmit={(event) => void handleAccountLogin(event)}>
              <label className="accountAccessField">
                <span>아이디</span>
                <input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} value={accountLoginId} onChange={(event) => setAccountLoginId(event.target.value)} placeholder="아이디를 입력하세요" disabled={accountAuthBusy} autoFocus required />
              </label>
              <label className="accountAccessField">
                <span>비밀번호</span>
                <input type="password" autoComplete="current-password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} placeholder="비밀번호를 입력하세요" disabled={accountAuthBusy} required />
              </label>
              {accountAuthNotice ? <p className="accountGateNotice" role="status">{accountAuthNotice}</p> : null}
              {accountAuthError ? <p className="accountGateError" role="alert">{accountAuthError}</p> : null}
              <button className="accountGateSubmit" type="submit" disabled={accountAuthBusy || !accountLoginId.trim() || !accountPassword}>
                {accountAuthBusy ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
                <span>{accountAuthBusy ? "확인 중" : "계속"}</span>
              </button>
            </form>
          ) : (
            <form className="accountGateForm registration" aria-busy={accountAuthBusy} onSubmit={(event) => void handleAccountRegistration(event)}>
              <label className="accountAccessField"><span>이름</span><input type="text" autoComplete="name" maxLength={80} value={registrationName} onChange={(event) => setRegistrationName(event.target.value)} placeholder="표시할 이름" disabled={accountAuthBusy} autoFocus required /></label>
              <label className="accountAccessField"><span>아이디</span><input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._-]*" value={registrationLoginId} onChange={(event) => setRegistrationLoginId(event.target.value)} placeholder="영문, 숫자, 점, 밑줄, 하이픈" disabled={accountAuthBusy} required /></label>
              <label className="accountAccessField"><span>이메일</span><input type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={registrationEmail} onChange={(event) => setRegistrationEmail(event.target.value)} placeholder="name@domain.com" disabled={accountAuthBusy} required /></label>
              <label className="accountAccessField"><span>비밀번호</span><input type="password" autoComplete="new-password" minLength={12} maxLength={512} value={registrationPassword} onChange={(event) => setRegistrationPassword(event.target.value)} placeholder="12자 이상" disabled={accountAuthBusy} required /></label>
              <label className="accountAccessField"><span>비밀번호 확인</span><input type="password" autoComplete="new-password" minLength={12} maxLength={512} value={registrationPasswordConfirm} onChange={(event) => setRegistrationPasswordConfirm(event.target.value)} placeholder="다시 입력하세요" disabled={accountAuthBusy} aria-invalid={Boolean(registrationPasswordConfirm && registrationPassword !== registrationPasswordConfirm)} aria-describedby={accountAuthError ? "registration-error" : undefined} required /></label>
              {accountAuthError ? <p id="registration-error" className="accountGateError" role="alert">{accountAuthError}</p> : null}
              <button className="accountGateSubmit" type="submit" disabled={accountAuthBusy}>
                {accountAuthBusy ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
                <span>{accountAuthBusy ? "요청 중" : "승인 요청 보내기"}</span>
              </button>
              <p className="registrationBoundary">가입은 승인 요청만 생성합니다. 새 Runtime Cell은 생성하지 않습니다.</p>
            </form>
          )}
        </section>
      </main>
    );
  }

  if (experience === "mobile") {
    return (
      <>
        <MobileExperience
        account={accountPrincipal}
        projects={projects}
        tasks={tasks}
        events={events}
        selectedProject={selectedProject}
        selectedTask={selectedTask}
        runtime={taskRuntime}
        taskPlan={taskPlan}
        verificationResults={verificationResults}
        devices={devices}
        screen={mobileScreen}
        loading={loading}
        error={error}
        search={taskSearch}
        instructions={instructions}
        newTaskMode={newTaskMode}
        sendingMessage={sendingMessage}
        interactionInput={interactionInput}
        interactionSending={interactionSending}
        voiceListening={voiceListening}
        voiceSupported={voiceSupported}
        theme={theme}
        pwaStandalone={pwaStandalone}
        pwaInstalled={pwaInstalled}
        pwaInstallAvailable={pwaInstallMode !== null}
        pwaInstallBannerVisible={pwaInstallBannerVisible}
        pwaInstallBusy={pwaInstallBusy}
        pwaInstallHelpVisible={pwaInstallHelpVisible}
        pwaInstallMode={pwaInstallMode}
        openAiConnected={openAiConnected}
        openAiAuthBusy={openAiAuthBusy}
        openAiAuthMessage={openAiAuthMessage}
        codexOAuthSession={codexOAuthSession}
        connectionReady={Boolean(upstreamDiagnostics?.ready || upstreamStatus === "ok")}
        connectionLabel={upstreamDiagnostics?.ready ? hermesMode : upstreamStatus === "error" ? "연결 확인 필요" : hermesRuntimeDetail}
        githubStatus={githubStatus}
        githubRepositoryGroups={githubRepositoryGroups}
        projectFolders={projectFolders}
        onNavigate={(screen) => {
          if (screen === "tasks") setNewTaskMode(false);
          setMobileScreen(screen);
        }}
        onSelectProject={(projectId) => {
          selectProjectState(projectId);
          selectTaskState("");
          setNewTaskMode(false);
          setTitle("");
          setMobileScreen("tasks");
          refresh(projectId, "").catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
        onOpenProjectSources={async () => {
          await Promise.all([loadProjectFolders(), loadGitHubProjectState()]);
        }}
        onGitHubLogin={startGitHubLogin}
        onGitHubLogout={async () => {
          const status = await disconnectGitHub();
          setGithubStatus(status);
          setGithubRepositoryGroups([]);
          setSelectedGithubRepository("");
        }}
        onCloneGitHubProject={async (repositoryFullName, parentPath) => {
          const result = await cloneGitHubProject({
            repositoryFullName,
            ...(parentPath ? { parentPath } : {}),
          });
          selectProjectState(result.project.id);
          selectTaskState("");
          setTaskRuntime(null);
          setNewTaskMode(false);
          setTitle("");
          setMobileScreen("tasks");
          await refresh(result.project.id, "");
          await loadProjectFolders();
        }}
        onRegisterProjectFolder={async (path) => {
          const result = await registerProjectFolder({ path });
          selectProjectState(result.project.id);
          selectTaskState("");
          setTaskRuntime(null);
          setNewTaskMode(false);
          setTitle("");
          setMobileScreen("tasks");
          await refresh(result.project.id, "");
        }}
        onCreateProjectFolder={async (name, parentPath) => {
          const result = await createProjectFolder({
            name,
            ...(parentPath ? { parentPath } : {}),
          });
          await loadProjectFolders();
          return result.path;
        }}
        onSelectTask={(taskId) => {
          selectTaskState(taskId);
          setNewTaskMode(false);
          setTitle("");
          setMobileScreen("conversation");
        }}
        onRenameTask={(task) => {
          handleRenameTask(task).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
        onDeleteTask={(task) => {
          handleDeleteTask(task).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
        onStartNewTask={() => {
          setNewTaskMode(true);
          setTitle("");
          setInstructions("");
          setMobileScreen("conversation");
        }}
        onSearchChange={setTaskSearch}
        onInstructionsChange={setInstructions}
        onInteractionInputChange={setInteractionInput}
        onSubmit={(event) => void handleSubmit(event)}
        onInteraction={(input) => void handleHermesInteractionResponse(input)}
        onRefresh={() => {
          refresh().catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }}
        onToggleVoice={toggleVoiceInput}
        onThemeChange={setTheme}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissPwaInstall={handleDismissPwaInstall}
        onConnectOpenAi={() => void handleOpenAiConnect()}
        onChangePassword={openPasswordDialog}
        onApproveMembers={() => void openMemberApproval()}
        onLogout={() => void handleAccountLogout()}
        />
        {renderMemberDialog()}
        {pendingHermesInteraction?.type === "approval" ? (
          <ApprovalGate
            interaction={pendingHermesInteraction}
            sending={interactionSending}
            onDecision={(choice) => void handleHermesInteractionResponse({ type: "approval", choice })}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <main className={`telegram-shell termesAliasShell mobileView-${mobileView}`}>
      <div className="aliasChrome">
        <header className="aliasHeader">
          <button className="aliasIconButton" type="button" title="Menu" onClick={() => setMobileView("list")}>
            <Menu size={20} />
          </button>
          <div className="aliasTitleBlock">
            <h1>Termes</h1>
            <button
              className="aliasBridge"
              type="button"
              onClick={() => {
                handleUpstreamDiagnostics().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <span className={upstreamDiagnostics?.ready ? "signalDot online" : "signalDot"} />
              <span>{hermesMode}</span>
              <Wifi size={13} />
            </button>
            <span className="autonomyModeBadge" title={maximumAutonomyPolicy.automatic.join(" · ")}>
              <ShieldCheck size={12} />
              최대 자율주행
            </span>
          </div>
          <div className="accountHeaderActions">
            <button
              className={searchOpen ? "aliasIconButton active" : "aliasIconButton"}
              type="button"
              title="Search"
              onClick={() => setSearchOpen((current) => !current)}
            >
              <Search size={19} />
            </button>
            <button className="aliasIconButton" type="button" title="비밀번호 변경" aria-label="비밀번호 변경" onClick={openPasswordDialog}>
              <ShieldCheck size={18} />
            </button>
            {accountPrincipal.canApproveMembers ? (
              <button className="aliasIconButton" type="button" title="회원 승인" onClick={() => void openMemberApproval()}>
                <UserCircle2 size={18} />
              </button>
            ) : null}
            <button className="aliasIconButton" type="button" title={`${accountPrincipal.displayName}에서 나가기`} onClick={() => void handleAccountLogout()}>
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {searchOpen ? (
          <div className="aliasSearch">
            <Search size={15} />
            <input
              value={taskSearch}
              onChange={(event) => setTaskSearch(event.target.value)}
              placeholder="채팅창 검색"
              type="search"
            />
          </div>
        ) : null}

        <div className="project-chip-row aliasProjectChips">
          {projects.map((project) => (
            <button
              className={project.id === selectedProject?.id ? "project-chip-button active" : "project-chip-button"}
              key={project.id}
              type="button"
              title={project.workspacePath ? `${project.name} · ${project.workspacePath}` : project.name}
              onClick={() => {
                selectProjectState(project.id);
                selectTaskState("");
                refresh(project.id, "").catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              {project.name}
            </button>
          ))}
          <button
            className={projectPanelOpen ? "project-chip-button active" : "project-chip-button"}
            type="button"
            title="프로젝트 등록"
            data-testid="open-project-drawer"
            onClick={() => openProjectDrawer("folder")}
          >
            <FolderPlus size={14} />
            프로젝트 등록
          </button>
          <button
            className={devicesPanelOpen ? "project-chip-button active" : "project-chip-button"}
            type="button"
            title="Devices"
            data-testid="open-devices-drawer"
            onClick={() => setDevicesPanelOpen(true)}
          >
            <Terminal size={14} />
            Devices
          </button>
          <button
            className="project-chip-button iconOnly"
            type="button"
            title="프로젝트 이름 변경"
            disabled={!selectedProject}
            onClick={() => {
              handleRenameProject().catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
          >
            <Pencil size={14} />
          </button>
          <button
            className="project-chip-button iconOnly danger"
            type="button"
            title="프로젝트 삭제"
            disabled={!selectedProject}
            onClick={() => {
              handleDeleteProject().catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              });
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>

        {projectPanelOpen ? createPortal(
          <form
            className="projectDrawerBackdrop"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onClick={() => setProjectPanelOpen(false)}
          >
            <section
              className="projectDrawer"
              aria-label="새 프로젝트 등록"
              data-testid="project-drawer"
              ref={projectDrawerRef}
              onClick={(event) => event.stopPropagation()}
            >
              <header className="projectDrawerHeader">
                <div>
                  <span className="sectionLabel">{projectCreateMode === "github" ? "GitHub Workspace" : "Folder Workspace"}</span>
                  <h2>새 프로젝트 등록</h2>
                </div>
                <button className="aliasIconButton" type="button" title="닫기" onClick={() => setProjectPanelOpen(false)}>
                  <X size={17} />
                </button>
              </header>

              <div className="projectDrawerTabs" role="tablist" aria-label="프로젝트 등록 방식">
                <button
                  type="button"
                  className={projectCreateMode === "folder" ? "active" : ""}
                  onClick={() => setProjectCreateMode("folder")}
                >
                  <FolderOpen size={15} />
                  폴더 프로젝트
                </button>
                <button
                  type="button"
                  className={projectCreateMode === "github" ? "active" : ""}
                  onClick={() => setProjectCreateMode("github")}
                >
                  <Github size={15} />
                  GitHub 프로젝트
                </button>
              </div>

              {projectCreateMode === "folder" ? (
                <div className="projectFolderPanel">
                  <p className="projectDrawerMessage">{folderBusy ? "폴더 작업 처리 중..." : folderMessage}</p>

                  <ProjectDirectoryTree
                    folders={projectFolders}
                    selectedPath={folderPath}
                    onSelect={setFolderPath}
                    emptyLabel="등록할 수 있는 폴더가 없습니다. 새 폴더를 먼저 생성해 주세요."
                    label="워크스페이스 폴더"
                    createDisabled={folderBusy}
                    onCreateFolder={() => openProjectFolderCreateDialog("folder")}
                  />

                  <div className="projectFolderTreeActions">
                    <span>{folderPath ? `${projectFolderLabel(folderPath)} 선택됨` : "Workspace root 선택됨"}</span>
                  </div>

                  <div className="projectDrawerActions">
                    <button className="aliasActionButton secondary" type="button" onClick={() => setProjectPanelOpen(false)}>
                      취소
                    </button>
                    <button
                      className="aliasActionButton primary"
                      type="button"
                      data-testid="submit-folder-project"
                      disabled={folderBusy || !folderPath.trim()}
                      onClick={() => {
                        handleRegisterFolderWorkspace().catch((cause: unknown) => {
                          setFolderMessage(cause instanceof Error ? cause.message : String(cause));
                        });
                      }}
                    >
                      <FolderPlus size={15} />
                      프로젝트 폴더로 선택
                    </button>
                  </div>
                </div>
              ) : (
                <div className="githubProjectPanel">
                  <section className="githubAuthCard">
                    <div>
                      <Github size={18} />
                      <strong>{githubConnected ? `GitHub 인증 관리 · ${githubStatus?.login || "GitHub"} 연결됨` : "GitHub 인증 관리 · 로그인이 필요합니다"}</strong>
                    </div>
                    <div className="githubAuthActions">
                      {githubConnected ? (
                        <button
                          className="aliasActionButton secondary"
                          type="button"
                          disabled={githubBusy}
                          onClick={() => {
                            handleDisconnectGitHub().catch((cause: unknown) => {
                              setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                            });
                          }}
                        >
                          연결 해제
                        </button>
                      ) : null}
                      {!githubConnected ? (
                        <button
                          className="aliasActionButton primary"
                          type="button"
                          disabled={githubBusy || !githubStatus?.deviceConfigured}
                          onClick={() => {
                            handleStartGitHubDeviceLogin().catch((cause: unknown) => {
                              setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                            });
                          }}
                        >
                          Device 코드
                        </button>
                      ) : null}
                      <button
                        className="aliasActionButton secondary"
                        type="button"
                        disabled={githubBusy || !githubStatus?.browserOAuthEnabled}
                        onClick={startGitHubLogin}
                      >
                        <Github size={15} />
                        {githubConnected ? "다른 계정 로그인" : "Browser OAuth"}
                      </button>
                    </div>
                  </section>

                  <p className="projectDrawerMessage">{githubBusy ? "GitHub 작업 처리 중..." : githubMessage}</p>

                  {githubDeviceLogin ? (
                    <section className="githubDeviceCard">
                      <div>
                        <strong>GitHub verification code</strong>
                        <input readOnly value={githubDeviceLogin.userCode} aria-label="GitHub verification code" />
                        <span>
                          {new Date(githubDeviceLogin.expiresAt).toLocaleTimeString("ko-KR")}까지 유효 · 자동 확인 중
                        </span>
                      </div>
                      <div className="githubDeviceActions">
                        <a href={githubDeviceLogin.verificationUriComplete || githubDeviceLogin.verificationUri} target="_blank" rel="noreferrer">
                          github.com/login/device
                        </a>
                        <button
                          className="aliasActionButton secondary"
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText(githubDeviceLogin.userCode).catch(() => undefined);
                          }}
                        >
                          코드 복사
                        </button>
                        <button
                          className="aliasActionButton primary"
                          type="button"
                          disabled={githubBusy}
                          onClick={() => {
                            handlePollGitHubDeviceLogin().catch((cause: unknown) => {
                              setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                            });
                          }}
                        >
                          지금 확인
                        </button>
                      </div>
                    </section>
                  ) : null}

                  <label className="projectDrawerField">
                    <span>저장소 검색</span>
                    <input
                      value={githubSearch}
                      onChange={(event) => setGithubSearch(event.target.value)}
                      placeholder="저장소 이름 검색"
                    />
                  </label>

                  <div className="githubRepositoryList" aria-label="GitHub 저장소 목록">
                    {!githubConnected ? (
                      <div className="githubRepositoryEmpty">GitHub 로그인 후 저장소 목록을 확인할 수 있습니다.</div>
                    ) : filteredGithubRepositoryGroups.length === 0 ? (
                      <div className="githubRepositoryEmpty">표시할 저장소가 없습니다.</div>
                    ) : (
                      filteredGithubRepositoryGroups.map((group) => (
                        <section className="githubRepositoryGroup" key={group.groupId}>
                          <div className="githubRepositoryGroupHeader">
                            <strong>{group.label}</strong>
                            <span>{group.error || `@${group.owner}`}</span>
                          </div>
                          {group.repositories.map((repository) => (
                            <button
                              className={selectedGithubRepository === repository.fullName ? "githubRepositoryRow active" : "githubRepositoryRow"}
                              data-testid="github-repository-select"
                              key={repository.fullName}
                              type="button"
                              onClick={() => setSelectedGithubRepository(repository.fullName)}
                            >
                              <div>
                                <strong>{repository.fullName}</strong>
                                <span>{repository.visibility} · {repository.defaultBranch}</span>
                              </div>
                              <span>{selectedGithubRepository === repository.fullName ? "선택됨" : "선택"}</span>
                            </button>
                          ))}
                        </section>
                      ))
                    )}
                  </div>

                  <section className="githubCloneTarget">
                    <div>
                      <span>선택한 저장소</span>
                      <strong>{selectedGithubRepository || "저장소 목록에서 선택해 주세요."}</strong>
                    </div>

                    <ProjectDirectoryTree
                      folders={projectFolders}
                      selectedPath={githubCloneParentPath}
                      onSelect={setGithubCloneParentPath}
                      emptyLabel="clone 위치로 선택할 폴더가 없습니다. 새 폴더를 추가해 주세요."
                      label="워크스페이스 클론 폴더"
                      createDisabled={githubBusy}
                      onCreateFolder={() => openProjectFolderCreateDialog("github")}
                    />

                    <div className="projectFolderTreeActions">
                      <span>{githubCloneParentPath ? `${projectFolderLabel(githubCloneParentPath)} 선택됨` : "Workspace root 선택됨"}</span>
                    </div>

                    <button
                      className="aliasActionButton primary fullWidth"
                      data-testid="github-clone-selected"
                      type="button"
                      disabled={githubBusy || !githubConnected || !selectedGithubRepository}
                      onClick={() => {
                        handleCloneGitHubProject(selectedGithubRepository).catch((cause: unknown) => {
                          setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                        });
                      }}
                    >
                      <Github size={15} />
                      Clone 후 프로젝트 폴더로 선택
                    </button>
                  </section>
                </div>
              )}
            </section>
          </form>,
          document.body,
        ) : null}

        {projectFolderCreateDialog ? createPortal(
          <div className="projectFolderCreateBackdrop" role="presentation" onClick={() => setProjectFolderCreateDialog(null)}>
            <form
              className="projectFolderCreateDialog"
              data-testid="project-folder-create-dialog"
              aria-label="새 폴더 생성"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                handleCreateProjectFolderFromDialog().catch((cause: unknown) => {
                  const setMessage = projectFolderCreateDialog === "github" ? setGithubMessage : setFolderMessage;
                  setMessage(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <header>
                <div>
                  <span className="sectionLabel">Workspace folder</span>
                  <h2>새 폴더</h2>
                </div>
                <button className="aliasIconButton" type="button" title="닫기" onClick={() => setProjectFolderCreateDialog(null)}>
                  <X size={17} />
                </button>
              </header>
              <p>{projectFolderCreateDialog === "github" ? projectFolderLabel(githubCloneParentPath) : projectFolderLabel(folderPath)} 아래에 생성합니다.</p>
              <label className="projectDrawerField">
                <span>폴더 이름</span>
                <input
                  autoFocus
                  value={projectFolderCreateName}
                  onChange={(event) => setProjectFolderCreateName(event.target.value)}
                  placeholder="예: new-project"
                />
              </label>
              <div className="projectDrawerActions">
                <button className="aliasActionButton secondary" type="button" onClick={() => setProjectFolderCreateDialog(null)}>취소</button>
                <button
                  className="aliasActionButton primary"
                  type="submit"
                  disabled={projectFolderCreateDialog === "github" ? githubBusy || !projectFolderCreateName.trim() : folderBusy || !projectFolderCreateName.trim()}
                >
                  <FolderPlus size={15} /> 생성
                </button>
              </div>
            </form>
          </div>,
          document.body,
        ) : null}

        {devicesPanelOpen ? createPortal(
          <form
            className="projectDrawerBackdrop"
            onSubmit={(event) => {
              event.preventDefault();
            }}
            onClick={() => setDevicesPanelOpen(false)}
          >
            <section
              className="projectDrawer devicesDrawer"
              aria-label="Devices"
              data-testid="devices-drawer"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="projectDrawerHeader">
                <div>
                  <span className="sectionLabel">Device Gateway</span>
                  <h2>Devices</h2>
                </div>
                <button className="aliasIconButton" type="button" title="닫기" onClick={() => setDevicesPanelOpen(false)}>
                  <X size={17} />
                </button>
              </header>

              <p className="projectDrawerMessage">{deviceBusy ? "device 작업 처리 중..." : deviceMessage}</p>

              <DesktopConnectorSection projectId={selectedProject?.id ?? null} />

              <div className="deviceToolbar">
                <button
                  className="aliasActionButton secondary"
                  type="button"
                  disabled={deviceBusy}
                  onClick={() => {
                    refreshDevices(selectedProject?.id).catch((cause: unknown) => {
                      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  <RefreshCw size={15} />
                  새로고침
                </button>
                <button
                  className="aliasActionButton primary"
                  type="button"
                  disabled={deviceBusy || !selectedProject}
                  data-testid="discover-devices"
                  onClick={() => {
                    handleDiscoverDevices().catch((cause: unknown) => {
                      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  <Wifi size={15} />
                  Discover
                </button>
              </div>

              <div className="devicePlatformGrid" role="tablist" aria-label="Device platform">
                {devicePlatforms.map((platform) => (
                  <button
                    key={platform}
                    type="button"
                    className={devicePlatform === platform ? "active" : ""}
                    onClick={() => handleDevicePlatformChange(platform)}
                  >
                    {devicePlatformLabel(platform)}
                  </button>
                ))}
              </div>

              <div className="deviceTransportGrid" role="group" aria-label="Device transport">
                {transportOptions(devicePlatform).map((transport) => (
                  <button
                    key={transport}
                    type="button"
                    className={deviceTransport === transport ? "active" : ""}
                    onClick={() => setDeviceTransport(transport)}
                  >
                    {transport === "ssh" && devicePlatform === "windows" ? "OpenSSH" : transport.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="deviceStatusGrid" role="group" aria-label="Device status filter">
                {deviceStatusFilters.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className={deviceStatusFilter === status ? "active" : ""}
                    onClick={() => {
                      setDeviceStatusFilter(status);
                      const nextDevice = devices.find(
                        (device) =>
                          device.platform === devicePlatform && (status === "all" || device.status === status),
                      );
                      setSelectedDeviceId(nextDevice?.id || "");
                    }}
                  >
                    {status === "all" ? "All" : status}
                  </button>
                ))}
              </div>

              <label className="projectDrawerField">
                <span>장치 이름</span>
                <input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  placeholder="예: Windows Lab 01"
                  data-testid="device-name-input"
                />
              </label>

              <label className="projectDrawerField">
                <span>Endpoint</span>
                <input
                  value={deviceEndpoint}
                  onChange={(event) => setDeviceEndpoint(event.target.value)}
                  placeholder={devicePlatform === "local_mock" ? "local://termes/device-gateway" : "user@host 또는 WinRM URL"}
                  disabled={devicePlatform === "local_mock"}
                  data-testid="device-endpoint-input"
                />
              </label>

              <button
                className="aliasActionButton primary fullWidth"
                type="button"
                disabled={deviceBusy || !selectedProject || !deviceName.trim()}
                data-testid="register-device"
                onClick={() => {
                  handleRegisterDevice().catch((cause: unknown) => {
                    setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Plus size={15} />
                장치 등록
              </button>

              <div className="deviceEditActions">
                <button
                  className="aliasActionButton secondary"
                  type="button"
                  disabled={deviceBusy || !selectedDevice || !deviceName.trim()}
                  data-testid="update-device"
                  onClick={() => {
                    handleUpdateSelectedDevice().catch((cause: unknown) => {
                      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  <Pencil size={15} />
                  선택 장치 저장
                </button>
                <button
                  className="aliasActionButton secondary danger"
                  type="button"
                  disabled={deviceBusy || !selectedDevice}
                  data-testid="delete-device"
                  onClick={() => {
                    handleDeleteSelectedDevice().catch((cause: unknown) => {
                      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  <Trash2 size={15} />
                  장치 삭제
                </button>
              </div>

              <div className="deviceList" aria-label="Device list">
                {devices.length === 0 ? (
                  <div className="githubRepositoryEmpty">등록된 장치가 없습니다. Discover 또는 장치 등록을 실행해 주세요.</div>
                ) : filteredDevicesForPanel.length === 0 ? (
                  <div className="githubRepositoryEmpty">현재 플랫폼과 상태 조건에 맞는 장치가 없습니다.</div>
                ) : (
                  filteredDevicesForPanel.map((device) => (
                    <button
                      key={device.id}
                      type="button"
                      className={selectedDevice?.id === device.id ? "deviceRow active" : "deviceRow"}
                      onClick={() => {
                        setSelectedDeviceId(device.id);
                        setDevicePlatform(device.platform);
                        setDeviceTransport(device.transport);
                        setDeviceAction(defaultActionForPlatform(device.platform));
                        setDeviceParamsText(defaultParamsForAction(defaultActionForPlatform(device.platform)));
                        setLastDeviceCommand(null);
                        setLastDeviceVerification(null);
                      }}
                    >
                      <span className={`deviceBadge platform-${device.platform}`}>{devicePlatformLabel(device.platform)}</span>
                      <span className="deviceRowMain">
                        <strong>{device.name}</strong>
                        <em>{device.transport === "ssh" && device.platform === "windows" ? "OpenSSH" : device.transport}</em>
                      </span>
                      <span className={`statusDot status-${device.status}`}>{device.status}</span>
                    </button>
                  ))
                )}
              </div>

              {selectedDevice ? (
                <section className="deviceDetailPanel" data-testid="device-detail-panel">
                  <div className="deviceDetailHeader">
                    <span className={`deviceBadge platform-${selectedDevice.platform}`}>
                      {devicePlatformLabel(selectedDevice.platform)}
                    </span>
                    <strong>{selectedDevice.name}</strong>
                    <em className={`statusDot status-${selectedDevice.status}`}>{selectedDevice.status}</em>
                  </div>
                  <div className="deviceDetailGrid">
                    <span>transport</span>
                    <strong>
                      {selectedDevice.transport === "ssh" && selectedDevice.platform === "windows"
                        ? "OpenSSH"
                        : selectedDevice.transport}
                    </strong>
                    <span>endpoint</span>
                    <strong>{selectedDevice.endpoint || "not set"}</strong>
                    <span>last seen</span>
                    <strong>{eventDateTime(selectedDevice.lastSeenAt)}</strong>
                    <span>labels</span>
                    <strong>
                      {Object.keys(selectedDevice.labels).length > 0
                        ? Object.entries(selectedDevice.labels)
                            .map(([key, value]) => `${key}=${value}`)
                            .join(", ")
                        : "none"}
                    </strong>
                  </div>
                </section>
              ) : null}

              <section className="deviceCommandPanel">
                <div className="deviceCommandHeader">
                  <strong>{selectedDevice?.name || "장치 선택 필요"}</strong>
                  <span>{selectedTask ? `task ${compactTaskId(selectedTask.id)}` : "task 연결 없음"}</span>
                </div>

                <div className="deviceQuickActions">
                  {quickActionsForPlatform(selectedDevice?.platform || devicePlatform).map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={deviceAction === action ? "active" : ""}
                      onClick={() => {
                        setDeviceAction(action);
                        setDeviceParamsText(defaultParamsForAction(action));
                        setLastDeviceCommand(null);
                        setLastDeviceVerification(null);
                      }}
                    >
                      {action.split(".").slice(1).join(".")}
                    </button>
                  ))}
                </div>

                <label className="projectDrawerField">
                  <span>Action</span>
                  <input value={deviceAction} onChange={(event) => setDeviceAction(event.target.value)} />
                </label>

                <label className="projectDrawerField">
                  <span>Params JSON</span>
                  <textarea
                    value={deviceParamsText}
                    onChange={(event) => setDeviceParamsText(event.target.value)}
                    rows={5}
                    data-testid="device-command-params"
                  />
                </label>

                {deviceCommandBlockedReason ? (
                  <div className="devicePolicyBanner danger">
                    <CircleAlert size={15} />
                    <span>{deviceCommandBlockedReason}</span>
                  </div>
                ) : null}

                <button
                  className="aliasActionButton primary fullWidth"
                  type="button"
                  disabled={deviceBusy || !selectedDevice || Boolean(deviceCommandBlockedReason)}
                  data-testid="run-device-command"
                  onClick={() => {
                    handleRunDeviceCommand().catch((cause: unknown) => {
                      setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                    });
                  }}
                >
                  {deviceBusy ? <Loader2 size={15} className="spinIcon" /> : <Play size={15} />}
                  Run command
                </button>

                {lastDeviceCommand ? (
                  <article className="deviceResultPanel" data-testid="device-command-result">
                    <div className="deviceResultHeader">
                      <strong>{lastDeviceCommand.status}</strong>
                      <span>{lastDeviceCommand.action}</span>
                    </div>
                    <div className="deviceResultGrid">
                      <span>exit</span>
                      <strong>{lastDeviceCommand.exitCode ?? "n/a"}</strong>
                      <span>duration</span>
                      <strong>{commandDuration(lastDeviceCommand)}</strong>
                      <span>artifact</span>
                      <strong>{lastDeviceCommand.artifactUri || "none"}</strong>
                    </div>
                    {lastDeviceVerification ? (
                      <div className={`deviceVerificationPill status-${lastDeviceVerification.status}`}>
                        <CheckCircle2 size={14} />
                        <strong>{lastDeviceVerification.status}</strong>
                        <span>{Math.round(lastDeviceVerification.confidence * 100)}%</span>
                      </div>
                    ) : null}
                    <pre>{commandOutputText(lastDeviceCommand)}</pre>
                    <button
                      className="aliasActionButton secondary"
                      type="button"
                      onClick={() => {
                        handleCopyDeviceLogs().catch((cause: unknown) => {
                          setDeviceMessage(cause instanceof Error ? cause.message : String(cause));
                        });
                      }}
                    >
                      로그 복사
                    </button>
                  </article>
                ) : null}
              </section>

              <section className="deviceCapabilities">
                <span className="sectionLabel">Capabilities</span>
                <div>
                  {capabilityPackages.slice(0, 8).map((capability) => (
                    <span key={capability.id}>{capability.key}</span>
                  ))}
                </div>
              </section>
            </section>
          </form>,
          document.body,
        ) : null}
      </div>

      {error ? (
        <div className="mobileNotice">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="aliasSplitWorkspace" data-testid="thread-split-layout">
        <aside className="aliasListPane" data-testid="thread-list-pane">
          <div className="aliasListScroll telegram-scroll" data-testid="thread-list-scroll">
            <div className="aliasSectionHeader">
              <span>채팅창</span>
              <em>{filteredTasks.length}</em>
            </div>

            {loading ? (
              <div className="aliasEmpty">
                <Loader2 size={18} />
                데이터를 불러오고 있습니다.
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="aliasEmpty">조건에 맞는 채팅창이 없습니다. 새 작업을 만들어 시작해 주세요.</div>
            ) : (
              filteredTasks.map((task) => {
                const taskEventCount = events.filter((event) => event.taskId === task.id).length;
                return (
                  <button
                    className={task.id === selectedTask?.id ? "aliasThreadItem active" : "aliasThreadItem"}
                    key={task.id}
                    type="button"
                    data-testid={`thread-list-item-${task.id}`}
                    onClick={() => {
                      selectTaskState(task.id);
                      setNewTaskMode(false);
                      setTitle("");
                      setMobileView("chat");
                    }}
                  >
                    <span className="aliasThreadAvatar">
                      <Bot size={17} />
                    </span>
                    <span className="aliasThreadMain">
                      <span className="aliasThreadTop">
                        <strong className="thread-title">{task.title}</strong>
                        <time>{eventTime(task.updatedAt)}</time>
                      </span>
                      <span className="thread-preview">{task.instructions}</span>
                      <span className="aliasThreadMeta">
                        <em className={`statusDot status-${task.status}`}>{statusLabel(task.status)}</em>
                        <span>{taskEventCount} events</span>
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div className="aliasListFooter telegram-safe-bottom-panel" data-testid="thread-list-footer">
            <button
              className="aliasActionButton secondary"
              type="button"
              onClick={() => {
                refresh().catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : String(cause));
                });
              }}
            >
              <RefreshCw size={16} />
              새로고침
            </button>
            <button
              className="aliasActionButton primary"
              type="button"
              disabled={!selectedProject}
              onClick={() => {
                setNewTaskMode(true);
                setTitle("");
                setMobileView("chat");
                window.setTimeout(() => titleInputRef.current?.focus(), 0);
              }}
            >
              <Plus size={17} />
              +채팅
            </button>
          </div>
        </aside>

        <section className="aliasDetailPane" data-testid="thread-detail-panel">
          <header className="aliasThreadHeader">
            <div className="aliasThreadHeading">
              <button className="aliasIconButton backOnly" type="button" onClick={() => setMobileView("list")}>
                <PanelRight size={18} />
              </button>
              <div className="minZero">
                <p>{selectedTask?.title || "새 채팅창"}</p>
                <span>
                  {selectedProject?.name || "프로젝트 미지정"} · {latestRun ? latestRun.status : "orchestrator"}
                </span>
              </div>
            </div>
            <div className="aliasHeaderActions">
              <span className="accountContext" title={`${accountPrincipal.displayName} · ${accountPrincipal.workspaceKey}`}>
                <UserCircle2 size={17} />
                <span>{accountPrincipal.displayName}</span>
              </span>
              <button
                className="aliasIconButton secondaryTaskAction"
                type="button"
                title="대화 제목 변경"
                disabled={!selectedTask}
                onClick={() => {
                  handleRenameTask().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Pencil size={17} />
              </button>
              <button
                className="aliasIconButton danger secondaryTaskAction"
                type="button"
                title="대화 삭제"
                disabled={!selectedTask}
                onClick={() => {
                  handleDeleteTask().catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              >
                <Trash2 size={17} />
              </button>
              <button
                className="aliasIconButton"
                type="button"
                title="Hermes"
                onClick={() => {
                  setActiveWorkbenchTab("hermes");
                  setMobileView("workbench");
                }}
              >
                <Settings size={18} />
              </button>
              <button
                className="aliasIconButton"
                type="button"
                title={theme === "dark" ? "밝은 테마" : "어두운 테마"}
                aria-label={theme === "dark" ? "밝은 테마로 전환" : "어두운 테마로 전환"}
                onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
              </button>
            </div>
          </header>

          <div className="aliasTaskFilters">
            {workbenchTabs.map((tab) => (
              <button
                className={activeWorkbenchTab === tab.id ? "aliasFilter active" : "aliasFilter"}
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveWorkbenchTab(tab.id);
                  setMobileView(tab.id === "diff" ? "chat" : "workbench");
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="aliasContentGrid">
            <section className="aliasChatPanel">
              <div className="telegram-grid aliasChatScroll telegram-scroll">
                <div className="aliasStatusPill">
                  <span className={upstreamDiagnostics?.ready ? "signalDot online" : "signalDot"} />
                  <span>{latestSession?.hermesRunId || hermesRuntimeDetail}</span>
                </div>

                {displayedChatMessages.length > 0 ? (
                  displayedChatMessages.map((message) => (
                    <article
                      className={
                        message.role === "user"
                          ? "aliasMessage userMessage message-enter"
                          : "aliasMessage agentMessage message-enter"
                      }
                      key={message.id}
                    >
                      {message.role === "user" ? null : (
                        <span className="aliasAgentAvatar">
                          <Bot size={15} />
                        </span>
                      )}
                      <div className="aliasMessageBubble">
                        <div className="aliasMessageMeta">
                          <strong>{message.role === "user" ? "Master" : "Hermes"}</strong>
                          <time>{eventTime(message.createdAt)}</time>
                        </div>
                        {message.role === "assistant"
                          ? <MarkdownMessage content={message.content} />
                          : <p>{message.content}</p>}
                      </div>
                    </article>
                  ))
                ) : selectedTask ? (
                  <article className="aliasMessage userMessage message-enter">
                    <div className="aliasMessageBubble">
                      <div className="aliasMessageMeta">
                        <strong>Master</strong>
                        <time>{eventTime(selectedTask.createdAt)}</time>
                      </div>
                      <h2>{selectedTask.title}</h2>
                      <p>{selectedTask.instructions}</p>
                    </div>
                  </article>
                ) : (
                  <div className="aliasEmpty">좌측 목록에서 채팅창을 선택하거나 새 작업을 입력해 주세요.</div>
                )}

                {showLiveHermesProjection && hermesProjection ? (
                  <article className="aliasMessage agentMessage message-enter liveHermesMessage">
                    <span className="aliasAgentAvatar"><Bot size={15} /></span>
                    <div className="aliasMessageBubble richProjectionBubble">
                      <div className="aliasMessageMeta">
                        <strong>Hermes · Live</strong>
                        <time>{hermesProjection.needsInput ? "input required" : "streaming"}</time>
                      </div>
                      {hermesProjection.parts.map((part, index) => {
                        if (part.type === "text") return <p key={`text-${index}`}>{part.text}</p>;
                        if (part.type === "reasoning") {
                          return (
                            <details className="projectionReasoning" key={`reasoning-${index}`}>
                              <summary>Reasoning</summary>
                              <p>{part.text}</p>
                            </details>
                          );
                        }
                        return (
                          <section className={`projectionTool ${part.isError ? "error" : ""}`} key={part.toolCallId}>
                            <div>
                              <Terminal size={13} />
                              <strong>{part.toolName}</strong>
                            </div>
                            <small>{part.result === undefined ? "running" : part.isError ? "failed" : "completed"}</small>
                          </section>
                        );
                      })}
                      {hermesProjection.error ? <div className="projectionError">{hermesProjection.error}</div> : null}
                      {pendingHermesInteraction?.type === "approval" ? (
                        <section className="hermesInteraction" aria-live="polite">
                          <div className="hermesInteractionHeading">
                            <ShieldCheck size={15} />
                            <div>
                              <strong>실행 승인이 필요합니다</strong>
                              <p>{pendingHermesInteraction.description}</p>
                            </div>
                          </div>
                          {pendingHermesInteraction.command ? (
                            <code className="hermesInteractionCommand">{pendingHermesInteraction.command}</code>
                          ) : null}
                          <div className="hermesInteractionActions">
                            <button
                              disabled={interactionSending}
                              onClick={() => void handleHermesInteractionResponse({ type: "approval", choice: "once" })}
                              type="button"
                            >
                              한 번 허용
                            </button>
                            <button
                              disabled={interactionSending}
                              onClick={() => void handleHermesInteractionResponse({ type: "approval", choice: "session" })}
                              type="button"
                            >
                              이 세션 허용
                            </button>
                            {pendingHermesInteraction.allowPermanent ? (
                              <button
                                disabled={interactionSending}
                                onClick={() => void handleHermesInteractionResponse({ type: "approval", choice: "always" })}
                                type="button"
                              >
                                항상 허용
                              </button>
                            ) : null}
                            <button
                              className="danger"
                              disabled={interactionSending}
                              onClick={() => void handleHermesInteractionResponse({ type: "approval", choice: "deny" })}
                              type="button"
                            >
                              거부
                            </button>
                          </div>
                        </section>
                      ) : pendingHermesInteraction?.type === "clarify" ? (
                        <section className="hermesInteraction" aria-live="polite">
                          <div className="hermesInteractionHeading">
                            <MessageSquare size={15} />
                            <div>
                              <strong>추가 정보가 필요합니다</strong>
                              <p>{pendingHermesInteraction.question}</p>
                            </div>
                          </div>
                          {pendingHermesInteraction.choices?.length ? (
                            <div className="hermesInteractionChoices">
                              {pendingHermesInteraction.choices.map((choice) => (
                                <button
                                  disabled={interactionSending}
                                  key={choice}
                                  onClick={() => void handleHermesInteractionResponse({
                                    type: "clarify",
                                    requestId: pendingHermesInteraction.requestId,
                                    answer: choice,
                                  })}
                                  type="button"
                                >
                                  {choice}
                                </button>
                              ))}
                            </div>
                          ) : null}
                          <form
                            className="hermesInteractionInput"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (!interactionInput.trim()) return;
                              void handleHermesInteractionResponse({
                                type: "clarify",
                                requestId: pendingHermesInteraction.requestId,
                                answer: interactionInput.trim(),
                              });
                            }}
                          >
                            <input
                              aria-label="Hermes 추가 질문 답변"
                              autoComplete="off"
                              disabled={interactionSending}
                              onChange={(event) => setInteractionInput(event.target.value)}
                              placeholder="직접 답변 입력"
                              value={interactionInput}
                            />
                            <button disabled={interactionSending || !interactionInput.trim()} type="submit">
                              <Send size={14} />
                              전송
                            </button>
                          </form>
                        </section>
                      ) : pendingHermesInteraction?.type === "sudo" || pendingHermesInteraction?.type === "secret" ? (
                        <section className="hermesInteraction secure" aria-live="polite">
                          <div className="hermesInteractionHeading">
                            <ShieldCheck size={15} />
                            <div>
                              <strong>{pendingHermesInteraction.type === "sudo" ? "관리자 암호 입력" : "보안 값 입력"}</strong>
                              <p>
                                {pendingHermesInteraction.type === "secret"
                                  ? pendingHermesInteraction.prompt || pendingHermesInteraction.envVar
                                  : "입력값은 Hermes에만 전달되며 Termes에 저장되지 않습니다."}
                              </p>
                            </div>
                          </div>
                          <form
                            className="hermesInteractionInput"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (!interactionInput) return;
                              void handleHermesInteractionResponse(
                                pendingHermesInteraction.type === "sudo"
                                  ? { type: "sudo", requestId: pendingHermesInteraction.requestId, password: interactionInput }
                                  : { type: "secret", requestId: pendingHermesInteraction.requestId, value: interactionInput },
                              );
                            }}
                          >
                            <input
                              aria-label={pendingHermesInteraction.type === "sudo" ? "관리자 암호" : "보안 값"}
                              autoComplete="off"
                              disabled={interactionSending}
                              onChange={(event) => setInteractionInput(event.target.value)}
                              placeholder={pendingHermesInteraction.type === "sudo" ? "암호" : pendingHermesInteraction.envVar || "보안 값"}
                              type="password"
                              value={interactionInput}
                            />
                            <button disabled={interactionSending || !interactionInput} type="submit">
                              <Send size={14} />
                              안전하게 전송
                            </button>
                          </form>
                        </section>
                      ) : null}
                    </div>
                  </article>
                ) : null}

                <div aria-hidden="true" className="aliasChatAnchor" ref={latestChatMessageRef} />

                {latestTurn ? (
                  <div className={`routingStatus status-${latestTurn.status}`} data-testid="routing-status">
                    <div>
                      <strong>
                        {latestTurn.status === "routing"
                          ? "질문 분류 중"
                          : latestTurn.decision?.route === "instant" || latestTurn.decision?.route === "direct"
                            ? "직접 응답"
                            : "전문 에이전트 경로"}
                      </strong>
                      <span>
                        {latestTurn.decision
                          ? latestTurn.decision.semanticFrame?.action && latestTurn.decision.semanticFrame?.target
                            ? `${latestTurn.decision.semanticFrame.action} · ${latestTurn.decision.semanticFrame.target} · ${latestTurn.decision.route}`
                            : `${latestTurn.decision.primaryDomain} · ${latestTurn.decision.route}`
                          : "상시 Routing Specialist가 처리 경로를 결정합니다."}
                      </span>
                    </div>
                    <small>{latestTurn.status}</small>
                  </div>
                ) : null}

                {orchestration && orchestration.specialists.length > 0 ? (
                  <details
                    className={`specialistPanel status-${orchestration.status}`}
                    data-testid="specialist-panel"
                    open={orchestration.status !== "verified" ? true : undefined}
                  >
                    <summary className="specialistHeader">
                      <div>
                        <strong>전문 에이전트 협업</strong>
                        <span>
                          {orchestration.domain} · {orchestration.weight} · {orchestration.collaboration}
                        </span>
                      </div>
                      <small>{orchestration.status}</small>
                    </summary>
                    <div className="specialistProgress" aria-label="전문 에이전트 진행률">
                      <span style={{ width: `${Math.round((orchestration.specialists.filter((specialist) => specialist.status === "completed").length / Math.max(1, orchestration.specialists.length)) * 100)}%` }} />
                    </div>
                    <div className="specialistRows">
                      {orchestration.specialists.map((specialist) => (
                        <article className={`specialistRow status-${specialist.status}`} key={specialist.id}>
                          <span className="specialistStateDot" aria-hidden="true" />
                          <div>
                            <strong>{specialist.role}</strong>
                            <p>{specialist.mission}</p>
                          </div>
                          <small>{specialist.status}</small>
                        </article>
                      ))}
                    </div>
                    {orchestration.status === "verified" ? (
                      <div className="specialistVerified">
                        <ShieldCheck size={14} />
                        <span>모든 필수 전문 결과가 최종 응답에 반영되었습니다.</span>
                      </div>
                    ) : null}
                  </details>
                ) : null}

                {taskPlan ? (
                  <details className="taskPlanPanel" data-testid="task-plan-panel">
                    <summary className="taskPlanHeader">
                      <strong>계획 및 실행 단계</strong>
                      <span>{taskPlan.status}</span>
                    </summary>
                    <div className="capabilityStrip">
                      {taskPlan.selectedCapabilities.map((capability) => (
                        <span key={capability}>{capability}</span>
                      ))}
                    </div>
                    <div className="taskPlanSteps">
                      {taskPlan.steps.map((step) => (
                        <article key={step.id} className={`taskPlanStep status-${step.status}`}>
                          <span>{step.order}</span>
                          <div>
                            <strong>{step.title}</strong>
                            <em>{step.type}{step.capabilityKey ? ` · ${step.capabilityKey}` : ""}</em>
                          </div>
                          <small>{step.status}</small>
                        </article>
                      ))}
                    </div>
                  </details>
                ) : null}

                {verificationResults.length > 0 ? (
                  <details className="taskPlanPanel verificationPanel" data-testid="verification-panel">
                    <summary className="taskPlanHeader">
                      <strong>검증 결과</strong>
                      <span>{verificationResults.length}</span>
                    </summary>
                    {verificationResults.slice(0, 4).map((verification) => (
                      <article key={verification.id} className={`verificationRow status-${verification.status}`}>
                        <CheckCircle2 size={14} />
                        <div>
                          <strong>{verification.status}</strong>
                          <p>{verification.summary}</p>
                        </div>
                        <small>{Math.round(verification.confidence * 100)}%</small>
                      </article>
                    ))}
                  </details>
                ) : null}

                <div className="aliasRuntimeSummary">
                  <div>
                    <strong>{runningTaskCount}</strong>
                    <span>Running</span>
                  </div>
                  <div>
                    <strong>{completedTaskCount}</strong>
                    <span>Done</span>
                  </div>
                  <div>
                    <strong>
                      {latestCheckpoint
                        ? Math.max(latestCheckpoint.changedFiles.length, artifactChangedFiles(latestArtifact?.metadata).length)
                        : 0}
                    </strong>
                    <span>Files</span>
                  </div>
                </div>
              </div>

              <form
                className="aliasComposer telegram-safe-bottom-panel"
                data-testid="thread-detail-footer"
                onSubmit={(event) => void handleSubmit(event)}
              >
                {newTaskMode || !selectedTask ? (
                  <input
                    ref={titleInputRef}
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="새 작업 제목 · 비워두면 질문에서 자동 생성"
                  />
                ) : null}
                <div className="aliasComposerRow">
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    onKeyDown={(event) => {
                      if (!shouldSubmitChatOnEnter(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }}
                    placeholder={
                      selectedTask && !newTaskMode
                        ? "Hermes에게 후속 메시지를 보내세요..."
                        : "Termes에게 구현, 점검, 리팩터링, 배포를 지시하세요..."
                    }
                    required
                  />
                  <button
                    className={voiceListening ? "aliasSendButton listening" : "aliasSendButton secondary"}
                    type="button"
                    title={voiceSupported ? "음성 입력" : "음성 입력 미지원"}
                    disabled={!voiceSupported}
                    onClick={toggleVoiceInput}
                  >
                    {voiceListening ? <MicOff size={18} /> : <Mic size={18} />}
                  </button>
                  <button
                    className="aliasSendButton"
                    type="submit"
                    title={selectedTask && !newTaskMode ? "Send message" : "Create task"}
                    disabled={!selectedProject || sendingMessage || !instructions.trim()}
                  >
                    {sendingMessage ? <Loader2 size={18} className="spinIcon" /> : <Send size={18} />}
                  </button>
                </div>
                <div className="composerToolbar">
                  <span>{selectedTask && !newTaskMode ? "Hermes · 전문 에이전트 자동 구성" : "새 작업"}</span>
                  <button
                    className={newTaskMode ? "composerModeButton active" : "composerModeButton"}
                    type="button"
                    onClick={() => {
                      setNewTaskMode((current) => !current);
                      setTitle("");
                    }}
                  >
                    <Plus size={14} />
                    {newTaskMode ? "현재 대화로" : "새 작업"}
                  </button>
                </div>
              </form>
            </section>

            <aside className={mobileView === "workbench" ? "aliasWorkbenchPanel open" : "aliasWorkbenchPanel"}>
              <div className="workbenchTabs">
                {workbenchTabs.map((tab) => (
                  <button
                    className={activeWorkbenchTab === tab.id ? "tabButton active" : "tabButton"}
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveWorkbenchTab(tab.id)}
                  >
                    {tab.id === "diff" ? <GitBranch size={15} /> : null}
                    {tab.id === "terminal" ? <Terminal size={15} /> : null}
                    {tab.id === "files" ? <Files size={15} /> : null}
                    {tab.id === "logs" ? <Command size={15} /> : null}
                    {tab.id === "hermes" ? <ShieldCheck size={15} /> : null}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
              {renderWorkbench()}
            </aside>
          </div>
        </section>
      </section>
      </main>
      {renderMemberDialog()}
      {pendingHermesInteraction?.type === "approval" ? (
        <ApprovalGate
          interaction={pendingHermesInteraction}
          sending={interactionSending}
          onDecision={(choice) => void handleHermesInteractionResponse({ type: "approval", choice })}
        />
      ) : null}
    </>
  );
}

bootstrapTermesPwa();
createRoot(document.getElementById("root") as HTMLElement).render(<App />);

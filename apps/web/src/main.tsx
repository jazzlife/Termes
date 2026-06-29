import {
  Activity,
  Bell,
  Bot,
  CheckCircle2,
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
  Menu,
  Mic,
  MicOff,
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
  Terminal,
  Trash2,
  UserCircle2,
  Wifi,
  X,
} from "lucide-react";
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  EventType,
  GitHubConnectionSummary,
  GitHubRepositoryGroupSummary,
  HermesCatalogSummary,
  HermesCapabilitySummary,
  HermesRunSummary,
  HermesUpstreamDiagnostics,
  PlatformEvent,
  ProjectSummary,
  ChatMessageSummary,
  TaskRuntimeSummary,
  TaskSummary,
} from "@termes/shared";
import {
  connectEvents,
  cloneGitHubRepository,
  createHermesChatCompletion,
  createHermesJob,
  createHermesProfile,
  createHermesResponse,
  createHermesRun,
  createHermesSession,
  createProject,
  createProjectFolder,
  createTask,
  deleteProject,
  deleteHermesJob,
  deleteHermesProfile,
  deleteHermesResponse,
  deleteHermesSession,
  deleteTask,
  disconnectGitHub,
  fetchGitHubRepositories,
  fetchGitHubStatus,
  fetchHermesCatalog,
  fetchHermesCapabilities,
  fetchHermesHealthDetailed,
  fetchHermesRun,
  fetchHermesUpstreamDiagnostics,
  fetchProjects,
  fetchTaskRuntime,
  fetchTasks,
  forkHermesSession,
  pauseHermesJob,
  resolveHermesApproval,
  resumeHermesJob,
  runHermesJob,
  registerProjectFolder,
  sendTaskMessage,
  sendHermesSessionChat,
  stopHermesRun,
  streamHermesChatCompletion,
  type GitHubCloneResult,
  type HermesStreamEvent,
  streamHermesResponse,
  streamHermesRunEvents,
  streamHermesSessionChat,
  updateHermesJob,
  updateHermesSession,
  updateProject,
  updateTask,
} from "./api";
import "./styles.css";

type WorkbenchTab = "diff" | "terminal" | "files" | "logs" | "hermes";
type MobileView = "list" | "chat" | "workbench";

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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [taskRuntime, setTaskRuntime] = useState<TaskRuntimeSummary | null>(null);
  const [hermesCapabilities, setHermesCapabilities] = useState<HermesCapabilitySummary | null>(null);
  const [hermesCatalog, setHermesCatalog] = useState<HermesCatalogSummary | null>(null);
  const [hermesRun, setHermesRun] = useState<HermesRunSummary | null>(null);
  const [hermesUpstreamDiagnostics, setHermesUpstreamDiagnostics] = useState<HermesUpstreamDiagnostics | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [projectCreateMode, setProjectCreateMode] = useState<"folder" | "github">("folder");
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectWorkspacePath, setProjectWorkspacePath] = useState("");
  const [githubStatus, setGithubStatus] = useState<GitHubConnectionSummary | null>(null);
  const [githubRepositoryGroups, setGithubRepositoryGroups] = useState<GitHubRepositoryGroupSummary[]>([]);
  const [githubSearch, setGithubSearch] = useState("");
  const [githubManualRepository, setGithubManualRepository] = useState("");
  const [githubCloneParentPath, setGithubCloneParentPath] = useState("");
  const [githubNewFolderName, setGithubNewFolderName] = useState("");
  const [pendingGithubClone, setPendingGithubClone] = useState<GitHubCloneResult | null>(null);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubMessage, setGithubMessage] = useState("GitHub 로그인 후 저장소를 clone해서 프로젝트로 등록할 수 있습니다.");
  const [hermesPrompt, setHermesPrompt] = useState("Inspect Termes runtime and report status.");
  const [lastHermesResponseId, setLastHermesResponseId] = useState<string | null>(null);
  const [lastHermesProfileName, setLastHermesProfileName] = useState<string | null>(null);
  const [hermesStreamEvents, setHermesStreamEvents] = useState<string[]>([]);
  const [hermesAuditResults, setHermesAuditResults] = useState<string[]>([]);
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState<WorkbenchTab>("diff");
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [searchOpen, setSearchOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const selectedTaskIdRef = useRef("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const projectDrawerRef = useRef<HTMLElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || projects[0],
    [projects, selectedProjectId],
  );

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks[0],
    [tasks, selectedTaskId],
  );

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
  const displayedTaskEvents = runtimeMatchesSelected ? taskRuntime?.events || [] : selectedTaskEvents;
  const displayedMessages: ChatMessageSummary[] = runtimeMatchesSelected ? taskRuntime?.messages || [] : [];
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

  async function refresh(projectId = selectedProject?.id, taskId = selectedTask?.id): Promise<void> {
    const nextProjects = await fetchProjects();
    const nextProjectId = projectId || nextProjects[0]?.id || "";
    const nextTasks = await fetchTasks(nextProjectId || undefined);
    const nextSelectedTask =
      nextTasks.find((task) => task.id === taskId) || nextTasks[0] || null;

    setProjects(nextProjects);
    setSelectedProjectId(nextProjectId);
    setTasks(nextTasks);
    setSelectedTaskId(nextSelectedTask?.id || "");
  }

  async function refreshTaskList(projectId = selectedProject?.id): Promise<void> {
    const nextProjects = await fetchProjects();
    const nextProjectId = projectId || nextProjects[0]?.id || "";
    const nextTasks = await fetchTasks(nextProjectId || undefined);

    setProjects(nextProjects);
    setSelectedProjectId(nextProjectId);
    setTasks(nextTasks);
    setSelectedTaskId((current) =>
      current && nextTasks.some((task) => task.id === current) ? current : nextTasks[0]?.id || "",
    );
  }

  async function refreshRuntime(taskId = selectedTask?.id): Promise<void> {
    const [capabilities, runtime] = await Promise.all([
      fetchHermesCapabilities(),
      taskId ? fetchTaskRuntime(taskId) : Promise.resolve(null),
    ]);
    setHermesCapabilities(capabilities);
    setTaskRuntime(runtime);
    const runId = runtime?.sessions[0]?.hermesRunId;
    if (runId) {
      const fallbackRun = runtime?.runs[0] || null;
      const run = await fetchHermesRun(runId).catch(() => {
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
      });
      setHermesRun(run);
    } else {
      setHermesRun(null);
    }
  }

  async function loadGitHubProjectState(): Promise<void> {
    setGithubBusy(true);
    try {
      const status = await fetchGitHubStatus();
      setGithubStatus(status);
      if (!status.connected) {
        setGithubRepositoryGroups([]);
        setGithubMessage(
          status.oauthConfigured
            ? "GitHub 로그인을 완료하면 저장소 목록을 불러옵니다."
            : "GitHub OAuth 설정이 필요합니다. 서버 .env에 GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET을 설정해 주세요.",
        );
        return;
      }

      const groups = await fetchGitHubRepositories();
      setGithubRepositoryGroups(groups);
      setGithubMessage(`${status.login || "GitHub"} 계정의 저장소를 불러왔습니다.`);
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  function openProjectDrawer(mode: "folder" | "github" = "folder"): void {
    setProjectCreateMode(mode);
    setPendingGithubClone(null);
    setProjectPanelOpen(true);
  }

  function startGitHubLogin(): void {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/api/github/oauth/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  async function handleDisconnectGitHub(): Promise<void> {
    setGithubBusy(true);
    setGithubMessage("GitHub 연결을 해제하는 중입니다.");
    try {
      const status = await disconnectGitHub();
      setGithubStatus(status);
      setGithubRepositoryGroups([]);
      setGithubMessage("GitHub 연결을 해제했습니다.");
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function handleCreateGitHubProjectFolder(): Promise<void> {
    const name = githubNewFolderName.trim();
    if (!name) {
      setGithubMessage("생성할 폴더 이름을 입력해 주세요.");
      return;
    }

    setGithubBusy(true);
    setGithubMessage("clone 상위 폴더를 생성하는 중입니다.");
    try {
      const created = await createProjectFolder({
        ...(githubCloneParentPath.trim() ? { parentPath: githubCloneParentPath.trim() } : {}),
        name,
      });
      setGithubCloneParentPath(created.path);
      setGithubNewFolderName("");
      setGithubMessage(`${created.path} 폴더를 생성했습니다.`);
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function handleCloneGitHubProject(repositoryFullName: string): Promise<void> {
    const fullName = repositoryFullName.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!fullName) {
      setGithubMessage("clone할 GitHub 저장소를 선택하거나 owner/repo 형식으로 입력해 주세요.");
      return;
    }

    setGithubBusy(true);
    setGithubMessage(`${fullName} 저장소를 clone하는 중입니다.`);
    try {
      const result = await cloneGitHubRepository({
        repositoryFullName: fullName,
        ...(githubCloneParentPath.trim() ? { parentPath: githubCloneParentPath.trim() } : {}),
      });
      setPendingGithubClone(result);
      setGithubManualRepository("");
      setGithubCloneParentPath(result.path);
      setGithubMessage(`${result.path}에 clone했습니다. 프로젝트 등록을 눌러 목록에 추가해 주세요.`);
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function handleRegisterPendingGitHubClone(): Promise<void> {
    if (!pendingGithubClone) {
      setGithubMessage("먼저 GitHub 저장소를 clone해 주세요.");
      return;
    }

    setGithubBusy(true);
    setGithubMessage(`${pendingGithubClone.path} clone 결과를 프로젝트로 등록하는 중입니다.`);
    try {
      const result = await registerProjectFolder({
        path: pendingGithubClone.path,
        name: pendingGithubClone.name,
      });
      setPendingGithubClone(null);
      setGithubCloneParentPath("");
      setProjectPanelOpen(false);
      setProjectCreateMode("folder");
      setGithubMessage(`${pendingGithubClone.path} 프로젝트를 등록했습니다.`);
      await refresh(result.project.id);
    } catch (cause) {
      setGithubMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGithubBusy(false);
    }
  }

  async function refreshHermesCatalog(): Promise<void> {
    const catalog = await fetchHermesCatalog();
    setHermesCatalog(catalog);
    setHermesCapabilities(catalog.capabilities);
    setHermesUpstreamDiagnostics(catalog.capabilities.manager.upstreamDiagnostics || null);
  }

  useEffect(() => {
    setVoiceSupported(Boolean(getSpeechRecognitionConstructor()));

    refresh()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setLoading(false);
      });

    refreshRuntime().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    refreshHermesCatalog().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });

    const source = connectEvents((event) => {
      setEvents((current) => [event, ...current].slice(0, 80));
      if (
        event.type === "project.created" ||
        event.type === "project.updated" ||
        event.type === "project.deleted" ||
        event.type === "task.created" ||
        event.type === "task.updated" ||
        event.type === "task.deleted" ||
        event.type === "task.started" ||
        event.type === "agent.delta" ||
        event.type === "checkpoint.created" ||
        event.type === "chat.message.created" ||
        event.type === "chat.message.completed" ||
        event.type === "task.completed" ||
        event.type === "task.failed"
      ) {
        refreshTaskList(event.projectId || undefined).catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
        if (event.taskId && event.taskId === selectedTaskIdRef.current) {
          refreshRuntime(event.taskId).catch((cause: unknown) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        }
      }
    });

    return () => {
      source.close();
      recognitionRef.current?.stop();
    };
  }, []);

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
    selectedTaskIdRef.current = selectedTaskId;
    if (!selectedTaskId) {
      setTaskRuntime(null);
      return;
    }

    refreshRuntime(selectedTaskId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [selectedTaskId]);

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
    try {
      if (selectedTask && !nextTitle) {
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
      setSelectedTaskId(task.id);
      setMobileView("chat");
      setTitle("");
      setInstructions("");
      await refreshRuntime(task.id);
      await refreshHermesCatalog();
    } finally {
      setSendingMessage(false);
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
    await refresh(project.id);
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

    await deleteProject(selectedProject.id);
    await refresh();
  }

  async function handleRenameTask(): Promise<void> {
    if (!selectedTask) {
      return;
    }

    const nextTitle = window.prompt("대화 제목", selectedTask.title)?.trim();
    if (!nextTitle || nextTitle === selectedTask.title) {
      return;
    }

    const task = await updateTask(selectedTask.id, { title: nextTitle });
    setTasks((current) => current.map((item) => (item.id === task.id ? task : item)));
    await refreshRuntime(task.id);
  }

  async function handleDeleteTask(): Promise<void> {
    if (!selectedTask) {
      return;
    }

    const ok = window.confirm(`${selectedTask.title} 대화를 삭제할까요?`);
    if (!ok) {
      return;
    }

    await deleteTask(selectedTask.id);
    const remaining = tasks.filter((task) => task.id !== selectedTask.id);
    setTasks(remaining);
    setSelectedTaskId(remaining[0]?.id || "");
    setTaskRuntime(null);
    setMobileView("list");
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
    const providers = Object.entries(diagnostics.providerKeys)
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
    const auditId = Date.now().toString(36);
    const prompt = hermesPrompt || "Run Termes Hermes audit.";
    const auditLine = (label: string, status = "ok") => {
      setHermesAuditResults((current) => [`audit:${label} ${status}`, ...current].slice(0, 40));
    };

    setError(null);
    setHermesAuditResults([]);
    setHermesStreamEvents([]);
    setActionMessage("Hermes audit running");

    const catalog = await fetchHermesCatalog();
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
              {Object.entries(upstreamDiagnostics.providerKeys)
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

  return (
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
          </div>
          <button
            className={searchOpen ? "aliasIconButton active" : "aliasIconButton"}
            type="button"
            title="Search"
            onClick={() => setSearchOpen((current) => !current)}
          >
            <Search size={19} />
          </button>
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
                setSelectedProjectId(project.id);
                refresh(project.id).catch((cause: unknown) => {
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
              if (projectCreateMode !== "folder") {
                return;
              }
              handleCreateProject().catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              });
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
                  <span className="sectionLabel">Folder Workspace</span>
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
                  Folder
                </button>
                <button
                  type="button"
                  className={projectCreateMode === "github" ? "active" : ""}
                  onClick={() => setProjectCreateMode("github")}
                >
                  <Github size={15} />
                  GitHub clone
                </button>
              </div>

              {projectCreateMode === "folder" ? (
                <>
                  <div className="projectDrawerWorkspace">
                    <FolderOpen size={18} />
                    <div>
                      <p>생성될 폴더 워크스페이스</p>
                      <span>{projectWorkspacePath.trim() || suggestedProjectWorkspacePath}</span>
                    </div>
                  </div>

                  <label className="projectDrawerField">
                    <span>프로젝트 이름</span>
                    <input
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      placeholder="예: termes web agent"
                      required={projectCreateMode === "folder"}
                      data-testid="project-name-input"
                    />
                  </label>

                  <label className="projectDrawerField">
                    <span>워크스페이스 경로</span>
                    <input
                      value={projectWorkspacePath}
                      onChange={(event) => setProjectWorkspacePath(event.target.value)}
                      placeholder={suggestedProjectWorkspacePath}
                      data-testid="project-workspace-input"
                    />
                  </label>

                  <label className="projectDrawerField">
                    <span>프로젝트 설명</span>
                    <textarea
                      value={projectDescription}
                      onChange={(event) => setProjectDescription(event.target.value)}
                      placeholder="프로젝트 목적과 작업 범위를 입력해 주세요."
                      rows={4}
                    />
                  </label>

                  <div className="projectDrawerActions">
                    <button className="aliasActionButton secondary" type="button" onClick={() => setProjectPanelOpen(false)}>
                      취소
                    </button>
                    <button className="aliasActionButton primary" type="submit" data-testid="submit-project">
                      <FolderPlus size={15} />
                      프로젝트 등록
                    </button>
                  </div>
                </>
              ) : (
                <div className="githubProjectPanel">
                  <section className="githubAuthCard">
                    <div>
                      <Github size={18} />
                      <strong>{githubConnected ? `${githubStatus?.login || "GitHub"} 연결됨` : "GitHub 로그인이 필요합니다"}</strong>
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
                      <button
                        className="aliasActionButton primary"
                        type="button"
                        disabled={githubBusy || !githubStatus?.oauthConfigured}
                        onClick={startGitHubLogin}
                      >
                        <Github size={15} />
                        {githubConnected ? "다른 계정 로그인" : "GitHub 로그인"}
                      </button>
                    </div>
                  </section>

                  <p className="projectDrawerMessage">{githubBusy ? "GitHub 작업 처리 중..." : githubMessage}</p>

                  <label className="projectDrawerField">
                    <span>Clone 상위 폴더</span>
                    <input
                      value={githubCloneParentPath}
                      onChange={(event) => setGithubCloneParentPath(event.target.value)}
                      placeholder="비워두면 /projects/<repo>에 생성됩니다"
                      data-testid="github-clone-parent-input"
                    />
                  </label>

                  <label className="projectDrawerField">
                    <span>새 폴더 생성</span>
                    <div className="githubManualRow">
                      <input
                        value={githubNewFolderName}
                        onChange={(event) => setGithubNewFolderName(event.target.value)}
                        placeholder="예: clients/new-project"
                        data-testid="github-new-folder-input"
                      />
                      <button
                        className="aliasActionButton secondary"
                        type="button"
                        disabled={githubBusy || !githubNewFolderName.trim()}
                        onClick={() => {
                          handleCreateGitHubProjectFolder().catch((cause: unknown) => {
                            setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                          });
                        }}
                      >
                        생성
                      </button>
                    </div>
                  </label>

                  {pendingGithubClone ? (
                    <section className="githubCloneCompleteCard">
                      <div>
                        <strong>{pendingGithubClone.repositoryFullName}</strong>
                        <span>{pendingGithubClone.path}에 clone했습니다.</span>
                      </div>
                      <button
                        className="aliasActionButton primary"
                        type="button"
                        disabled={githubBusy}
                        onClick={() => {
                          handleRegisterPendingGitHubClone().catch((cause: unknown) => {
                            setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                          });
                        }}
                      >
                        프로젝트 등록
                      </button>
                    </section>
                  ) : null}

                  <label className="projectDrawerField">
                    <span>저장소 직접 입력</span>
                    <div className="githubManualRow">
                      <input
                        value={githubManualRepository}
                        onChange={(event) => setGithubManualRepository(event.target.value)}
                        placeholder="owner/repo"
                        data-testid="github-repository-input"
                      />
                      <button
                        className="aliasActionButton primary"
                        type="button"
                        disabled={githubBusy || !githubConnected || !githubManualRepository.trim()}
                        onClick={() => {
                          handleCloneGitHubProject(githubManualRepository).catch((cause: unknown) => {
                            setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                          });
                        }}
                      >
                        Clone
                      </button>
                    </div>
                  </label>

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
                            <article className="githubRepositoryRow" key={repository.fullName}>
                              <div>
                                <strong>{repository.fullName}</strong>
                                <span>{repository.visibility} · {repository.defaultBranch}</span>
                              </div>
                              <button
                                className="aliasActionButton primary"
                                type="button"
                                disabled={githubBusy}
                                onClick={() => {
                                  handleCloneGitHubProject(repository.fullName).catch((cause: unknown) => {
                                    setGithubMessage(cause instanceof Error ? cause.message : String(cause));
                                  });
                                }}
                              >
                                Clone
                              </button>
                            </article>
                          ))}
                        </section>
                      ))
                    )}
                  </div>
                </div>
              )}
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
                      setSelectedTaskId(task.id);
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
              <button
                className="aliasIconButton"
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
                className="aliasIconButton danger"
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
              <button className="aliasIconButton" type="button" title="Notifications">
                <Bell size={18} />
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

                {displayedMessages.length > 0 ? (
                  displayedMessages.map((message) => (
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
                        <p>{message.content}</p>
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

                {displayedTaskEvents.slice(0, 12).map((event) => (
                  <article className="aliasMessage agentMessage message-enter" key={event.id}>
                    <span className="aliasAgentAvatar">
                      <Bot size={15} />
                    </span>
                    <div className="aliasMessageBubble">
                      <div className="aliasMessageMeta">
                        <strong>{event.type}</strong>
                        <time>{eventTime(event.createdAt)}</time>
                      </div>
                      <p>{payloadText(event)}</p>
                    </div>
                  </article>
                ))}

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
                <input
                  ref={titleInputRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={selectedTask ? "새 대화 제목(입력하면 새 대화 생성)" : "새 대화 제목"}
                />
                <div className="aliasComposerRow">
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder={
                      selectedTask && !title.trim()
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
                    title={selectedTask && !title.trim() ? "Send message" : "Create task"}
                    disabled={!selectedProject || sendingMessage || !instructions.trim()}
                  >
                    {sendingMessage ? <Loader2 size={18} className="spinIcon" /> : <Send size={18} />}
                  </button>
                </div>
                <div className="composerHint">
                  {selectedTask && !title.trim()
                    ? "선택된 대화에 메시지를 보냅니다."
                    : "제목을 비워도 첫 문장으로 새 대화 제목을 만듭니다."}
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
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);

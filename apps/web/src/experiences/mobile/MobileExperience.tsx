import {
  Activity,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FileCode2,
  FolderOpen,
  FolderKanban,
  Loader2,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Smartphone,
  Square,
  Terminal,
  UserCircle2,
  Wifi,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  DeviceSummary,
  GitHubConnectionSummary,
  GitHubRepositoryGroupSummary,
  PlatformEvent,
  ProjectFolderSummary,
  ProjectSummary,
  TaskPlanSummary,
  TaskRuntimeSummary,
  TaskSummary,
  VerificationResultSummary,
} from "@termes/shared";
import type { CodexOAuthDeviceSession, TermesAccountPrincipal } from "../../api";
import type { ThemeMode } from "../../app/theme";
import type { TermesPwaInstallMode } from "../../pwa";
import { MobileChatProgress } from "./MobileChatProgress";
import { buildMobileChatProgress } from "./chat-progress";
import "./mobile.css";

export type MobileScreen = "tasks" | "conversation" | "activity" | "settings";

export type MobileInteractionResponse =
  | { type: "approval"; choice: "once" | "session" | "always" | "deny" }
  | { type: "clarify"; requestId: string; answer: string }
  | { type: "sudo"; requestId: string; password: string }
  | { type: "secret"; requestId: string; value: string };

interface MobileExperienceProps {
  account: TermesAccountPrincipal;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  events: PlatformEvent[];
  selectedProject: ProjectSummary | undefined;
  selectedTask: TaskSummary | undefined;
  runtime: TaskRuntimeSummary | null;
  taskPlan: TaskPlanSummary | null;
  verificationResults: VerificationResultSummary[];
  devices: DeviceSummary[];
  screen: MobileScreen;
  loading: boolean;
  error: string | null;
  search: string;
  instructions: string;
  newTaskMode: boolean;
  sendingMessage: boolean;
  interactionInput: string;
  interactionSending: boolean;
  voiceListening: boolean;
  voiceSupported: boolean;
  theme: ThemeMode;
  pwaStandalone: boolean;
  pwaInstalled: boolean;
  pwaInstallAvailable: boolean;
  pwaInstallBannerVisible: boolean;
  pwaInstallBusy: boolean;
  pwaInstallHelpVisible: boolean;
  pwaInstallMode: TermesPwaInstallMode | null;
  openAiConnected: boolean;
  openAiAuthBusy: boolean;
  openAiAuthMessage: string;
  codexOAuthSession: CodexOAuthDeviceSession | null;
  connectionReady: boolean;
  connectionLabel: string;
  githubStatus: GitHubConnectionSummary | null;
  githubRepositoryGroups: GitHubRepositoryGroupSummary[];
  projectFolders: ProjectFolderSummary[];
  onNavigate: (screen: MobileScreen) => void;
  onSelectProject: (projectId: string) => void;
  onOpenProjectSources: () => Promise<void>;
  onGitHubLogin: () => void;
  onGitHubLogout: () => Promise<void>;
  onCloneGitHubProject: (repositoryFullName: string, parentPath: string) => Promise<void>;
  onRegisterProjectFolder: (path: string) => Promise<void>;
  onCreateProjectFolder: (name: string, parentPath: string) => Promise<string>;
  onSelectTask: (taskId: string) => void;
  onStartNewTask: () => void;
  onSearchChange: (value: string) => void;
  onInstructionsChange: (value: string) => void;
  onInteractionInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onInteraction: (input: MobileInteractionResponse) => void;
  onRefresh: () => void;
  onToggleVoice: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onInstallPwa: () => void;
  onDismissPwaInstall: () => void;
  onConnectOpenAi: () => void;
  onLogout: () => void;
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    created: "준비",
    queued: "대기",
    running: "실행 중",
    reviewing: "검토 중",
    blocked: "입력 필요",
    completed: "완료",
    failed: "실패",
    cancelled: "취소",
  };
  return labels[status] || status;
}

function changedFileName(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "unknown");
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" ? record.path : JSON.stringify(record).slice(0, 90);
}

function artifactChangedFiles(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const files = (value as Record<string, unknown>).changedFiles;
  return Array.isArray(files) ? files : [];
}

type MobileProjectFolderTreeNode = {
  folder: ProjectFolderSummary;
  children: MobileProjectFolderTreeNode[];
};

function buildMobileProjectFolderTree(folders: ProjectFolderSummary[]): MobileProjectFolderTreeNode[] {
  const nodes = new Map(folders.map((folder) => [folder.path, { folder, children: [] as MobileProjectFolderTreeNode[] }]));
  const roots: MobileProjectFolderTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentPath = node.folder.path.split("/").slice(0, -1).join("/");
    const parent = nodes.get(parentPath);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortNodes = (items: MobileProjectFolderTreeNode[]) => {
    items.sort((left, right) => left.folder.name.localeCompare(right.folder.name));
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}

function MobileProjectFolderTreeNode({
  node,
  selectedPath,
  collapsedPaths,
  onSelect,
  onToggle,
}: {
  node: MobileProjectFolderTreeNode;
  selectedPath: string;
  collapsedPaths: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}): JSX.Element {
  const hasChildren = node.children.length > 0;
  const expanded = hasChildren && (!collapsedPaths.has(node.folder.path) || selectedPath.startsWith(`${node.folder.path}/`));
  return (
    <div className="mobileProjectFolderTreeNode" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div className={node.folder.path === selectedPath ? "mobileProjectFolderTreeRow active" : "mobileProjectFolderTreeRow"}>
        {hasChildren ? (
          <button className="mobileProjectFolderTreeToggle" type="button" aria-label={`${node.folder.name} ${expanded ? "접기" : "펼치기"}`} onClick={() => onToggle(node.folder.path)}>
            {expanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
        ) : <span className="mobileProjectFolderTreeSpacer" aria-hidden="true" />}
        <button className="mobileProjectFolderTreeSelect" type="button" onClick={() => onSelect(node.folder.path)}>
          <FolderOpen size={17} />
          <span>{node.folder.name || `/${node.folder.path}`}</span>
        </button>
      </div>
      {hasChildren && expanded ? (
        <div className="mobileProjectFolderTreeChildren" role="group">
          {node.children.map((child) => <MobileProjectFolderTreeNode key={child.folder.path} node={child} selectedPath={selectedPath} collapsedPaths={collapsedPaths} onSelect={onSelect} onToggle={onToggle} />)}
        </div>
      ) : null}
    </div>
  );
}

export function MobileExperience(props: MobileExperienceProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const pinnedToLatestRef = useRef(true);
  const viewportBaselineHeightRef = useRef(0);
  const viewportOrientationRef = useRef<"portrait" | "landscape" | null>(null);
  const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
  const [projectAddDialogOpen, setProjectAddDialogOpen] = useState(false);
  const [projectAddSource, setProjectAddSource] = useState<"github" | "folder">("github");
  const [selectedGithubRepository, setSelectedGithubRepository] = useState("");
  const [githubCloneParentPath, setGithubCloneParentPath] = useState("");
  const [folderProjectPath, setFolderProjectPath] = useState("");
  const [collapsedMobileProjectFolders, setCollapsedMobileProjectFolders] = useState<Set<string>>(() => new Set());
  const [mobileFolderCreateDialog, setMobileFolderCreateDialog] = useState<"github" | "folder" | null>(null);
  const [mobileFolderCreateName, setMobileFolderCreateName] = useState("");
  const [projectAddBusy, setProjectAddBusy] = useState(false);
  const [projectAddError, setProjectAddError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const scrollTimelineToLatest = useCallback(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
    timelineEndRef.current?.scrollIntoView({ block: "end", inline: "nearest" });
  }, []);

  const filteredTasks = useMemo(() => {
    const query = props.search.trim().toLowerCase();
    if (!query) return props.tasks;
    return props.tasks.filter((task) =>
      `${task.title} ${task.instructions} ${task.status}`.toLowerCase().includes(query),
    );
  }, [props.search, props.tasks]);
  const eventCountByTask = useMemo(() => {
    const counts = new Map<string, number>();
    for (const event of props.events) {
      if (!event.taskId) continue;
      counts.set(event.taskId, (counts.get(event.taskId) || 0) + 1);
    }
    return counts;
  }, [props.events]);

  const runtimeMatches = Boolean(props.selectedTask && props.runtime?.task.id === props.selectedTask.id);
  const conversationRuntimeMatches = runtimeMatches && !props.newTaskMode;
  const messages = conversationRuntimeMatches ? props.runtime?.messages || [] : [];
  const chatMessages = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const visibleMessages = chatMessages.slice(-200);
  const projection = conversationRuntimeMatches ? props.runtime?.hermesProjection || null : null;
  const orchestration = conversationRuntimeMatches ? props.runtime?.orchestration || null : null;
  const latestTurn = conversationRuntimeMatches ? props.runtime?.turns?.at(-1) || null : null;
  const latestRun = conversationRuntimeMatches ? props.runtime?.runs[0] || null : null;
  const latestCheckpoint = conversationRuntimeMatches ? props.runtime?.checkpoints[0] || null : null;
  const latestArtifact = conversationRuntimeMatches ? props.runtime?.artifacts[0] || null : null;
  const activeTaskPlan = props.newTaskMode ? null : props.taskPlan;
  const activeVerificationResults = props.newTaskMode ? [] : props.verificationResults;
  const liveTools = projection?.parts.filter((part) => part.type === "tool-call") || [];
  const changedFiles = useMemo(() => {
    const artifactFiles = artifactChangedFiles(latestArtifact?.metadata);
    return (artifactFiles.length > 0 ? artifactFiles : latestCheckpoint?.changedFiles || []).map(changedFileName);
  }, [latestArtifact?.metadata, latestCheckpoint?.changedFiles]);
  const planSteps = activeTaskPlan?.steps || [];
  const completedPlanSteps = planSteps.filter((step) => step.status === "completed").length;
  const planProgress = planSteps.length > 0 ? Math.round((completedPlanSteps / planSteps.length) * 100) : 0;
  const currentPlanStep = planSteps.find((step) => step.status === "running" || step.status === "blocked") || planSteps.at(-1);
  const chatProgress = useMemo(() => buildMobileChatProgress({
    sendingMessage: props.sendingMessage,
    projection,
    turn: latestTurn,
    orchestration,
  }), [latestTurn, orchestration, projection, props.sendingMessage]);
  const latestAssistantMessageId = [...visibleMessages].reverse().find((message) => message.role === "assistant")?.id || "";
  const mobileProjectFolderTree = useMemo(() => buildMobileProjectFolderTree(props.projectFolders), [props.projectFolders]);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;
    let frameId = 0;

    const updateViewport = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const viewportHeight = Math.max(1, Math.round(visualViewport?.height || window.innerHeight));
        const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop || 0));
        const composerFocused = Boolean(composerRef.current?.contains(document.activeElement));
        const orientation = window.matchMedia("(orientation: landscape)").matches ? "landscape" : "portrait";

        if (viewportOrientationRef.current !== orientation) {
          viewportOrientationRef.current = orientation;
          viewportBaselineHeightRef.current = viewportHeight;
        }

        if (!composerFocused) {
          viewportBaselineHeightRef.current = Math.max(viewportBaselineHeightRef.current, viewportHeight);
        }

        const baselineHeight = viewportBaselineHeightRef.current || viewportHeight;
        const keyboardOpen = composerFocused && baselineHeight - viewportHeight > 80;
        root.style.setProperty("--mobile-viewport-height", `${viewportHeight}px`);
        root.style.setProperty("--mobile-viewport-offset-top", `${viewportOffsetTop}px`);
        root.dataset.mobileKeyboard = keyboardOpen ? "open" : "closed";

        if (composerFocused && pinnedToLatestRef.current) {
          window.requestAnimationFrame(scrollTimelineToLatest);
        }
      });
    };

    updateViewport();
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    window.addEventListener("orientationchange", updateViewport);
    document.addEventListener("focusin", updateViewport);
    document.addEventListener("focusout", updateViewport);
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("orientationchange", updateViewport);
      document.removeEventListener("focusin", updateViewport);
      document.removeEventListener("focusout", updateViewport);
      delete root.dataset.mobileKeyboard;
      root.style.removeProperty("--mobile-viewport-height");
      root.style.removeProperty("--mobile-viewport-offset-top");
      viewportBaselineHeightRef.current = 0;
      viewportOrientationRef.current = null;
    };
  }, [scrollTimelineToLatest]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const maximumHeight = Math.min(180, Math.max(96, viewportHeight * 0.32));
    textarea.style.height = `${Math.min(textarea.scrollHeight, maximumHeight)}px`;
  }, [props.instructions]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      document.documentElement.style.setProperty("--mobile-composer-height", `${composer.getBoundingClientRect().height}px`);
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, [props.screen]);

  useEffect(() => {
    if (props.screen !== "conversation") return;
    pinnedToLatestRef.current = true;
    window.requestAnimationFrame(scrollTimelineToLatest);
  }, [props.newTaskMode, props.screen, props.selectedTask?.id, scrollTimelineToLatest]);

  useEffect(() => {
    if (props.screen !== "conversation" || !pinnedToLatestRef.current) return;
    window.requestAnimationFrame(scrollTimelineToLatest);
  }, [messages.length, projection?.updatedAt, props.screen, scrollTimelineToLatest]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const screen = (event.state as { termesMobileScreen?: MobileScreen } | null)?.termesMobileScreen;
      props.onNavigate(screen || "tasks");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [props.onNavigate]);

  function navigate(screen: MobileScreen): void {
    window.history.pushState({ ...window.history.state, termesMobileScreen: screen }, "");
    props.onNavigate(screen);
  }

  function handleTimelineScroll(): void {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
    pinnedToLatestRef.current = distanceFromBottom <= 96;
  }

  function handleComposerFocus(): void {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const distanceFromBottom = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
    pinnedToLatestRef.current = distanceFromBottom <= 96;
    if (!pinnedToLatestRef.current) return;
    window.requestAnimationFrame(scrollTimelineToLatest);
    window.setTimeout(scrollTimelineToLatest, 160);
  }

  async function handleProjectAddSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const isGitHub = projectAddSource === "github";
    if (isGitHub && !selectedGithubRepository) {
      setProjectAddError("저장소 목록에서 clone할 GitHub 저장소를 선택해 주세요.");
      return;
    }
    if (!isGitHub && !folderProjectPath) {
      setProjectAddError("워크스페이스 트리에서 프로젝트 폴더를 선택해 주세요.");
      return;
    }
    setProjectAddBusy(true);
    setProjectAddError(null);
    try {
      if (isGitHub) {
        await props.onCloneGitHubProject(selectedGithubRepository, githubCloneParentPath);
      } else {
        await props.onRegisterProjectFolder(folderProjectPath);
      }
      setSelectedGithubRepository("");
      setGithubCloneParentPath("");
      setFolderProjectPath("");
      setProjectAddDialogOpen(false);
    } catch (cause) {
      setProjectAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectAddBusy(false);
    }
  }

  function openMobileFolderCreateDialog(target: "github" | "folder"): void {
    setMobileFolderCreateName("");
    setMobileFolderCreateDialog(target);
  }

  async function handleCreateMobileProjectFolder(): Promise<void> {
    const target = mobileFolderCreateDialog;
    const name = mobileFolderCreateName.trim();
    if (!target || !name) return;
    const parentPath = target === "github" ? githubCloneParentPath : folderProjectPath;
    setProjectAddBusy(true);
    setProjectAddError(null);
    try {
      const path = await props.onCreateProjectFolder(name, parentPath);
      if (target === "github") {
        setGithubCloneParentPath(path);
      } else {
        setFolderProjectPath(path);
      }
      setMobileFolderCreateDialog(null);
      setMobileFolderCreateName("");
    } catch (cause) {
      setProjectAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectAddBusy(false);
    }
  }

  async function handleGitHubLogout(): Promise<void> {
    setProjectAddBusy(true);
    setProjectAddError(null);
    try {
      await props.onGitHubLogout();
      setSelectedGithubRepository("");
    } catch (cause) {
      setProjectAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectAddBusy(false);
    }
  }

  function openProjectAddDialog(): void {
    setProjectDrawerOpen(false);
    setProjectAddError(null);
    setProjectAddBusy(true);
    setProjectAddDialogOpen(true);
    props.onOpenProjectSources()
      .catch((cause: unknown) => {
        setProjectAddError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setProjectAddBusy(false));
  }

  function renderHeader(title: string, subtitle: string, backTarget?: MobileScreen): JSX.Element {
    return (
      <header className="mobileHeader mobileSafeTop" data-testid="mobile-header">
        <div className="mobileHeaderLeading">
          {backTarget ? (
            <button className="mobileIconButton" type="button" aria-label="뒤로" onClick={() => navigate(backTarget)}>
              <ChevronLeft size={23} />
            </button>
          ) : (
            <button className="mobileBrandButton" type="button" aria-label="프로젝트 목록 열기" onClick={() => setProjectDrawerOpen(true)}>
              <img src="/termes-icon-launcher-v3-192.png" alt="" />
            </button>
          )}
          <div className="mobileHeaderTitle">
            <strong>{title}</strong>
            <span><i className={props.connectionReady ? "mobileSignal online" : "mobileSignal"} />{subtitle}</span>
          </div>
        </div>
        <div className="mobileHeaderActions">
          {props.screen === "conversation" && !props.newTaskMode ? (
            <button className="mobileIconButton" type="button" aria-label="활동" onClick={() => navigate("activity")}>
              <Activity size={20} />
            </button>
          ) : null}
          {props.screen === "tasks" ? (
            <button
              className={searchOpen ? "mobileIconButton active" : "mobileIconButton"}
              type="button"
              aria-label={searchOpen ? "Task 검색 닫기" : "Task 검색 열기"}
              onClick={() => setSearchOpen((current) => !current)}
            >
              <Search size={20} />
            </button>
          ) : null}
          <button className="mobileIconButton" type="button" aria-label="설정" onClick={() => navigate("settings")}>
            <Settings size={20} />
          </button>
        </div>
      </header>
    );
  }

  function renderPwaInstallBanner(): JSX.Element | null {
    if (!props.pwaInstallBannerVisible || props.pwaStandalone || !props.pwaInstallMode) return null;
    const guidedInstall = props.pwaInstallMode !== "native";
    const installHelp = guidedInstall && props.pwaInstallHelpVisible;
    const description = props.pwaInstallMode === "ios"
      ? installHelp
        ? "Safari 공유 버튼 → 홈 화면에 추가 → 추가"
        : "Safari에서 홈 화면에 추가할 수 있습니다."
      : props.pwaInstallMode === "manual"
        ? installHelp
          ? "브라우저 메뉴 → 앱 설치 또는 홈 화면에 추가"
          : "브라우저 메뉴에서 Termes를 설치할 수 있습니다."
        : "홈 화면에 추가하여 앱 모드로 바로 실행하세요.";

    return (
      <section className="mobilePwaInstallBanner" aria-label="Termes 앱 설치">
        <span className="mobilePwaInstallMark" aria-hidden="true"><Download size={19} /></span>
        <span className="mobilePwaInstallCopy"><strong>Termes 앱 설치</strong><small>{description}</small></span>
        <button
          className="mobilePwaInstallAction"
          type="button"
          disabled={props.pwaInstallBusy}
          onClick={installHelp ? props.onDismissPwaInstall : props.onInstallPwa}
        >
          {props.pwaInstallBusy ? "설치 중" : installHelp ? "확인" : guidedInstall ? "방법 보기" : "설치"}
        </button>
        <button className="mobileIconButton mobilePwaInstallDismiss" type="button" aria-label="앱 설치 안내 닫기" onClick={props.onDismissPwaInstall}>
          <X size={19} />
        </button>
      </section>
    );
  }

  function renderProjectDrawer(): JSX.Element | null {
    if (!projectDrawerOpen) return null;
    return (
      <div className="mobileProjectDrawerLayer" role="presentation">
        <button className="mobileProjectDrawerBackdrop" type="button" aria-label="프로젝트 목록 닫기" onClick={() => setProjectDrawerOpen(false)} />
        <aside className="mobileProjectDrawer" data-testid="mobile-project-drawer" aria-label="프로젝트 목록">
          <header>
            <div><span>TERMES</span><h2>프로젝트</h2></div>
            <button className="mobileIconButton" type="button" aria-label="프로젝트 목록 닫기" onClick={() => setProjectDrawerOpen(false)}><X size={20} /></button>
          </header>
          <button
            className="mobileProjectAddButton"
            type="button"
            onClick={openProjectAddDialog}
          >
            <Plus size={18} /> 프로젝트 추가
          </button>
          <div className="mobileProjectList" role="list">
            {props.projects.length === 0 ? <p>등록된 프로젝트가 없습니다.</p> : props.projects.map((project) => (
              <button
                className={project.id === props.selectedProject?.id ? "active" : ""}
                key={project.id}
                role="listitem"
                type="button"
                onClick={() => {
                  setProjectDrawerOpen(false);
                  props.onSelectProject(project.id);
                }}
              >
                <span><FolderKanban size={18} /></span>
                <strong>{project.name}</strong>
              </button>
            ))}
          </div>
        </aside>
      </div>
    );
  }

  function renderProjectFolderTree(
    selectedPath: string,
    onSelect: (path: string) => void,
    emptyLabel: string,
    label: string,
    onCreateFolder: () => void,
    allowWorkspaceRoot = false,
  ): JSX.Element {
    const toggle = (path: string) => {
      setCollapsedMobileProjectFolders((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    };
    return (
      <div className="mobileProjectFolderTree" data-testid="mobile-project-folder-tree" role="tree">
        <div className="mobileProjectFolderTreeHeader">
          <strong>{label}</strong>
          <button className="mobileProjectFolderTreeCreateAction" disabled={projectAddBusy} type="button" onClick={onCreateFolder}><Plus size={15} />새 폴더</button>
        </div>
        {props.projectFolders.length === 0 ? <p className="mobileProjectFolderEmpty">{emptyLabel}</p> : <>
          {allowWorkspaceRoot ? (
          <div className="mobileProjectFolderTreeRoot" role="treeitem">
            <button className={selectedPath === "" ? "active" : ""} type="button" onClick={() => onSelect("")}><FolderOpen size={17} /><span>Workspace root</span></button>
          </div>
          ) : null}
          <div className="mobileProjectFolderTreeChildren" role="group">
            {mobileProjectFolderTree.map((node) => <MobileProjectFolderTreeNode key={node.folder.path} node={node} selectedPath={selectedPath} collapsedPaths={collapsedMobileProjectFolders} onSelect={onSelect} onToggle={toggle} />)}
          </div>
        </>}
      </div>
    );
  }

  function renderProjectAddDialog(): JSX.Element | null {
    if (!projectAddDialogOpen) return null;
    const isGitHub = projectAddSource === "github";
    const githubConnected = props.githubStatus?.connected === true;
    return (
      <div className="mobileProjectAddLayer" role="presentation">
        <button className="mobileProjectAddBackdrop" type="button" aria-label="프로젝트 추가 닫기" disabled={projectAddBusy} onClick={() => setProjectAddDialogOpen(false)} />
        <form className="mobileProjectAddDialog" data-testid="mobile-project-add-dialog" aria-label="프로젝트 추가" onSubmit={(event) => void handleProjectAddSubmit(event)}>
          <header>
            <div><span>NEW PROJECT</span><h2>프로젝트 추가</h2></div>
            <button className="mobileIconButton" type="button" aria-label="프로젝트 추가 닫기" disabled={projectAddBusy} onClick={() => setProjectAddDialogOpen(false)}><X size={20} /></button>
          </header>
          <div className="mobileProjectAddTabs" role="tablist" aria-label="프로젝트 추가 방식">
            <button className={isGitHub ? "active" : ""} type="button" onClick={() => { setProjectAddSource("github"); setProjectAddError(null); }}>GitHub 프로젝트</button>
            <button className={!isGitHub ? "active" : ""} type="button" onClick={() => { setProjectAddSource("folder"); setProjectAddError(null); }}>폴더 프로젝트</button>
          </div>

          {isGitHub ? (
            <>
              <section className="mobileGitHubAuth" aria-label="GitHub 인증 관리">
                <div>
                  <strong>GitHub 인증 관리</strong>
                  <span>{githubConnected ? `${props.githubStatus?.login || "GitHub"} 연결됨` : "GitHub 로그인이 필요합니다."}</span>
                </div>
                {githubConnected ? (
                  <button disabled={projectAddBusy} type="button" onClick={() => void handleGitHubLogout()}>
                    연결 해제
                  </button>
                ) : props.githubStatus?.browserOAuthEnabled ? (
                  <button disabled={projectAddBusy} type="button" onClick={props.onGitHubLogin}>
                    GitHub 로그인
                  </button>
                ) : null}
              </section>
              {!githubConnected && !props.githubStatus?.browserOAuthEnabled ? (
                <p>GitHub Browser OAuth 설정이 필요합니다.</p>
              ) : null}
              <section className="mobileProjectPicker">
                <span>GitHub 저장소 선택</span>
                <div className="mobileGitHubRepositoryList" aria-label="GitHub 저장소 목록">
                  {!githubConnected ? <p>GitHub 로그인 후 저장소 목록을 확인할 수 있습니다.</p> : props.githubRepositoryGroups.flatMap((group) => group.repositories).length === 0 ? <p>표시할 저장소가 없습니다.</p> : props.githubRepositoryGroups.map((group) => (
                    <div key={group.groupId}>
                      <small>{group.label}</small>
                      {group.repositories.map((repository) => (
                        <button
                          className={selectedGithubRepository === repository.fullName ? "active" : ""}
                          data-testid="mobile-github-repository-select"
                          key={repository.fullName}
                          type="button"
                          onClick={() => setSelectedGithubRepository(repository.fullName)}
                        >
                          <span>{repository.fullName}</span>
                          <small>{repository.visibility} · {repository.defaultBranch}</small>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
              <section className="mobileProjectPicker">
                {renderProjectFolderTree(
                  githubCloneParentPath,
                  setGithubCloneParentPath,
                  "새 폴더를 추가하거나 Workspace root를 선택할 수 있습니다.",
                  "워크스페이스 클론 폴더",
                  () => openMobileFolderCreateDialog("github"),
                  true,
                )}
              </section>
              <div className="mobileProjectFolderSelection">
                <span>{githubCloneParentPath ? `/${githubCloneParentPath} 선택됨` : "Workspace root 선택됨"}</span>
              </div>
              </>
              ) : (
              <section className="mobileProjectPicker">
              {renderProjectFolderTree(
                folderProjectPath,
                setFolderProjectPath,
                "프로젝트 폴더를 먼저 추가해 주세요.",
                "워크스페이스 프로젝트 폴더",
                () => openMobileFolderCreateDialog("folder"),
              )}
              <div className="mobileProjectFolderSelection">
                <span>{folderProjectPath ? `/${folderProjectPath} 선택됨` : "폴더를 선택해 주세요."}</span>
              </div>
              </section>
          )}
          {projectAddError ? <div className="mobileProjectAddError" role="alert">{projectAddError}</div> : null}
          <button className="mobilePrimaryButton" data-testid={isGitHub ? "mobile-github-clone-selected" : "mobile-folder-project-select"} disabled={projectAddBusy || (isGitHub ? !githubConnected || !selectedGithubRepository : !folderProjectPath)} type="submit">
            {projectAddBusy ? <Loader2 className="spinIcon" size={18} /> : <Plus size={18} />}
            {projectAddBusy ? "처리 중" : isGitHub ? "Clone 후 프로젝트 폴더로 선택" : "프로젝트 폴더로 선택"}
          </button>
        </form>
        {mobileFolderCreateDialog ? (
          <div className="mobileProjectFolderCreateLayer" role="presentation" onClick={() => setMobileFolderCreateDialog(null)}>
            <form
              className="mobileProjectFolderCreateDialog"
              data-testid="mobile-project-folder-create-dialog"
              aria-label="새 폴더 생성"
              onClick={(event) => event.stopPropagation()}
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateMobileProjectFolder();
              }}
            >
              <header><div><span>WORKSPACE FOLDER</span><h2>새 폴더</h2></div><button className="mobileIconButton" type="button" aria-label="새 폴더 닫기" onClick={() => setMobileFolderCreateDialog(null)}><X size={20} /></button></header>
              <p>{mobileFolderCreateDialog === "github" ? `/${githubCloneParentPath || ""}` : `/${folderProjectPath || ""}`} 아래에 생성합니다.</p>
              <input autoFocus disabled={projectAddBusy} onChange={(event) => setMobileFolderCreateName(event.target.value)} placeholder="폴더 이름" value={mobileFolderCreateName} />
              <div><button type="button" onClick={() => setMobileFolderCreateDialog(null)}>취소</button><button disabled={projectAddBusy || !mobileFolderCreateName.trim()} type="submit">생성</button></div>
            </form>
          </div>
        ) : null}
      </div>
    );
  }

  if (props.screen === "tasks") {
    return (
      <main className="mobileExperience" data-testid="mobile-experience">
        {renderHeader(props.selectedProject?.name || "프로젝트", props.connectionLabel)}
        {renderPwaInstallBanner()}
        {searchOpen ? (
          <section className="mobileTaskSearchBar">
            <Search size={18} />
            <label className="mobileSrOnly" htmlFor="mobile-task-search">Task 검색</label>
            <input id="mobile-task-search" type="search" value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Task 검색" autoFocus />
          </section>
        ) : null}
        <div className="mobileTaskListHeading">
          <strong>Task</strong>
          <span>{filteredTasks.length}개</span>
          <button className="mobileIconButton" type="button" aria-label="새로고침" onClick={props.onRefresh}><RefreshCw size={19} /></button>
        </div>
        <section className="mobileTaskList" aria-label="Task 목록">
          {props.loading ? (
            <div className="mobileEmptyState"><Loader2 className="spinIcon" size={22} /><span>Task를 불러오고 있습니다.</span></div>
          ) : filteredTasks.length === 0 ? (
            <div className="mobileEmptyState">
              <MessageSquare size={28} />
              <strong>{props.selectedProject ? "새 Task를 시작해 주세요" : "Project가 필요합니다"}</strong>
              <span>{props.selectedProject ? "질문이나 구현 요청을 바로 입력할 수 있습니다." : "Workspace 등록은 Desktop Workstation에서 관리합니다."}</span>
            </div>
          ) : filteredTasks.map((task) => {
            const eventCount = eventCountByTask.get(task.id) || 0;
            return (
              <button
                className={task.id === props.selectedTask?.id ? "mobileTaskRow active" : "mobileTaskRow"}
                key={task.id}
                type="button"
                data-testid={`mobile-task-${task.id}`}
                onClick={() => {
                  props.onSelectTask(task.id);
                  navigate("conversation");
                }}
              >
                <span className={`mobileTaskState status-${task.status}`} aria-hidden="true">
                  {task.status === "running" ? <Loader2 className="spinIcon" size={18} /> : <MessageSquare size={18} />}
                </span>
                <span className="mobileTaskRowMain">
                  <span className="mobileTaskRowTop"><strong>{task.title}</strong><time>{timeLabel(task.updatedAt)}</time></span>
                  <span className="mobileTaskPreview">{task.instructions}</span>
                  <span className="mobileTaskMeta"><em className={`status-${task.status}`}>{statusLabel(task.status)}</em><span>{eventCount}개 활동</span></span>
                </span>
                <ChevronRight className="mobileTaskChevron" size={18} aria-hidden="true" />
              </button>
            );
          })}
        </section>
        <div className="mobileTaskAction mobileSafeBottom">
          <button
            className="mobilePrimaryButton"
            type="button"
            disabled={!props.selectedProject}
            onClick={() => {
              props.onStartNewTask();
              navigate("conversation");
            }}
          >
            <Plus size={19} />새 Task 시작
          </button>
        </div>
        {renderProjectDrawer()}
        {renderProjectAddDialog()}
        {props.error ? <div className="mobileError" role="alert"><CircleAlert size={18} />{props.error}</div> : null}
      </main>
    );
  }

  if (props.screen === "settings") {
    return (
      <main className="mobileExperience" data-testid="mobile-settings">
        {renderHeader("설정", "Account · OAuth", props.selectedTask || props.newTaskMode ? "conversation" : "tasks")}
        <div className="mobileSettingsScroll">
          <section className="mobileSettingsSection">
            <h2>Account</h2>
            <div className="mobileAccountCard"><UserCircle2 size={22} /><div><strong>{props.account.displayName}</strong><span>{props.account.workspaceKey}</span></div></div>
            <div className={props.openAiConnected ? "mobileOAuthStatus connected" : "mobileOAuthStatus"}>
              <Wifi size={20} />
              <div><strong>OpenAI OAuth</strong><span>{props.openAiAuthMessage}</span></div>
            </div>
            {props.codexOAuthSession?.status === "awaiting_user" && props.codexOAuthSession.verificationUrl ? (
              <a className="mobileOAuthLink" href={props.codexOAuthSession.verificationUrl} target="_blank" rel="noreferrer">
                <code>{props.codexOAuthSession.userCode}</code><span>ChatGPT 계정 승인</span>
              </a>
            ) : null}
            {!props.openAiConnected && props.account.canManageSharedOAuth ? (
              <button className="mobileSecondaryButton" disabled={props.openAiAuthBusy} type="button" onClick={props.onConnectOpenAi}>
                <Sparkles size={18} />{props.openAiAuthBusy ? "연결 중" : "ChatGPT로 연결"}
              </button>
            ) : null}
          </section>
          <section className="mobileSettingsSection">
            <h2>Theme</h2>
            <div className="mobileThemeOptions" role="group" aria-label="Theme 선택">
              {(["light", "dark", "system"] as ThemeMode[]).map((mode) => (
                <button className={props.theme === mode ? "active" : ""} key={mode} type="button" onClick={() => props.onThemeChange(mode)}>
                  {mode === "light" ? "Light" : mode === "dark" ? "Dark" : "System"}
                </button>
              ))}
            </div>
          </section>
          <section className="mobileSettingsSection">
            <h2>App</h2>
            <div className={props.pwaStandalone ? "mobilePwaStatus installed" : "mobilePwaStatus"}>
              <Smartphone size={21} />
              <div>
                <strong>{props.pwaStandalone ? "Standalone 앱" : props.pwaInstalled ? "설치 완료" : "브라우저"}</strong>
                <span>{props.pwaStandalone ? "주소창 없는 Termes 앱 모드로 실행 중입니다." : props.pwaInstalled ? "홈 화면의 Termes 아이콘으로 실행하세요." : "현재 브라우저 탭에서 실행 중입니다."}</span>
              </div>
            </div>
            {!props.pwaStandalone && props.pwaInstallAvailable ? (
              <button className="mobileSecondaryButton" disabled={props.pwaInstallBusy} type="button" onClick={props.onInstallPwa}>
                <Download size={18} />{props.pwaInstallMode === "native" ? props.pwaInstallBusy ? "설치 중" : "Termes 앱 설치" : "설치 방법 보기"}
              </button>
            ) : null}
            {props.pwaInstallMode !== "native" && props.pwaInstallHelpVisible ? (
              <p className="mobileSettingsNote">{props.pwaInstallMode === "ios" ? "Safari 공유 버튼을 누른 뒤 ‘홈 화면에 추가’와 ‘추가’를 차례로 선택해 주세요." : "브라우저 메뉴를 연 뒤 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택해 주세요."}</p>
            ) : null}
          </section>
          <section className="mobileSettingsSection">
            <button className="mobileDangerButton" type="button" onClick={props.onLogout}><LogOut size={18} />로그아웃</button>
            <p className="mobileSettingsNote">OpenAI API Key는 사용하지 않습니다. 공유 ChatGPT OAuth 연결을 사용합니다.</p>
          </section>
        </div>
      </main>
    );
  }

  if (props.screen === "activity") {
    return (
      <main className="mobileExperience" data-testid="mobile-activity">
        {renderHeader("Activity", props.selectedTask?.title || "선택된 Task 없음", "conversation")}
        <div className="mobileActivityScroll">
          <section className="mobileActivitySection">
            <h2>실행 상태</h2>
            <div className="mobileActivitySummary"><i className={props.connectionReady ? "mobileSignal online" : "mobileSignal"} /><div><strong>{latestRun ? statusLabel(latestRun.status) : props.connectionLabel}</strong><span>{projection?.needsInput ? "사용자 입력이 필요합니다." : props.connectionLabel}</span></div></div>
          </section>
          {activeTaskPlan ? (
            <section className="mobileActivitySection">
              <h2>Plan <span>{completedPlanSteps}/{planSteps.length}</span></h2>
              <div className="mobilePlanProgress"><i style={{ width: `${planProgress}%` }} /></div>
              <div className="mobileActivityRows">{planSteps.map((step) => <div className={`mobileActivityRow status-${step.status}`} key={step.id}><span>{step.order}</span><div><strong>{step.title}</strong><small>{step.type}{step.capabilityKey ? ` · ${step.capabilityKey}` : ""}</small></div><em>{statusLabel(step.status)}</em></div>)}</div>
            </section>
          ) : null}
          {orchestration?.specialists.length ? (
            <section className="mobileActivitySection">
              <h2>전문 에이전트 <span>{orchestration.status}</span></h2>
              <div className="mobileActivityRows">{orchestration.specialists.map((specialist) => <div className={`mobileActivityRow status-${specialist.status}`} key={specialist.id}><Bot size={18} /><div><strong>{specialist.role}</strong><small>{specialist.mission}</small></div><em>{statusLabel(specialist.status)}</em></div>)}</div>
            </section>
          ) : null}
          {liveTools.length ? (
            <section className="mobileActivitySection">
              <h2>Tools <span>{liveTools.length}</span></h2>
              <div className="mobileActivityRows">{liveTools.map((tool) => <div className={tool.isError ? "mobileActivityRow status-failed" : "mobileActivityRow"} key={tool.toolCallId}><Terminal size={18} /><div><strong>{tool.toolName}</strong><small>{tool.result === undefined ? "실행 중" : tool.isError ? "실패" : "완료"}</small></div><em>{tool.result === undefined ? "Running" : tool.isError ? "Failed" : "Done"}</em></div>)}</div>
            </section>
          ) : null}
          <section className="mobileActivitySection">
            <h2>Changes <span>{changedFiles.length}</span></h2>
            {changedFiles.length ? <div className="mobileActivityRows">{changedFiles.map((file) => <div className="mobileActivityRow" key={file}><FileCode2 size={18} /><div><strong>{file}</strong><small>Desktop에서 편집하거나 Tablet에서 Diff를 검토할 수 있습니다.</small></div></div>)}</div> : <p className="mobileActivityEmpty">확정된 변경 파일이 없습니다.</p>}
          </section>
          {conversationRuntimeMatches && props.runtime?.artifacts.length ? (
            <section className="mobileActivitySection">
              <h2>Artifacts <span>{props.runtime.artifacts.length}</span></h2>
              <div className="mobileActivityRows">{props.runtime.artifacts.map((artifact) => <div className="mobileActivityRow" key={artifact.id}><FileCode2 size={18} /><div><strong>{artifact.kind}</strong><small>{artifact.uri}</small></div></div>)}</div>
            </section>
          ) : null}
          <section className="mobileActivitySection">
            <h2>Verification <span>{activeVerificationResults.length}</span></h2>
            {activeVerificationResults.length ? <div className="mobileActivityRows">{activeVerificationResults.map((verification) => <div className={`mobileActivityRow verification status-${verification.status}`} key={verification.id}><ShieldCheck size={18} /><div><strong>{verification.status}</strong><small>{verification.summary}</small></div><em>{Math.round(verification.confidence * 100)}%</em></div>)}</div> : <p className="mobileActivityEmpty">아직 생성된 검증 결과가 없습니다.</p>}
          </section>
          <section className="mobileActivitySection">
            <h2>Devices <span>{props.devices.length}</span></h2>
            <p className="mobileActivityEmpty">모바일에서는 상태와 Agent 승인만 제공합니다. 등록과 직접 명령은 Desktop에서 수행합니다.</p>
          </section>
        </div>
      </main>
    );
  }

  const interaction = projection?.interaction || null;
  return (
    <main className="mobileExperience mobileConversation" data-testid="mobile-conversation">
      {renderHeader(props.newTaskMode ? "새 Task" : props.selectedTask?.title || "Task 선택", props.selectedProject?.name || "Project 미지정", "tasks")}
      {activeTaskPlan && currentPlanStep ? (
        <button className={`mobilePlanStrip status-${activeTaskPlan.status}`} type="button" onClick={() => navigate("activity")}>
          <span><i style={{ width: `${planProgress}%` }} /></span>
          <strong>{currentPlanStep.title}</strong>
          <em>{completedPlanSteps}/{planSteps.length}</em>
        </button>
      ) : null}
      <section ref={timelineRef} className="mobileTimeline mobileScroll" aria-live="polite" onScroll={handleTimelineScroll}>
        {!props.selectedTask && !props.newTaskMode ? (
          <div className="mobileEmptyState"><MessageSquare size={30} /><strong>Task를 선택해 주세요</strong><span>목록에서 기존 Task를 열거나 새 Task를 시작할 수 있습니다.</span></div>
        ) : props.newTaskMode && messages.length === 0 ? (
          <div className="mobileConversationWelcome"><Sparkles size={24} /><h2>무엇을 만들까요?</h2><p>첫 질문에서 Task 제목이 자동으로 만들어집니다.</p></div>
        ) : null}
        {chatMessages.length > visibleMessages.length ? (
          <div className="mobileHistoryBoundary">이전 메시지 {chatMessages.length - visibleMessages.length}개는 새로고침 후에도 보존됩니다. Tablet 또는 Desktop에서 전체 이력을 확인할 수 있습니다.</div>
        ) : null}
        {visibleMessages.map((message) => (
          <div className="mobileMessageGroup" key={message.id}>
            {!chatProgress.active && chatProgress.visible && message.id === latestAssistantMessageId ? (
              <article className="mobileMessage agent progress">
                <div className="mobileMessageMeta"><span className="mobileAgentMark"><Bot size={16} /></span><strong>Hermes</strong><time>상태 보고</time></div>
                <MobileChatProgress progress={chatProgress} />
              </article>
            ) : null}
            <article className={message.role === "user" ? "mobileMessage user" : "mobileMessage agent"}>
              {message.role === "assistant" ? <div className="mobileMessageMeta"><span className="mobileAgentMark"><Bot size={16} /></span><strong>Hermes</strong><time>{timeLabel(message.createdAt)}</time></div> : null}
              <div className="mobileMarkdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
            </article>
          </div>
        ))}
        {chatProgress.active ? (
          <article className="mobileMessage agent live">
            <div className="mobileMessageMeta"><span className="mobileAgentMark"><Bot size={16} /></span><strong>Hermes</strong><time>{projection?.needsInput ? "입력 필요" : "실시간"}</time></div>
            <MobileChatProgress progress={chatProgress} />
            {projection?.parts.map((part, index) => {
              if (part.type === "text") return <div className="mobileMarkdown" key={`text-${index}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>;
              if (part.type === "reasoning") return <details className="mobileReasoning" key={`reasoning-${index}`}><summary><Sparkles size={16} />Reasoning</summary><p>{part.text}</p></details>;
              return null;
            })}
            {projection?.error ? <div className="mobileInlineError"><CircleAlert size={17} />{projection.error}</div> : null}
          </article>
        ) : null}
        {interaction ? (
          <section className={`mobileInteractionCard type-${interaction.type}`}>
            <div className="mobileInteractionHeading"><ShieldCheck size={19} /><div><strong>{interaction.type === "approval" ? "실행 승인이 필요합니다" : interaction.type === "clarify" ? "추가 정보가 필요합니다" : interaction.type === "sudo" ? "관리자 암호 입력" : "보안 값 입력"}</strong><p>{interaction.type === "approval" ? interaction.description : interaction.type === "clarify" ? interaction.question : interaction.type === "secret" ? interaction.prompt || interaction.envVar : "입력값은 Hermes에만 전달되며 Termes에 저장되지 않습니다."}</p></div></div>
            {interaction.type === "approval" ? <div className="mobileInteractionActions"><button disabled={props.interactionSending} onClick={() => props.onInteraction({ type: "approval", choice: "once" })}>한 번 승인</button><button disabled={props.interactionSending} onClick={() => props.onInteraction({ type: "approval", choice: "session" })}>이번 세션</button>{interaction.allowPermanent ? <button disabled={props.interactionSending} onClick={() => props.onInteraction({ type: "approval", choice: "always" })}>항상 승인</button> : null}<button className="danger" disabled={props.interactionSending} onClick={() => props.onInteraction({ type: "approval", choice: "deny" })}>거절</button></div> : null}
            {interaction.type === "clarify" && interaction.choices?.length ? <div className="mobileInteractionChoices">{interaction.choices.map((choice) => <button disabled={props.interactionSending} key={choice} onClick={() => props.onInteraction({ type: "clarify", requestId: interaction.requestId, answer: choice })}>{choice}</button>)}</div> : null}
            {interaction.type !== "approval" ? <form className="mobileInteractionInput" onSubmit={(event) => { event.preventDefault(); if (!props.interactionInput) return; props.onInteraction(interaction.type === "clarify" ? { type: "clarify", requestId: interaction.requestId, answer: props.interactionInput } : interaction.type === "sudo" ? { type: "sudo", requestId: interaction.requestId, password: props.interactionInput } : { type: "secret", requestId: interaction.requestId, value: props.interactionInput }); }}><input type={interaction.type === "clarify" ? "text" : "password"} value={props.interactionInput} onChange={(event) => props.onInteractionInputChange(event.target.value)} placeholder={interaction.type === "clarify" ? "직접 답변 입력" : "안전하게 입력"} /><button type="submit" disabled={props.interactionSending || !props.interactionInput}><Send size={17} />전송</button></form> : null}
          </section>
        ) : null}
        <div ref={timelineEndRef} />
      </section>
      <form ref={composerRef} className="mobileComposer mobileSafeBottom" onSubmit={props.onSubmit} onFocus={handleComposerFocus}>
        <div className="mobileComposerSurface">
          <label className="mobileSrOnly" htmlFor="mobile-message-input">메시지</label>
          <textarea id="mobile-message-input" ref={textareaRef} value={props.instructions} onChange={(event) => props.onInstructionsChange(event.target.value)} placeholder={props.newTaskMode ? "Termes에게 새 작업을 지시하세요…" : "후속 메시지를 입력하세요…"} required />
          <div className="mobileComposerToolbar">
            <span>{props.newTaskMode ? "새 Task · 제목 자동 생성" : "Follow-up · 전문 에이전트 자동 구성"}</span>
            <div>
              <button className={props.voiceListening ? "mobileIconButton listening" : "mobileIconButton"} type="button" aria-label="음성 입력" disabled={!props.voiceSupported} onClick={props.onToggleVoice}>{props.voiceListening ? <MicOff size={20} /> : <Mic size={20} />}</button>
              <button className="mobileSendButton" type="submit" aria-label="전송" disabled={!props.selectedProject || props.sendingMessage || !props.instructions.trim()}>{props.sendingMessage ? <Loader2 className="spinIcon" size={20} /> : projection?.busy ? <Square size={18} /> : <Send size={20} />}</button>
            </div>
          </div>
        </div>
      </form>
      {props.error ? <div className="mobileError" role="alert"><CircleAlert size={18} />{props.error}</div> : null}
    </main>
  );
}

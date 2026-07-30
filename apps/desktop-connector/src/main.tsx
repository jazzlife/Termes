import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnectionPhase,
  ConnectorSnapshot,
  PendingApproval,
  PermissionState,
  PermissionValue,
} from "./types";
import "./styles.css";

const phaseLabels: Record<ConnectionPhase, string> = {
  unpaired: "연결 안 됨",
  connecting: "연결 중",
  online: "온라인",
  busy: "제어 실행 중",
  offline: "오프라인",
  error: "연결 오류",
};

const permissionLabels: Array<{
  key: keyof PermissionState;
  title: string;
  description: string;
}> = [
  {
    key: "accessibility",
    title: "화면 요소 분석",
    description: "UI Automation 또는 손쉬운 사용 트리로 앱 구조를 읽습니다.",
  },
  {
    key: "screenCapture",
    title: "화면 캡처",
    description: "현재 데스크톱을 캡처해 작업 전후 상태를 검증합니다.",
  },
  {
    key: "inputControl",
    title: "키보드와 포인터",
    description: "로컬 승인 후 제한된 클릭과 입력 작업을 수행합니다.",
  },
  {
    key: "processInspection",
    title: "프로세스와 진단",
    description: "실행 앱, 프로세스 상태와 제한된 시스템 로그를 분석합니다.",
  },
];

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "요청을 완료하지 못했습니다.";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function permissionTone(value: PermissionValue): string {
  if (value === "granted") return "positive";
  if (value === "denied") return "negative";
  return "neutral";
}

function permissionText(value: PermissionValue): string {
  if (value === "granted") return "허용됨";
  if (value === "denied") return "허용 필요";
  if (value === "not_determined") return "확인 필요";
  return "시스템 기본";
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    "system.info": "시스템 정보 확인",
    "process.list": "프로세스 목록 확인",
    "screen.capture": "화면 캡처",
    "accessibility.snapshot": "화면 요소 분석",
    "input.click": "화면 클릭",
    "input.type": "키보드 입력",
    "app.launch": "앱 실행",
    "app.terminate": "앱 종료",
    "logs.read": "시스템 로그 확인",
    "debug.process": "프로세스 진단",
  };
  const suffix = action.split(".").slice(1).join(".");
  return labels[suffix] ?? action;
}

function App() {
  const [snapshot, setSnapshot] = React.useState<ConnectorSnapshot | null>(null);
  const [deviceName, setDeviceName] = React.useState("");
  const [apiBaseUrl, setApiBaseUrl] = React.useState("");
  const [pairingCode, setPairingCode] = React.useState("");
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void Promise.all([
      invoke<ConnectorSnapshot>("get_connector_snapshot"),
      invoke<string>("get_default_device_name"),
      listen<ConnectorSnapshot>("connector-snapshot", (event) => {
        if (!stopped) setSnapshot(event.payload);
      }),
    ])
      .then(([initial, defaultName, stopListening]) => {
        if (stopped) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        setSnapshot(initial);
        setDeviceName(defaultName);
        setApiBaseUrl(initial.settings?.apiBaseUrl ?? "");
        if (initial.settings && ["offline", "error"].includes(initial.phase)) {
          void invoke("connect_connector").catch((connectError) => {
            setError(errorMessage(connectError));
          });
        }
      })
      .catch((loadError) => setError(errorMessage(loadError)));
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, []);

  const run = React.useCallback(async <T,>(name: string, task: () => Promise<T>) => {
    setBusyAction(name);
    setError(null);
    try {
      return await task();
    } catch (taskError) {
      setError(errorMessage(taskError));
      throw taskError;
    } finally {
      setBusyAction(null);
    }
  }, []);

  async function handlePair(event: React.FormEvent) {
    event.preventDefault();
    await run("pair", async () => {
      const next = await invoke<ConnectorSnapshot>("pair_connector", {
        input: {
          apiBaseUrl,
          pairingCode: pairingCode.trim().toUpperCase(),
          deviceName: deviceName.trim(),
        },
      });
      setSnapshot(next);
      setPairingCode("");
    }).catch(() => undefined);
  }

  async function invokeSnapshot(command: string, args?: Record<string, unknown>) {
    const next = await invoke<ConnectorSnapshot>(command, args);
    setSnapshot(next);
  }

  if (!snapshot) {
    return (
      <main className="app-shell loading-shell">
        <div className="loading-mark" />
        <p>Connector 상태를 확인하고 있습니다.</p>
        {error ? <p className="error-banner">{error}</p> : null}
      </main>
    );
  }

  const connected = snapshot.settings !== null;
  const online = snapshot.phase === "online" || snapshot.phase === "busy";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/termes-icon.png" alt="" className="brand-logo" />
          <div>
            <strong>Termes Connector</strong>
            <span>Windows · macOS</span>
          </div>
        </div>
        <div className={`connection-pill phase-${snapshot.phase}`}>
          <i />
          {phaseLabels[snapshot.phase]}
        </div>
      </header>

      {error || snapshot.lastError ? (
        <div className="error-banner" role="alert">
          <strong>연결을 확인해 주세요.</strong>
          <span>{error ?? snapshot.lastError}</span>
        </div>
      ) : null}

      {!connected ? (
        <section className="pairing-layout">
          <div className="hero-copy">
            <span className="eyebrow">워크스페이스 연결</span>
            <h1>이 PC를 Termes의<br />안전한 작업 도구로 연결</h1>
            <p>
              연결은 이 앱에서 Termes로만 시작됩니다. 요청된 작업은 로컬 승인과
              권한 검사를 통과한 뒤 실행되며, 언제든 즉시 중단할 수 있습니다.
            </p>
            <ul className="trust-list">
              <li>외부에서 PC로 들어오는 포트를 열지 않습니다.</li>
              <li>연결 자격 증명은 OS 보안 저장소에 보관됩니다.</li>
              <li>암호 입력·UAC·보안 권한 창은 자동 제어하지 않습니다.</li>
            </ul>
          </div>
          <form className="pair-card" onSubmit={handlePair}>
            <div className="step-number">01</div>
            <h2>페어링 코드 입력</h2>
            <p>Termes의 Devices 화면에서 일회용 코드를 생성하세요.</p>
            <label>
              Termes 주소
              <input
                type="url"
                required
                placeholder="https://termes.example.com"
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
              />
            </label>
            <label>
              PC 이름
              <input
                required
                maxLength={120}
                value={deviceName}
                onChange={(event) => setDeviceName(event.target.value)}
              />
            </label>
            <label>
              일회용 코드
              <input
                className="pair-code-input"
                required
                minLength={8}
                maxLength={11}
                autoComplete="one-time-code"
                spellCheck={false}
                placeholder="ABCD-EFGH"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
              />
            </label>
            <button className="primary-button" disabled={busyAction === "pair"} type="submit">
              {busyAction === "pair" ? "연결 확인 중…" : "워크스페이스에 연결"}
            </button>
          </form>
        </section>
      ) : (
        <div className="dashboard-grid">
          <section className="panel connection-panel">
            <div className="section-heading">
              <div>
                <span className="eyebrow">현재 연결</span>
                <h1>{snapshot.settings?.deviceName}</h1>
              </div>
              <span className="platform-badge">{snapshot.settings?.platform === "macos" ? "macOS" : "Windows"}</span>
            </div>
            <dl className="identity-grid">
              <div><dt>Workspace</dt><dd>{snapshot.settings?.workspaceKey}</dd></div>
              <div><dt>Project</dt><dd>{snapshot.settings?.projectName}</dd></div>
              <div><dt>Connector ID</dt><dd className="mono">{snapshot.settings?.connectorId.slice(0, 13)}…</dd></div>
            </dl>
            <div className="connection-actions">
              {online ? (
                <button
                  className="secondary-button"
                  disabled={busyAction === "disconnect"}
                  onClick={() => void run("disconnect", () => invokeSnapshot("disconnect_connector")).catch(() => undefined)}
                >
                  연결 끊기
                </button>
              ) : (
                <button
                  className="primary-button compact"
                  disabled={busyAction === "connect"}
                  onClick={() => void run("connect", async () => invoke("connect_connector")).catch(() => undefined)}
                >
                  다시 연결
                </button>
              )}
              <button
                className="danger-button"
                onClick={() => void run("stop", () => invokeSnapshot("emergency_stop_connector")).catch(() => undefined)}
              >
                즉시 중단
              </button>
            </div>
            <label className="policy-toggle">
              <input
                type="checkbox"
                checked={snapshot.settings?.autoObserve ?? false}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void run("policy", () => invokeSnapshot("set_auto_observe", { enabled })).catch(() => undefined);
                }}
              />
              <span>
                <strong>읽기 전용 분석 자동 허용</strong>
                <small>시스템·프로세스·화면 분석만 자동 승인합니다. 제어 작업은 항상 묻습니다.</small>
              </span>
            </label>
          </section>

          <section className="panel permissions-panel">
            <div className="section-heading inline">
              <div>
                <span className="eyebrow">로컬 권한</span>
                <h2>PC 접근 범위</h2>
              </div>
              <button
                className="text-button"
                onClick={() => void invoke<ConnectorSnapshot>("refresh_connector_permissions").then(setSnapshot)}
              >
                새로고침
              </button>
            </div>
            <div className="permission-list">
              {permissionLabels.map((permission) => {
                const value = snapshot.permissions[permission.key];
                return (
                  <div className="permission-row" key={permission.key}>
                    <div className={`permission-icon ${permissionTone(value)}`} />
                    <div className="permission-copy">
                      <strong>{permission.title}</strong>
                      <span>{permission.description}</span>
                    </div>
                    <div className="permission-control">
                      <span className={`status-label ${permissionTone(value)}`}>{permissionText(value)}</span>
                      {value === "denied" || value === "not_determined" ? (
                        <button
                          className="text-button"
                          onClick={() => void invoke("open_connector_permission_settings", { kind: permission.key }).catch((openError) => setError(errorMessage(openError)))}
                        >
                          설정 열기
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {snapshot.pendingApprovals.length > 0 ? (
            <section className="panel approvals-panel full-width">
              <div className="section-heading inline">
                <div>
                  <span className="eyebrow urgent">승인 대기</span>
                  <h2>Termes가 이 PC에서 작업을 요청했습니다</h2>
                </div>
                <span className="count-badge">{snapshot.pendingApprovals.length}</span>
              </div>
              <div className="approval-list">
                {snapshot.pendingApprovals.map((approval) => (
                  <ApprovalCard
                    key={approval.commandId}
                    approval={approval}
                    onDecision={(approved) => {
                      const command = approved ? "approve_connector_command" : "reject_connector_command";
                      void run(`approval-${approval.commandId}`, () => invoke(command, { commandId: approval.commandId })).catch(() => undefined);
                    }}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel activity-panel">
            <div className="section-heading inline">
              <div>
                <span className="eyebrow">활동</span>
                <h2>최근 연결 및 작업</h2>
              </div>
            </div>
            {snapshot.activities.length === 0 ? (
              <div className="empty-state">아직 기록된 작업이 없습니다.</div>
            ) : (
              <ol className="activity-list">
                {snapshot.activities.slice(0, 12).map((activity) => (
                  <li key={activity.id}>
                    <i className={activity.success === false ? "failed" : activity.success ? "succeeded" : ""} />
                    <div><strong>{activity.title}</strong><span>{activity.detail}</span></div>
                    <time>{formatDate(activity.at)}</time>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="panel capabilities-panel">
            <div className="section-heading inline">
              <div>
                <span className="eyebrow">Capabilities</span>
                <h2>이 Connector가 지원하는 작업</h2>
              </div>
            </div>
            <div className="capability-chips">
              {snapshot.capabilities.map((capability) => <span key={capability}>{actionLabel(capability)}</span>)}
            </div>
            <div className="boundary-note">
              <strong>안전 경계</strong>
              <p>Raw shell과 debugger 포트는 노출하지 않습니다. 보안 데스크톱, UAC, macOS 개인정보 보호 창은 사용자가 직접 처리해야 합니다.</p>
            </div>
            <button
              className="destructive-link"
              onClick={() => {
                if (!window.confirm("이 PC의 로컬 연결 자격 증명을 삭제할까요? Termes에서 완전히 폐기하려면 웹의 Devices 화면에서도 연결을 해제하세요.")) return;
                void run("forget", () => invokeSnapshot("forget_connector")).catch(() => undefined);
              }}
            >
              이 PC에서 연결 정보 삭제
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

function ApprovalCard({ approval, onDecision }: { approval: PendingApproval; onDecision: (approved: boolean) => void }) {
  return (
    <article className="approval-card">
      <div>
        <span className={`approval-kind ${approval.readOnly ? "observe" : "control"}`}>
          {approval.readOnly ? "분석" : "PC 제어"}
        </span>
        <h3>{actionLabel(approval.action)}</h3>
        <p className="mono approval-params">{JSON.stringify(approval.params)}</p>
        <small>{formatDate(approval.requestedAt)} 요청 · {formatDate(approval.deadline)} 만료</small>
      </div>
      <div className="approval-actions">
        <button className="secondary-button" onClick={() => onDecision(false)}>거부</button>
        <button className="primary-button compact" onClick={() => onDecision(true)}>이번 작업 허용</button>
      </div>
    </article>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

import type {
  DesktopConnectorPairingCodeSummary,
  DesktopConnectorPermissionState,
  DesktopConnectorStatus,
  DesktopConnectorSummary,
} from "@termes/shared";
import { Check, Clipboard, Laptop, Link2, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import React from "react";
import {
  createDesktopConnectorPairingCode,
  fetchDesktopConnectors,
  revokeDesktopConnector,
} from "./connector-api";
import "./connector.css";

interface DesktopConnectorSectionProps {
  projectId: string | null;
}

const statusLabels: Record<DesktopConnectorStatus, string> = {
  offline: "Offline",
  connecting: "Connecting",
  online: "Online",
  busy: "Busy",
  error: "Error",
  revoked: "Revoked",
};

const permissionLabels: Array<[keyof DesktopConnectorPermissionState, string]> = [
  ["accessibility", "UI 분석"],
  ["screenCapture", "화면 캡처"],
  ["inputControl", "키보드·포인터"],
  ["processInspection", "프로세스 진단"],
];

function formatDate(value: string | null): string {
  if (!value) return "기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function remainingSeconds(pairing: DesktopConnectorPairingCodeSummary | null, now: number): number {
  if (!pairing) return 0;
  return Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1_000));
}

export function DesktopConnectorSection({ projectId }: DesktopConnectorSectionProps) {
  const [connectors, setConnectors] = React.useState<DesktopConnectorSummary[]>([]);
  const [pairing, setPairing] = React.useState<DesktopConnectorPairingCodeSummary | null>(null);
  const [now, setNow] = React.useState(Date.now());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string>("");
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async () => {
    setBusy("load");
    try {
      setConnectors(await fetchDesktopConnectors());
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    setPairing(null);
  }, [projectId]);

  React.useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  React.useEffect(() => {
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function createPairing() {
    if (!projectId) return;
    setBusy("pairing");
    setCopied(false);
    try {
      setPairing(await createDesktopConnectorPairingCode(projectId));
      setNow(Date.now());
      setMessage("코드는 한 번만 사용할 수 있습니다. PC의 Termes Connector에 입력하세요.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function copyPairingCode() {
    if (!pairing) return;
    await navigator.clipboard.writeText(pairing.pairingCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_800);
  }

  async function revoke(connector: DesktopConnectorSummary) {
    if (!window.confirm(`${connector.name} 연결을 폐기할까요? 저장된 자격 증명으로는 다시 연결할 수 없습니다.`)) return;
    setBusy(connector.id);
    try {
      await revokeDesktopConnector(connector.id);
      setConnectors((current) => current.map((item) => item.id === connector.id
        ? { ...item, status: "revoked", revokedAt: new Date().toISOString() }
        : item));
      setMessage(`${connector.name} 연결을 폐기했습니다.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  const seconds = remainingSeconds(pairing, now);
  const pairingExpired = Boolean(pairing && seconds === 0);

  return (
    <section className="desktopConnectorSection" data-testid="desktop-connector-section">
      <header className="desktopConnectorHeader">
        <div>
          <span className="sectionLabel">Desktop Connector</span>
          <h3>Windows · macOS 연결</h3>
          <p>계정에 한 번 연결하면 모든 Workspace의 에이전트가 사용할 수 있는 outbound-only 연결입니다.</p>
        </div>
        <div className="desktopConnectorHeaderActions">
          <button
            className="aliasIconButton"
            type="button"
            title="Connector 새로고침"
            disabled={busy === "load"}
            onClick={() => void load()}
          >
            <RefreshCw size={14} className={busy === "load" ? "spin" : ""} />
          </button>
          <button
            className="aliasActionButton primary"
            type="button"
            data-testid="create-desktop-pairing-code"
            disabled={!projectId || Boolean(busy)}
            onClick={() => void createPairing()}
          >
            <Link2 size={14} /> 페어링 코드 생성
          </button>
        </div>
      </header>

      {pairing ? (
        <div className={`desktopPairingCard ${pairingExpired ? "expired" : ""}`} data-testid="desktop-pairing-code">
          <div>
            <span>{pairingExpired ? "코드 만료됨" : "일회용 페어링 코드"}</span>
            <strong>{pairing.pairingCode}</strong>
            <small>{pairingExpired ? "새 코드를 생성하세요." : `${seconds}초 후 만료 · 사용하면 즉시 폐기`}</small>
          </div>
          <button type="button" disabled={pairingExpired} onClick={() => void copyPairingCode()}>
            {copied ? <Check size={15} /> : <Clipboard size={15} />}
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
      ) : null}

      {message ? <p className="desktopConnectorMessage">{message}</p> : null}
      {!projectId ? <p className="desktopConnectorMessage">새 PC를 페어링하려면 프로젝트를 선택하세요.</p> : null}

      {connectors.length === 0 && busy !== "load" ? (
        <div className="desktopConnectorEmpty">
          <Laptop size={22} />
          <strong>연결된 PC가 없습니다.</strong>
          <span>코드를 생성하고 계정에서 사용할 Windows 또는 macOS PC를 페어링하세요.</span>
        </div>
      ) : (
        <div className="desktopConnectorList">
          {connectors.map((connector) => (
            <article className={`desktopConnectorCard status-${connector.status}`} key={connector.id}>
              <div className="desktopConnectorIdentity">
                <div className="desktopConnectorPlatform"><Laptop size={18} /></div>
                <div>
                  <div className="desktopConnectorNameLine">
                    <strong>{connector.name}</strong>
                    <span className={`desktopConnectorStatus ${connector.status}`}>
                      <i /> {statusLabels[connector.status]}
                    </span>
                  </div>
                  <span>{connector.platform === "macos" ? "macOS" : "Windows"} · App {connector.appVersion}</span>
                </div>
              </div>

              <div className="desktopConnectorMeta">
                <div><span>최근 연결</span><strong>{formatDate(connector.lastHeartbeatAt)}</strong></div>
                <div><span>Credential</span><strong>v{connector.credentialVersion}</strong></div>
                <div><span>Capabilities</span><strong>{connector.capabilities.length}</strong></div>
              </div>

              <div className="desktopConnectorPermissions">
                {permissionLabels.map(([key, label]) => (
                  <span className={connector.permissions[key] === "granted" ? "granted" : "missing"} key={key}>
                    <ShieldCheck size={11} /> {label}
                  </span>
                ))}
              </div>

              <div className="desktopConnectorCardFooter">
                <span className="mono">{connector.deviceId.slice(0, 13)}…</span>
                {connector.status !== "revoked" ? (
                  <button
                    type="button"
                    className="desktopConnectorRevoke"
                    disabled={busy === connector.id}
                    data-testid={`revoke-desktop-connector-${connector.id}`}
                    onClick={() => void revoke(connector)}
                  >
                    <Unplug size={13} /> 연결 폐기
                  </button>
                ) : <span className="desktopConnectorRevoked">폐기된 연결</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

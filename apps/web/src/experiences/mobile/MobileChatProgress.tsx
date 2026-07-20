import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Loader2,
  Route,
  Send,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  MobileChatProgressModel,
  MobileChatProgressRow,
  MobileChatProgressRowState,
} from "./chat-progress";

interface MobileChatProgressProps {
  progress: MobileChatProgressModel;
}

const stateLabels: Record<MobileChatProgressRowState, string> = {
  pending: "대기",
  running: "진행 중",
  completed: "완료",
  waiting: "입력 필요",
  failed: "실패",
};

function rowGlyph(row: MobileChatProgressRow): JSX.Element {
  if (row.kind === "request") return <Send size={16} />;
  if (row.kind === "routing") return <Route size={16} />;
  if (row.kind === "tool") return <Terminal size={16} />;
  if (row.kind === "specialist") return <Bot size={16} />;
  return <Sparkles size={16} />;
}

function stateGlyph(state: MobileChatProgressRowState): JSX.Element {
  if (state === "running") return <Loader2 className="spinIcon" size={15} />;
  if (state === "completed") return <CheckCircle2 size={15} />;
  if (state === "failed") return <CircleAlert size={15} />;
  return <Clock3 size={15} />;
}

export function MobileChatProgress({ progress }: MobileChatProgressProps): JSX.Element | null {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!progress.active) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [progress.active]);

  if (!progress.visible) return null;

  const completedCount = progress.rows.filter((row) => row.state === "completed").length;
  const failed = progress.rows.some((row) => row.state === "failed");
  const waiting = progress.rows.some((row) => row.state === "waiting");
  const tone = failed ? "failed" : waiting ? "waiting" : progress.active ? "active" : "completed";

  return (
    <details
      className={`mobileChatProgress status-${tone}`}
      data-testid="mobile-chat-progress"
      open={progress.active}
    >
      <summary aria-live="polite">
        <span className="mobileChatProgressPulse" aria-hidden="true">
          {failed ? <CircleAlert size={16} /> : progress.active ? <i /> : <CheckCircle2 size={16} />}
        </span>
        <span className="mobileChatProgressHeading">
          <strong>{progress.label}</strong>
          <small>{completedCount}/{progress.rows.length} 단계 완료</small>
        </span>
        {progress.active ? <time className="mobileChatProgressTimer">{elapsedSeconds}초</time> : null}
        <ChevronDown className="mobileChatProgressChevron" size={17} aria-hidden="true" />
      </summary>
      <div className="mobileChatProgressBody" role="status" aria-live="polite">
        {progress.rows.map((row) => (
          <div className={`mobileChatProgressRow status-${row.state}`} key={row.id}>
            <span className="mobileChatProgressKind" aria-hidden="true">{rowGlyph(row)}</span>
            <span className="mobileChatProgressCopy">
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </span>
            <span className="mobileChatProgressState">
              {stateGlyph(row.state)}
              <em>{stateLabels[row.state]}</em>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

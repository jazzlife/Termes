import { ShieldCheck, Zap } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { maximumAutonomyPolicy, type HermesPendingInteractionSummary } from "@termes/shared";

type ApprovalInteraction = Extract<HermesPendingInteractionSummary, { type: "approval" }>;

export function ApprovalGate({
  interaction,
  sending,
  onDecision,
}: {
  interaction: ApprovalInteraction;
  sending: boolean;
  onDecision: (choice: "once" | "session" | "always" | "deny") => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog
      aria-describedby="approval-gate-description"
      aria-labelledby="approval-gate-title"
      aria-modal="true"
      className="approvalGateDialog"
      data-testid="approval-gate"
      onCancel={(event) => event.preventDefault()}
      ref={dialogRef}
      role="alertdialog"
    >
      <div className="approvalGateBackdrop">
        <section className="approvalGate">
          <div className="approvalGateAutonomy">
            <Zap size={16} aria-hidden="true" />
            <span>최대 자율주행 활성 · 일반 작업은 승인 없이 실행됩니다</span>
          </div>
          <div className="approvalGateHeading">
            <span><ShieldCheck size={21} aria-hidden="true" /></span>
            <div>
              <p>HUMAN BOUNDARY</p>
              <h2 id="approval-gate-title">사용자 승인이 반드시 필요합니다</h2>
            </div>
          </div>
          <p id="approval-gate-description" className="approvalGateDescription">{interaction.description}</p>
          {interaction.command ? <code className="approvalGateCommand">{interaction.command}</code> : null}
          <p className="approvalGatePolicy">
            이 화면은 {maximumAutonomyPolicy.humanBoundaries.length}개 인간 전용 경계에서만 나타납니다. 승인 전에는 해당 실행이 진행되지 않습니다.
          </p>
          <div className="approvalGateActions">
            <button autoFocus disabled={sending} type="button" onClick={() => onDecision("once")}>한 번 승인</button>
            <button disabled={sending} type="button" onClick={() => onDecision("session")}>이번 세션 승인</button>
            {interaction.allowPermanent ? (
              <button className="primary" disabled={sending} type="button" onClick={() => onDecision("always")}>항상 승인</button>
            ) : null}
            <button className="danger" disabled={sending} type="button" onClick={() => onDecision("deny")}>거절</button>
          </div>
        </section>
      </div>
    </dialog>,
    document.body,
  );
}

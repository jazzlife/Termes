export type ApprovalScrollTarget = Pick<Element, "scrollIntoView">;

export function revealPendingApproval(
  pendingCount: number,
  target: ApprovalScrollTarget | null,
): void {
  if (pendingCount < 1 || !target) return;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
}

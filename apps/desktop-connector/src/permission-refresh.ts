type FocusTarget = {
  addEventListener(type: "focus", listener: () => void): void;
  removeEventListener(type: "focus", listener: () => void): void;
};

export function installPermissionFocusRefresh(
  target: FocusTarget,
  refresh: () => void,
): () => void {
  const handleFocus = () => refresh();
  target.addEventListener("focus", handleFocus);
  return () => target.removeEventListener("focus", handleFocus);
}

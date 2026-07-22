export function shouldSubmitChatOnEnter(
  key: string,
  shiftKey: boolean,
  isComposing = false,
): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}

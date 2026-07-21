export interface MobileChatTimelineMessage {
  id: string;
}

export type MobileChatTimelineItem<TMessage extends MobileChatTimelineMessage> =
  | { kind: "message"; message: TMessage }
  | { kind: "progress"; placement: "tail" | `after-${string}` };

export interface BuildMobileChatTimelineInput<TMessage extends MobileChatTimelineMessage> {
  messages: TMessage[];
  progressVisible: boolean;
  sendingMessage: boolean;
  turnUserMessageId: string | null;
}

export function buildMobileChatTimeline<TMessage extends MobileChatTimelineMessage>(
  input: BuildMobileChatTimelineInput<TMessage>,
): Array<MobileChatTimelineItem<TMessage>> {
  const anchorMessageId = !input.sendingMessage && input.turnUserMessageId && input.messages.some(
    (message) => message.id === input.turnUserMessageId,
  )
    ? input.turnUserMessageId
    : null;
  const timeline: Array<MobileChatTimelineItem<TMessage>> = [];

  for (const message of input.messages) {
    timeline.push({ kind: "message", message });
    if (input.progressVisible && message.id === anchorMessageId) {
      timeline.push({ kind: "progress", placement: `after-${message.id}` });
    }
  }

  if (input.progressVisible && !anchorMessageId) {
    timeline.push({ kind: "progress", placement: "tail" });
  }

  return timeline;
}

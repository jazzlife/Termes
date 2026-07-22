export interface MobileChatTimelineMessage {
  id: string;
}

export interface MobileChatTimelineProgress {
  id: string;
  userMessageId: string | null;
  createdAt: string;
}

export type MobileChatTimelineItem<TMessage extends MobileChatTimelineMessage> =
  | { kind: "message"; message: TMessage }
  | { kind: "progress"; progress: MobileChatTimelineProgress; placement: "tail" | `after-${string}` };

export interface BuildMobileChatTimelineInput<TMessage extends MobileChatTimelineMessage> {
  messages: TMessage[];
  progresses: MobileChatTimelineProgress[];
}

export function buildMobileChatTimeline<TMessage extends MobileChatTimelineMessage>(
  input: BuildMobileChatTimelineInput<TMessage>,
): Array<MobileChatTimelineItem<TMessage>> {
  const messageIds = new Set(input.messages.map((message) => message.id));
  const progressesByMessageId = new Map<string, MobileChatTimelineProgress[]>();
  const tailProgresses: MobileChatTimelineProgress[] = [];
  for (const progress of input.progresses) {
    if (!progress.userMessageId || !messageIds.has(progress.userMessageId)) {
      tailProgresses.push(progress);
      continue;
    }
    const anchored = progressesByMessageId.get(progress.userMessageId) || [];
    anchored.push(progress);
    progressesByMessageId.set(progress.userMessageId, anchored);
  }
  const timeline: Array<MobileChatTimelineItem<TMessage>> = [];

  for (const message of input.messages) {
    timeline.push({ kind: "message", message });
    for (const progress of progressesByMessageId.get(message.id) || []) {
      timeline.push({ kind: "progress", progress, placement: `after-${message.id}` });
    }
  }

  for (const progress of tailProgresses) {
    timeline.push({ kind: "progress", progress, placement: "tail" });
  }

  return timeline;
}

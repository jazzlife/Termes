/**
 * UI-independent projection of Hermes gateway events.
 *
 * The transition rules are adapted from the pinned Hermes desktop
 * `use-message-stream.ts` and `chat-messages.ts`. Keeping this reducer free of
 * React/store dependencies lets web, mobile, and server-side replay share one
 * deterministic conversation model.
 */

export const HERMES_STREAM_DELTA_FLUSH_MS = 33;

export type RichStreamPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: Record<string, unknown>;
      isError?: boolean;
    };

export type PendingInteraction =
  | { type: "clarify"; requestId: string; question: string; choices: string[] | null }
  | { type: "approval"; command: string; description: string; allowPermanent: boolean }
  | { type: "sudo"; requestId: string }
  | { type: "secret"; requestId: string; envVar: string; prompt: string };

export interface HermesGatewayEvent {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
}

export interface RichStreamState {
  sessionId: string;
  parts: RichStreamPart[];
  queuedAssistant: string;
  queuedReasoning: string;
  pending: boolean;
  busy: boolean;
  needsInput: boolean;
  interaction: PendingInteraction | null;
  error: string | null;
  toolSequence: number;
}

export function createRichStreamState(sessionId: string): RichStreamState {
  return {
    sessionId,
    parts: [],
    queuedAssistant: "",
    queuedReasoning: "",
    pending: false,
    busy: false,
    needsInput: false,
    interaction: null,
    error: null,
    toolSequence: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  if (!value.trim()) return {};
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

export function coerceHermesText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        const row = asRecord(item);
        return typeof row.text === "string"
          ? row.text
          : typeof row.output_text === "string"
            ? row.output_text
            : "";
      })
      .join("");
  }
  if (typeof value === "object") {
    const row = asRecord(value);
    if (typeof row.text === "string") return row.text;
    if (typeof row.output_text === "string") return row.output_text;
    return JSON.stringify(value);
  }
  return String(value);
}

const THINKING_STATUS_PREFIX_RE =
  /^\s*(?:(?:[^\s.]{1,16})\s+)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.\.\.\s*/i;
const EMPTY_THINKING_PLACEHOLDER_RE =
  /\b(?:current rewritten thinking|next thinking to process|provide the thinking content|don't see any .*thinking)\b/i;

export function coerceHermesReasoning(value: unknown): string {
  const raw = coerceHermesText(value).replace(THINKING_STATUS_PREFIX_RE, "");
  return EMPTY_THINKING_PLACEHOLDER_RE.test(raw) ? "" : raw;
}

function appendStreamPart(
  parts: RichStreamPart[],
  type: "text" | "reasoning",
  delta: string,
): RichStreamPart[] {
  if (!delta) return parts;
  const next = [...parts];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index];
    if (!part) continue;
    if (part.type === type) {
      next[index] = { ...part, text: `${part.text}${delta}` };
      return next;
    }
    if (part.type !== "text" && part.type !== "reasoning") break;
  }
  next.push({ type, text: delta });
  return next;
}

export function flushRichStreamDeltas(state: RichStreamState): RichStreamState {
  let parts = state.parts;
  if (state.queuedAssistant) parts = appendStreamPart(parts, "text", state.queuedAssistant);
  if (state.queuedReasoning) parts = appendStreamPart(parts, "reasoning", state.queuedReasoning);
  return { ...state, parts, queuedAssistant: "", queuedReasoning: "" };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function liveToolArgs(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...parseRecord(payload.args),
    ...parseRecord(payload.arguments),
    ...parseRecord(payload.input),
  };
}

function matchValuesFromPayload(payload: Record<string, unknown>): string[] {
  const args = liveToolArgs(payload);
  return [...new Set([
    firstString(args, ["search_term", "query"]),
    typeof payload.context === "string" ? payload.context : "",
    typeof payload.preview === "string" ? payload.preview : "",
  ].map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function matchValuesFromPart(part: RichStreamPart): string[] {
  if (part.type !== "tool-call") return [];
  return [...new Set([
    firstString(part.args, ["search_term", "query"]),
    typeof part.args.context === "string" ? part.args.context : "",
    typeof part.args.preview === "string" ? part.args.preview : "",
  ].map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function findToolIndex(
  parts: RichStreamPart[],
  name: string,
  stableId: string,
  payload: Record<string, unknown>,
  phase: "running" | "complete",
): number {
  const values = matchValuesFromPayload(payload);
  const overlaps = (index: number) => {
    const part = parts[index];
    if (!part) return false;
    const existing = new Set(matchValuesFromPart(part));
    return values.some((value) => existing.has(value));
  };

  if (stableId) {
    const stableIndex = parts.findIndex(
      (part) => part.type === "tool-call" && part.toolCallId === stableId,
    );
    if (stableIndex >= 0) return stableIndex;
    if (phase === "running" && values.length === 0) return -1;
  }

  const pending = parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => part.type === "tool-call" && part.toolName === name && part.result === undefined)
    .map(({ index }) => index);
  if (pending.length === 0) return -1;
  if (values.length) {
    const contextual = pending.find(overlaps);
    if (contextual !== undefined) return contextual;
  }
  if (pending.length === 1) {
    const only = pending[0];
    if (only === undefined) return -1;
    if (phase === "running" && values.length && !overlaps(only)) return stableId ? only : -1;
    return only;
  }
  if (phase === "complete" || stableId) return pending[0] ?? -1;
  return pending.at(-1) ?? -1;
}

function upsertTool(
  state: RichStreamState,
  payload: Record<string, unknown>,
  phase: "running" | "complete",
): RichStreamState {
  const flushed = flushRichStreamDeltas(state);
  const stableId = firstString(payload, ["tool_id", "tool_call_id", "id"]);
  const name = typeof payload.name === "string" && payload.name ? payload.name : "tool";
  const index = findToolIndex(flushed.parts, name, stableId, payload, phase);
  const previous = index >= 0 && flushed.parts[index]?.type === "tool-call"
    ? flushed.parts[index]
    : null;
  const args = {
    ...(previous?.args ?? {}),
    ...liveToolArgs(payload),
    ...(typeof payload.context === "string" && payload.context ? { context: payload.context } : {}),
    ...(typeof payload.preview === "string" && payload.preview ? { preview: payload.preview } : {}),
  };
  const toolSequence = previous ? flushed.toolSequence : flushed.toolSequence + 1;
  const toolCallId = stableId || previous?.toolCallId || `live-tool:${name}:${toolSequence}`;
  const result = phase === "complete"
    ? {
        ...parseRecord(previous?.result),
        ...parseRecord(payload.result),
        ...(typeof payload.inline_diff === "string" ? { inline_diff: payload.inline_diff } : {}),
        ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
        ...(typeof payload.message === "string" ? { message: payload.message } : {}),
        ...(typeof payload.preview === "string" ? { preview: payload.preview } : {}),
        ...(typeof payload.duration_s === "number" ? { duration_s: payload.duration_s } : {}),
        ...(payload.error ? { error: payload.error } : {}),
      }
    : undefined;
  const part: RichStreamPart = {
    type: "tool-call",
    toolCallId,
    toolName: name,
    args,
    ...(result ? { result, isError: Boolean(payload.error) } : {}),
  };
  const parts = [...flushed.parts];
  if (index < 0) parts.push(part);
  else parts[index] = part;
  return { ...flushed, parts, toolSequence };
}

function reconcileCompletion(state: RichStreamState, finalText: string): RichStreamState {
  const flushed = flushRichStreamDeltas(state);
  const normalizedFinal = finalText.trim();
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const reference = normalize(normalizedFinal);
  const parts = flushed.parts.filter((part) => {
    if (part.type === "text") return false;
    if (part.type !== "reasoning" || !reference) return true;
    const reasoning = normalize(part.text);
    return !(reasoning && (reference.startsWith(reasoning) || reasoning.startsWith(reference)));
  });
  if (normalizedFinal) parts.push({ type: "text", text: normalizedFinal });
  return {
    ...flushed,
    parts,
    pending: false,
    busy: false,
    needsInput: false,
    interaction: null,
    error: null,
  };
}

/** Apply one Hermes notification. Call `flushRichStreamDeltas` on the 33ms UI cadence. */
export function reduceHermesGatewayEvent(
  state: RichStreamState,
  event: HermesGatewayEvent,
): RichStreamState {
  if (event.session_id && event.session_id !== state.sessionId) return state;
  const payload = event.payload ?? {};

  switch (event.type) {
    case "message.start": {
      if (state.pending || state.busy) {
        // Replayed starts and approval-resume starts belong to the active
        // message, whose transcript must remain intact.
        return { ...flushRichStreamDeltas(state), pending: true, busy: true, needsInput: false, interaction: null, error: null };
      }
      // A session can process multiple commands. Each message owns its own
      // transcript and activity state, so carrying the previous message's
      // parts into this one would render stale response/status content.
      return {
        ...createRichStreamState(state.sessionId),
        pending: true,
        busy: true,
      };
    }
    case "message.delta":
      return { ...state, queuedAssistant: state.queuedAssistant + coerceHermesText(payload.text) };
    case "reasoning.delta":
      return { ...state, queuedReasoning: state.queuedReasoning + coerceHermesReasoning(payload.text) };
    case "reasoning.available": {
      const flushed = flushRichStreamDeltas(state);
      const text = coerceHermesReasoning(payload.text);
      if (!text || flushed.parts.some((part) => part.type === "text" && part.text.trim())) return flushed;
      return { ...flushed, parts: [...flushed.parts.filter((part) => part.type !== "reasoning"), { type: "reasoning", text }] };
    }
    case "thinking.delta":
      return state;
    case "tool.start":
    case "tool.progress":
    case "tool.generating":
      return upsertTool(state, payload, "running");
    case "tool.complete":
      return { ...upsertTool(state, payload, "complete"), needsInput: false };
    case "clarify.request": {
      const requestId = firstString(payload, ["request_id"]);
      const question = firstString(payload, ["question"]);
      if (!requestId || !question) return state;
      const choices = Array.isArray(payload.choices)
        ? payload.choices.filter((choice): choice is string => typeof choice === "string")
        : null;
      return { ...state, needsInput: true, interaction: { type: "clarify", requestId, question, choices } };
    }
    case "approval.request":
      return {
        ...state,
        needsInput: true,
        interaction: {
          type: "approval",
          command: firstString(payload, ["command"]),
          description: firstString(payload, ["description"]) || "dangerous command",
          allowPermanent: payload.allow_permanent !== false,
        },
      };
    case "sudo.request": {
      const requestId = firstString(payload, ["request_id"]);
      return requestId ? { ...state, needsInput: true, interaction: { type: "sudo", requestId } } : state;
    }
    case "secret.request": {
      const requestId = firstString(payload, ["request_id"]);
      return requestId
        ? {
            ...state,
            needsInput: true,
            interaction: {
              type: "secret",
              requestId,
              envVar: firstString(payload, ["env_var"]),
              prompt: firstString(payload, ["prompt"]),
            },
          }
        : state;
    }
    case "message.complete":
      return reconcileCompletion(
        state,
        coerceHermesText(payload.text) || coerceHermesText(payload.rendered),
      );
    case "error": {
      const flushed = flushRichStreamDeltas(state);
      return {
        ...flushed,
        pending: false,
        busy: false,
        needsInput: false,
        interaction: null,
        error: firstString(payload, ["message"]) || "Hermes reported an error",
      };
    }
    default:
      return state;
  }
}

import {
  createRichStreamState,
  flushRichStreamDeltas,
  reduceHermesGatewayEvent,
  type HermesGatewayEvent,
  type RichStreamState,
} from "@termes/hermes-compat";

export type MirroredFrame = {
  redisStreamId: string;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  direction: "upstream_to_client";
  frame: Record<string, unknown>;
};

export function gatewayEventFromFrame(frame: Record<string, unknown>): HermesGatewayEvent | null {
  if (frame.method !== "event" || !frame.params || typeof frame.params !== "object") return null;
  const params = frame.params as Record<string, unknown>;
  if (typeof params.type !== "string") return null;
  return {
    type: params.type,
    ...(typeof params.session_id === "string" ? { session_id: params.session_id } : {}),
    ...(params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
      ? { payload: params.payload as Record<string, unknown> }
      : {}),
  };
}

export function applyMirroredFrame(
  current: RichStreamState | null,
  frame: Record<string, unknown>,
): { event: HermesGatewayEvent | null; state: RichStreamState | null } {
  const event = gatewayEventFromFrame(frame);
  if (!event?.session_id) return { event, state: current };
  const previous = current ?? createRichStreamState(event.session_id);
  return { event, state: reduceHermesGatewayEvent(previous, event) };
}

export function settleProjectionBatch(state: RichStreamState): RichStreamState {
  return flushRichStreamDeltas(state);
}

export function compareRedisStreamIds(left: string, right: string): number {
  const parse = (value: string): [bigint, bigint] => {
    const match = /^(\d+)-(\d+)$/.exec(value);
    if (!match) throw new Error(`Invalid Redis stream id: ${value}`);
    return [BigInt(match[1]!), BigInt(match[2]!)];
  };
  const [leftMillis, leftSequence] = parse(left);
  const [rightMillis, rightSequence] = parse(right);
  if (leftMillis !== rightMillis) return leftMillis > rightMillis ? 1 : -1;
  if (leftSequence !== rightSequence) return leftSequence > rightSequence ? 1 : -1;
  return 0;
}

export type SpecialistCandidate = {
  id: string;
  roleName: string;
  status: "planned" | "running" | "completed" | "failed" | "cancelled";
  hermesSubagentId: string | null;
};

export function selectSpecialistCandidate(
  candidates: SpecialistCandidate[],
  payload: Record<string, unknown>,
): SpecialistCandidate | null {
  const childId = typeof payload.child_session_id === "string"
    ? payload.child_session_id
    : typeof payload.subagent_id === "string"
      ? payload.subagent_id
      : null;
  const description = [payload.goal, payload.text]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (childId ? candidates.find((candidate) => candidate.hermesSubagentId === childId) : undefined)
    ?? candidates.find((candidate) => description.includes(candidate.roleName.toLowerCase()))
    ?? candidates.find((candidate) => candidate.status === "planned")
    ?? candidates.find((candidate) => candidate.status === "running")
    ?? null;
}

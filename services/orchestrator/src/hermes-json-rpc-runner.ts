import WebSocket from "ws";
import { randomUUID } from "node:crypto";

export type HermesJsonRpcRunResult = {
  run_id: string;
  session_id: string;
  stored_session_id: string;
  status: "completed" | "failed" | "waiting_approval";
  output: string;
  model?: string;
  usage?: Record<string, unknown>;
  events: Array<{ type: string; session_id?: string; payload?: Record<string, unknown> }>;
};

export type HermesApprovalResolution =
  | { choice: "manual"; reason: string; policyMode: "maximum" }
  | { choice: "session" | "always"; reason: string; policyMode: "maximum" };

type RunnerInput = {
  managerUrl: string;
  serviceToken: string;
  realtimeBaseUrl?: string;
  projectId?: string;
  taskId?: string;
  cwd: string;
  title: string;
  prompt: string;
  coordinatorInstructions: string;
  expectedSpecialists: number;
  executionMode?: "direct" | "specialist";
  existingStoredSessionId?: string;
  requireEvidence?: boolean;
  requestTimeoutMs?: number;
  timeoutMs: number;
  onSessionCreated?: (identity: {
    runId: string;
    runtimeSessionId: string;
    storedSessionId: string;
  }) => Promise<void>;
  onSessionResumed?: (identity: { runtimeSessionId: string; storedSessionId: string }) => Promise<void>;
  onApprovalRequested?: (request: Record<string, unknown>) => Promise<HermesApprovalResolution>;
  onApprovalResolved?: (
    request: Record<string, unknown>,
    resolution: Exclude<HermesApprovalResolution, { choice: "manual" }>,
  ) => Promise<void>;
};

export type JsonRpcFrame = {
  id?: string | number | null;
  method?: string;
  params?: { type?: string; session_id?: string; payload?: Record<string, unknown> };
  result?: unknown;
  error?: { message?: string };
};

type SessionResult = {
  session_id?: string;
  stored_session_id?: string;
  info?: Record<string, unknown>;
  messages?: unknown[];
  running?: boolean;
  status?: string;
};

export type HermesResumeEvidence = {
  completedSpecialists: number;
  failedSpecialists: number;
  finalAssistantText: string;
  hasAuthoritativeDelegationLedger: boolean;
};

export function recoverLatestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    if (row.role !== "assistant") continue;
    const value = asText(row.text ?? row.content).trim();
    if (value) return value;
  }
  return "";
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).text === "string") {
        return (entry as Record<string, unknown>).text as string;
      }
      return "";
    }).join("");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.rendered === "string") return record.rendered;
  }
  return "";
}

/** Parse the durable, Hermes-generated async delegation completion ledger. */
export function recoverHermesResumeEvidence(messages: unknown): HermesResumeEvidence {
  if (!Array.isArray(messages)) {
    return {
      completedSpecialists: 0,
      failedSpecialists: 0,
      finalAssistantText: "",
      hasAuthoritativeDelegationLedger: false,
    };
  }
  let ledgerIndex = -1;
  let completedSpecialists = 0;
  let failedSpecialists = 0;
  let finalAssistantText = "";
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const row = message as Record<string, unknown>;
    const text = asText(row.text ?? row.content);
    if (text.includes("[ASYNC DELEGATION BATCH COMPLETE")) {
      ledgerIndex = index;
      completedSpecialists = (text.match(/^--- ✓ TASK \d+\/\d+/gm) || []).length;
      failedSpecialists = (text.match(/^--- ✗ TASK \d+\/\d+/gm) || []).length;
      continue;
    }
    if (ledgerIndex >= 0 && index > ledgerIndex && row.role === "assistant" && text.trim()) {
      finalAssistantText = text.trim();
    }
  }
  return {
    completedSpecialists,
    failedSpecialists,
    finalAssistantText,
    hasAuthoritativeDelegationLedger: ledgerIndex >= 0,
  };
}

async function gatewayUrl(managerUrl: string, serviceToken: string): Promise<string> {
  const response = await fetch(`${managerUrl.replace(/\/+$/, "")}/internal/gateway/connection?profile=default`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  });
  const body = await response.json() as { wsUrl?: string; error?: string };
  if (!response.ok || !body.wsUrl) {
    throw new Error(body.error || `Hermes gateway connection failed with ${response.status}`);
  }
  return body.wsUrl;
}

async function connectionUrl(input: RunnerInput): Promise<string> {
  if (!input.realtimeBaseUrl) return gatewayUrl(input.managerUrl, input.serviceToken);
  const base = input.realtimeBaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${base}/api/hermes/realtime-ticket`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.serviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectId: input.projectId ?? null, taskId: input.taskId ?? null }),
  });
  const body = await response.json() as { ticket?: string; wsPath?: string; error?: string };
  if (!response.ok || !body.ticket || !body.wsPath) {
    throw new Error(body.error || `Hermes realtime ticket failed with ${response.status}`);
  }
  const url = new URL(body.wsPath, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", body.ticket);
  return url.toString();
}

export class JsonRpcSocket {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private intentionalClose = false;

  constructor(
    private readonly onEvent: (event: NonNullable<JsonRpcFrame["params"]>) => void,
    private readonly onDisconnect: (error: Error) => void,
    private readonly requestTimeoutMs: number,
  ) {}

  async connect(url: string): Promise<void> {
    this.intentionalClose = false;
    const socket = new WebSocket(url, { maxPayload: 4 * 1024 * 1024 });
    this.socket = socket;
    socket.on("message", (raw, binary) => {
      if (binary || this.socket !== socket) return;
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(raw.toString()) as JsonRpcFrame;
      } catch {
        return;
      }
      if (frame.id !== undefined && frame.id !== null) {
        const call = this.pending.get(String(frame.id));
        if (!call) return;
        this.pending.delete(String(frame.id));
        clearTimeout(call.timer);
        if (frame.error) call.reject(new Error(frame.error.message || "Hermes RPC failed"));
        else call.resolve(frame.result);
        return;
      }
      if (frame.method === "event" && frame.params?.type) this.onEvent(frame.params);
    });
    socket.on("close", () => this.drop(socket, new Error("Hermes WebSocket closed")));
    socket.on("error", (error) => this.drop(socket, error));

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hermes WebSocket connection timed out")), 15_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Hermes gateway not connected"));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes JSON-RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.intentionalClose = true;
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close(1000, "termes_run_settled");
    }
    this.rejectPending(new Error("Hermes JSON-RPC connection closed"));
  }

  private drop(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.rejectPending(error);
    if (!this.intentionalClose) this.onDisconnect(error);
  }

  private rejectPending(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}

export async function executeHermesJsonRpcRun(input: RunnerInput): Promise<HermesJsonRpcRunResult> {
  const events: HermesJsonRpcRunResult["events"] = [];
  const completedSubagents = new Set<string>();
  const failedSubagents = new Map<string, string>();
  const evidenceMissingSubagents = new Set<string>();
  let runtimeSessionId = "";
  let storedSessionId = "";
  let finalOutput = "";
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  let settled = false;
  let recoveryEnabled = false;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastRequiredSubagentCompleteSequence = -1;
  let eventSequence = 0;
  let approvalCallback: Promise<void> | null = null;
  let finish!: (value: HermesJsonRpcRunResult) => void;
  let fail!: (error: Error) => void;

  const completion = new Promise<HermesJsonRpcRunResult>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  const settle = (status: HermesJsonRpcRunResult["status"], output: string) => {
    if (settled || !runtimeSessionId || !storedSessionId) return;
    settled = true;
    finish({
      run_id: `jsonrpc-${storedSessionId}`,
      session_id: runtimeSessionId,
      stored_session_id: storedSessionId,
      status,
      output,
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      events,
    });
    rpc.close();
  };

  const onEvent = (frame: NonNullable<JsonRpcFrame["params"]>) => {
    const event = {
      type: frame.type!,
      ...(frame.session_id ? { session_id: frame.session_id } : {}),
      ...(frame.payload ? { payload: frame.payload } : {}),
    };
    events.push(event);
    eventSequence += 1;
    if (frame.session_id && runtimeSessionId && frame.session_id !== runtimeSessionId) return;
    const payload = frame.payload ?? {};
    if (frame.type === "message.start") finalOutput = "";
    if (frame.type === "message.delta") finalOutput += asText(payload.text);
    if (frame.type === "session.info") {
      if (typeof payload.model === "string") model = payload.model;
      if (payload.usage && typeof payload.usage === "object") usage = payload.usage as Record<string, unknown>;
    }
    if (frame.type === "message.complete") {
      finalOutput = asText(payload.text) || asText(payload.rendered) || finalOutput;
      if (payload.usage && typeof payload.usage === "object") usage = payload.usage as Record<string, unknown>;
      if (/^Error:\s/i.test(finalOutput)) {
        settle("failed", finalOutput);
      } else if (completedSubagents.size >= input.expectedSpecialists && eventSequence > lastRequiredSubagentCompleteSequence) {
        if (failedSubagents.size > 0) {
          settle("failed", `Required Hermes specialists failed: ${[...failedSubagents.entries()].map(([id, status]) => `${id}=${status}`).join(", ")}`);
        } else if (evidenceMissingSubagents.size > 0) {
          settle("failed", `Required Hermes specialists returned no tool evidence: ${[...evidenceMissingSubagents].join(", ")}`);
        } else {
          settle("completed", finalOutput);
        }
      }
    } else if (frame.type === "subagent.complete") {
      const childId = typeof payload.child_session_id === "string"
        ? payload.child_session_id
        : typeof payload.id === "string"
          ? payload.id
          : `completed-${eventSequence}`;
      completedSubagents.add(childId);
      lastRequiredSubagentCompleteSequence = eventSequence;
      if (typeof payload.status === "string" && !["completed", "complete", "success", "ok"].includes(payload.status)) {
        failedSubagents.set(childId, payload.status);
      }
      const toolCount = typeof payload.tool_count === "number"
        ? payload.tool_count
        : typeof payload.tool_count === "string"
          ? Number.parseInt(payload.tool_count, 10)
          : 0;
      if (input.requireEvidence && (!Number.isFinite(toolCount) || toolCount < 1)) {
        evidenceMissingSubagents.add(childId);
      }
    } else if (frame.type === "approval.request") {
      if (!approvalCallback && input.onApprovalRequested) {
        approvalCallback = input.onApprovalRequested(payload)
          .then(async (resolution) => {
            if (resolution.choice === "manual") return;
            await rpc.request("approval.respond", {
              session_id: frame.session_id || runtimeSessionId,
              choice: resolution.choice,
            });
            await input.onApprovalResolved?.(payload, resolution);
          })
          .catch((error) => {
            settle("failed", `Failed to resolve Hermes approval request: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => { approvalCallback = null; });
      }
    } else if (frame.type === "error") {
      settle("failed", typeof payload.message === "string" ? payload.message : "Hermes reported an error");
    }
  };

  const scheduleReconnect = () => {
    if (!recoveryEnabled || settled || reconnecting || reconnectTimer) return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void attemptReconnect();
    }, delay);
    reconnectTimer.unref();
  };

  const rpc = new JsonRpcSocket(
    onEvent,
    scheduleReconnect,
    Math.min(input.requestTimeoutMs ?? 30_000, input.timeoutMs),
  );

  const addRecoveredEvents = (evidence: HermesResumeEvidence) => {
    const existingRecovered = events.filter((event) => event.payload?.recovered_from === "session.resume").length;
    for (let index = existingRecovered; index < evidence.completedSpecialists + evidence.failedSpecialists; index += 1) {
      const completed = index < evidence.completedSpecialists;
      events.push({
        type: "subagent.complete",
        session_id: runtimeSessionId,
        payload: {
          child_session_id: `resume-ledger-${index + 1}`,
          status: completed ? "completed" : "failed",
          summary: "Recovered from Hermes async delegation ledger",
          recovered_from: "session.resume",
        },
      });
      if (completed) completedSubagents.add(`resume-ledger-${index + 1}`);
    }
  };

  async function attemptReconnect(): Promise<void> {
    if (!recoveryEnabled || settled || reconnecting) return;
    reconnecting = true;
    try {
      await rpc.connect(await connectionUrl(input));
      const resumed = await rpc.request<SessionResult>("session.resume", {
        session_id: storedSessionId,
        cols: 96,
        source: "termes-orchestrator",
        auto_title: false,
      });
      if (!resumed.session_id) throw new Error("Hermes session.resume returned no live session id");
      runtimeSessionId = resumed.session_id;
      await input.onSessionResumed?.({ runtimeSessionId, storedSessionId });
      reconnectAttempt = 0;
      const evidence = recoverHermesResumeEvidence(resumed.messages);
      if (input.executionMode === "direct") {
        const directOutput = recoverLatestAssistantText(resumed.messages);
        if (directOutput && resumed.running !== true) settle("completed", directOutput);
        else if (resumed.running === false) settle("failed", "Hermes direct session stopped without a final assistant response");
        return;
      }
      if (evidence.hasAuthoritativeDelegationLedger) {
        addRecoveredEvents(evidence);
        if (evidence.failedSpecialists > 0) {
          settle("failed", "Hermes durable delegation ledger contains failed specialist work");
        } else if (
          evidence.completedSpecialists >= input.expectedSpecialists
          && evidence.finalAssistantText
          && resumed.running !== true
        ) {
          settle("completed", evidence.finalAssistantText);
        }
      } else if (resumed.running === false) {
        settle("failed", "Hermes session stopped without an authoritative specialist completion ledger");
      }
    } catch {
      rpc.close();
    } finally {
      reconnecting = false;
      if (!settled && recoveryEnabled && reconnectAttempt > 0) scheduleReconnect();
    }
  }

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    fail(new Error(`Hermes JSON-RPC run timed out after ${input.timeoutMs}ms`));
    rpc.close();
  }, input.timeoutMs);

  try {
    await rpc.connect(await connectionUrl(input));
    const createSession = () => rpc.request<SessionResult>("session.create", {
      cwd: input.cwd,
      title: input.title,
      source: "termes-orchestrator",
      close_on_disconnect: false,
      auto_title: false,
    });
    let session: SessionResult;
    if (input.existingStoredSessionId) {
      try {
        session = await rpc.request<SessionResult>("session.resume", {
          session_id: input.existingStoredSessionId,
          source: "termes-orchestrator",
          cols: 96,
          auto_title: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/session not found/i.test(message)) throw error;
        session = await createSession();
      }
    } else {
      session = await createSession();
    }
    runtimeSessionId = session.session_id || "";
    storedSessionId = session.stored_session_id || input.existingStoredSessionId || "";
    if (!runtimeSessionId || !storedSessionId) throw new Error("Hermes session.create returned an invalid session identity");
    if (typeof session.info?.model === "string") model = session.info.model;
    await input.onSessionCreated?.({
      runId: `jsonrpc-${storedSessionId}`,
      runtimeSessionId,
      storedSessionId,
    });
    recoveryEnabled = true;
    try {
      await rpc.request("prompt.submit", {
        session_id: runtimeSessionId,
        text: `${input.coordinatorInstructions}\n\nUser task:\n${input.prompt}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/closed|not connected|socket|session not found/i.test(message)) throw error;
      if (/session not found/i.test(message)) rpc.close();
      scheduleReconnect();
    }
    return await completion;
  } finally {
    clearTimeout(timeout);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    rpc.close();
  }
}

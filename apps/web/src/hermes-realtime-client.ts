import {
  HERMES_STREAM_DELTA_FLUSH_MS,
  JsonRpcGatewayClient,
  createRichStreamState,
  flushRichStreamDeltas,
  reduceHermesGatewayEvent,
  type ConnectionState,
  type GatewayEvent,
  type PendingInteraction,
  type RichStreamState,
} from "@termes/hermes-compat";

type TicketResponse = {
  ticket: string;
  expiresIn: number;
  wsPath: string;
};

export type HermesSessionCreateInput = {
  cwd: string;
  title?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  fast?: boolean;
};

export type HermesSessionCreateResult = {
  session_id: string;
  stored_session_id: string;
  messages: unknown[];
  info: Record<string, unknown>;
};

type GatewayPort = Pick<JsonRpcGatewayClient, "connect" | "close" | "onAny" | "onState" | "request">;

type SessionBinding = {
  stableSessionId: string;
  runtimeSessionId: string;
  storedSessionId: string;
};

function realtimeUrl(path: string, ticket: string, location: Location): string {
  const url = new URL(path, location.origin);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export class HermesRealtimeClient {
  private readonly streams = new Map<string, RichStreamState>();
  private readonly streamListeners = new Set<(state: RichStreamState) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private detachEvent: (() => void) | null = null;
  private detachState: (() => void) | null = null;
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly runtimeToStable = new Map<string, string>();
  private scope: { projectId?: string | null; taskId?: string | null } = {};
  private wantOpen = false;
  private hasOpened = false;
  private lastState: ConnectionState = "idle";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectPromise: Promise<void> | null = null;

  constructor(
    private readonly gateway: GatewayPort = new JsonRpcGatewayClient({ requestIdPrefix: "termes-web-" }),
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly browserLocation: Location = window.location,
  ) {}

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    return this.gateway.onState(listener);
  }

  onStream(listener: (state: RichStreamState) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  stream(sessionId: string): RichStreamState {
    const runtimeSessionId = this.resolveRuntimeSessionId(sessionId);
    return this.streams.get(runtimeSessionId) ?? createRichStreamState(runtimeSessionId);
  }

  async connect(scope: { projectId?: string | null; taskId?: string | null } = {}): Promise<void> {
    this.scope = scope;
    this.wantOpen = true;
    this.ensureHandlers();
    await this.openFreshTicket();
    this.hasOpened = true;
    this.reconnectAttempt = 0;
  }

  async reconnectNow(): Promise<void> {
    if (!this.wantOpen) throw new Error("Hermes realtime client is closed");
    if (this.lastState === "open") return;
    this.clearReconnectTimer();
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      try {
        await this.openFreshTicket();
        await this.resumeSessions();
        this.hasOpened = true;
        this.reconnectAttempt = 0;
      } catch (error) {
        this.scheduleReconnect();
        throw error;
      } finally {
        this.reconnectPromise = null;
      }
    })();
    return this.reconnectPromise;
  }

  private async openFreshTicket(): Promise<void> {
    const response = await this.fetcher("/api/hermes/realtime-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: this.scope.projectId ?? null, taskId: this.scope.taskId ?? null }),
    });
    const body = (await response.json()) as Partial<TicketResponse> & { error?: string };
    if (!response.ok || !body.ticket || !body.wsPath) {
      throw new Error(body.error || `Hermes realtime ticket failed with ${response.status}`);
    }

    await this.gateway.connect(realtimeUrl(body.wsPath, body.ticket, this.browserLocation));
  }

  close(): void {
    this.wantOpen = false;
    this.clearReconnectTimer();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushAll();
    this.detachEvent?.();
    this.detachEvent = null;
    this.detachState?.();
    this.detachState = null;
    this.gateway.close();
  }

  async createSession(input: HermesSessionCreateInput): Promise<HermesSessionCreateResult> {
    const result = await this.gateway.request<HermesSessionCreateResult>("session.create", {
      cwd: input.cwd,
      source: "termes-mobile",
      close_on_disconnect: false,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
      ...(input.provider?.trim() ? { provider: input.provider.trim() } : {}),
      ...(input.reasoningEffort?.trim() ? { reasoning_effort: input.reasoningEffort.trim() } : {}),
      ...(input.fast ? { fast: true } : {}),
    });
    if (!result.session_id || !result.stored_session_id) {
      throw new Error("Hermes session.create returned an invalid session identity");
    }
    this.streams.set(result.session_id, createRichStreamState(result.session_id));
    this.sessions.set(result.session_id, {
      stableSessionId: result.session_id,
      runtimeSessionId: result.session_id,
      storedSessionId: result.stored_session_id,
    });
    this.runtimeToStable.set(result.session_id, result.session_id);
    return result;
  }

  submitPrompt(sessionId: string, text: string): Promise<Record<string, unknown>> {
    const prompt = text.trim();
    if (!prompt) return Promise.reject(new Error("Prompt cannot be empty"));
    return this.requestWithReconnect("prompt.submit", {
      session_id: this.resolveRuntimeSessionId(sessionId),
      text: prompt,
    });
  }

  interrupt(sessionId: string): Promise<Record<string, unknown>> {
    return this.requestWithReconnect("session.interrupt", {
      session_id: this.resolveRuntimeSessionId(sessionId),
    });
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const normalizedMethod = method.trim();
    if (!normalizedMethod) return Promise.reject(new Error("Hermes JSON-RPC method is required"));
    return this.requestWithReconnect<T>(normalizedMethod, params);
  }

  respond(sessionId: string, interaction: PendingInteraction, value: string | boolean): Promise<unknown> {
    if (interaction.type === "clarify") {
      return this.requestWithReconnect("clarify.respond", {
        session_id: this.resolveRuntimeSessionId(sessionId),
        request_id: interaction.requestId,
        answer: String(value),
      });
    }
    if (interaction.type === "sudo") {
      return this.requestWithReconnect("sudo.respond", {
        session_id: this.resolveRuntimeSessionId(sessionId),
        request_id: interaction.requestId,
        password: String(value),
      });
    }
    if (interaction.type === "secret") {
      return this.requestWithReconnect("secret.respond", {
        session_id: this.resolveRuntimeSessionId(sessionId),
        request_id: interaction.requestId,
        value: String(value),
      });
    }
    return this.requestWithReconnect("approval.respond", {
      session_id: this.resolveRuntimeSessionId(sessionId),
      choice: Boolean(value) ? "once" : "deny",
    });
  }

  private consume(event: GatewayEvent): void {
    const sessionId = event.session_id;
    if (!sessionId) return;
    const previous = this.streams.get(sessionId) ?? createRichStreamState(sessionId);
    const normalizedPayload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : null;
    const next = reduceHermesGatewayEvent(previous, {
      type: event.type,
      session_id: sessionId,
      ...(normalizedPayload ? { payload: normalizedPayload } : {}),
    });
    this.streams.set(sessionId, next);

    const isDelta = event.type === "message.delta" || event.type === "reasoning.delta";
    if (isDelta) this.scheduleFlush();
    else this.emit(next);
  }

  private ensureHandlers(): void {
    if (!this.detachEvent) this.detachEvent = this.gateway.onAny((event) => this.consume(event));
    if (!this.detachState) {
      this.detachState = this.gateway.onState((state) => {
        this.lastState = state;
        if (state === "open") {
          this.reconnectAttempt = 0;
          return;
        }
        if (this.wantOpen && this.hasOpened && (state === "closed" || state === "error")) {
          this.scheduleReconnect();
        }
      });
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantOpen || this.reconnectTimer || this.reconnectPromise || this.lastState === "open") return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(this.reconnectAttempt, 4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow().catch(() => undefined);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async resumeSessions(): Promise<void> {
    for (const binding of this.sessions.values()) {
      const resumed = await this.gateway.request<{ session_id?: string; messages?: unknown[] }>("session.resume", {
        session_id: binding.storedSessionId,
        cols: 96,
        source: "termes-mobile",
      });
      const nextRuntimeId = resumed.session_id || "";
      if (!nextRuntimeId) throw new Error(`Hermes session.resume did not return a live id for ${binding.storedSessionId}`);
      const previousRuntimeId = binding.runtimeSessionId;
      const previous = flushRichStreamDeltas(
        this.streams.get(previousRuntimeId) ?? createRichStreamState(previousRuntimeId),
      );
      this.streams.delete(previousRuntimeId);
      this.runtimeToStable.delete(previousRuntimeId);
      binding.runtimeSessionId = nextRuntimeId;
      this.runtimeToStable.set(nextRuntimeId, binding.stableSessionId);
      this.streams.set(nextRuntimeId, { ...previous, sessionId: nextRuntimeId });
      this.emit(this.streams.get(nextRuntimeId)!);
    }
  }

  private resolveRuntimeSessionId(sessionId: string): string {
    return this.sessions.get(sessionId)?.runtimeSessionId
      ?? this.sessions.get(this.runtimeToStable.get(sessionId) || "")?.runtimeSessionId
      ?? sessionId;
  }

  private async requestWithReconnect<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return await this.gateway.request<T>(method, params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not connected|connection closed|websocket closed/i.test(message)) throw error;
      await this.reconnectNow();
      const nextParams = typeof params.session_id === "string"
        ? { ...params, session_id: this.resolveRuntimeSessionId(params.session_id) }
        : params;
      return this.gateway.request<T>(method, nextParams);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushAll();
    }, HERMES_STREAM_DELTA_FLUSH_MS);
  }

  private flushAll(): void {
    for (const [sessionId, state] of this.streams) {
      if (!state.queuedAssistant && !state.queuedReasoning) continue;
      const next = flushRichStreamDeltas(state);
      this.streams.set(sessionId, next);
      this.emit(next);
    }
  }

  private emit(state: RichStreamState): void {
    for (const listener of this.streamListeners) listener(state);
  }
}

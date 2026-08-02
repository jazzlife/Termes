import { createHash } from "node:crypto";

import { JsonRpcSocket, type JsonRpcFrame } from "./hermes-json-rpc-runner";
import {
  MAX_CONCURRENT_SPECIALISTS,
  parseAgentRouteDecision,
  parseRoutingScreeningDecision,
  routeDecisionFromScreening,
  type RouteDecision,
  type RoutingScreeningDecision,
  type RoutingSystemContext,
} from "./routing-policy";

type Scope = {
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
};

type RoutingSpecialistInput = Scope & {
  managerUrl: string;
  serviceToken: string;
  cwd: string;
  timeoutMs?: number;
  preparationTimeoutMs?: number;
  storedSessionId?: string | null;
};

type SessionResult = {
  session_id?: string;
  stored_session_id?: string;
  running?: boolean;
};

const ROUTING_MODEL = "gpt-5.4-mini";

function fastRoutingPrompt(
  currentRequest: string,
  recentSummary: string,
  systemContext?: RoutingSystemContext,
): string {
  return [
    "You are the always-ready Termes Fast Routing Agent. Classify the context first. Do not plan specialists, tools, risks, or execution.",
    "Do not call tools. Ignore task titles. Prefer the current request over history. Output exactly one compact JSON object with no markdown or extra fields.",
    "questionType=conversation|general-question|project-read|analysis|design|coding|operation|research|security|clarification|system-control",
    "contextType=current-turn|recent-conversation|system-context|project-state|external-context",
    "domain=software|security|operations|data|research|product|general",
    "Set professionalRequired=true for design, coding, implementation, modification, project/file inspection, analysis requiring evidence, research, operations, deployment, data work, security review, or external verification. Then answer must be null.",
    "Set professionalRequired=false only when you can answer accurately now from the request, recent conversation, general knowledge, or supplied System context. Include the complete concise Korean answer in answer.",
    "A request not to modify files still requires professional read-only inspection. Project name/path supplied in System context can be answered without professional work.",
    "If essential user information is missing, use clarification with a single concise Korean question in answer.",
    "Exact response example:",
    JSON.stringify({
      questionType: "conversation",
      contextType: "current-turn",
      domain: "general",
      professionalRequired: false,
      answer: "한국어 답변",
    }),
    `System context: ${JSON.stringify(systemContext || {})}`,
    `Recent summary: ${recentSummary.slice(-2_000) || "none"}`,
    `Current request: ${currentRequest}`,
  ].join("\n");
}

function professionalPlanningPrompt(
  currentRequest: string,
  recentSummary: string,
  screening: RoutingScreeningDecision,
  systemContext?: RoutingSystemContext,
): string {
  return [
    "You are the Termes Professional Planner Agent. The Fast Routing Agent already classified this request as requiring professional work.",
    "Do not answer directly, call tools, or delegate. Plan the exact professional execution and output one compact JSON object with no markdown or extra fields.",
    "route=single-specialist|parallel-specialists|critical-synthesis; intent=analysis|implementation|operation|destructive",
    "primaryDomain/secondaryDomains/specialist.domain=software|security|operations|data|research|product|general",
    "riskSignals=destructive-change|auth-or-secret|production-or-deploy|security-impact|multi-account-isolation|external-device",
    "contextRequirement=current-turn|recent-summary|project-state; action=read|analyze|implement|operate|delete",
    "target=code|runtime|data|security|product|research|general|unknown; scope=current-turn|recent-summary|project-state|system-context",
    "specialist.toolsets=file|terminal|web|browser; capabilities=github-project-bootstrap|runner-worktree-verification|web-pwa-verification|linux-ssh-ops|windows-powershell-ops|android-adb-debug|tizen-sdb-debug|desktop-app-debug|local-mock-device",
    "Select desktop-app-debug when the user asks Termes to create or change an app and run it on an Account-owned Desktop Connector to inspect stdout/stderr debug logs.",
    `Hermes permits at most ${MAX_CONCURRENT_SPECIALISTS} concurrent specialists per delegation batch. single-specialist requires 1 specialist; parallel-specialists requires 2-${MAX_CONCURRENT_SPECIALISTS}; critical-synthesis requires exactly ${MAX_CONCURRENT_SPECIALISTS}, including an independent critic and evidence verifier.`,
    "Every execution requires runner-worktree-verification. Production, auth, security boundary, account isolation, or destructive mutation requires critical-synthesis.",
    "Every specialist must be distinct, concrete, required=true, and limited to the tools it needs. directAnswer must be null.",
    `Specialist shape: ${JSON.stringify({ domain: "software", role: "Software Specialist", mission: "Inspect current project evidence and complete the requested work.", toolsets: ["file", "terminal"], required: true })}`,
    "Exact response example:",
    JSON.stringify({
      intent: "analysis", route: "single-specialist", primaryDomain: "software", secondaryDomains: [], riskSignals: [],
      contextRequirement: "project-state", action: "analyze", target: "code", scope: "project-state",
      requiresMutation: false, requiresInspection: true, reasonCodes: ["professional-project-analysis"],
      specialists: [{ domain: "software", role: "Software Specialist", mission: "Inspect project evidence and return a verified analysis.", toolsets: ["file", "terminal"], required: true }],
      capabilities: ["runner-worktree-verification"], directAnswer: null,
    }),
    `Fast classification: ${JSON.stringify(screening)}`,
    `System context: ${JSON.stringify(systemContext || {})}`,
    `Recent summary: ${recentSummary.slice(-4_000) || "none"}`,
    `Current request: ${currentRequest}`,
  ].join("\n");
}

async function gatewayUrl(input: RoutingSpecialistInput): Promise<string> {
  const url = new URL(`${input.managerUrl.replace(/\/+$/, "")}/internal/gateway/connection`);
  url.searchParams.set("profile", "default");
  url.searchParams.set("account_id", input.accountId);
  url.searchParams.set("workspace_id", input.workspaceId);
  url.searchParams.set("runtime_cell_id", input.runtimeCellId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${input.serviceToken}` } });
  const body = await response.json() as { wsUrl?: string; error?: string };
  if (!response.ok || !body.wsUrl) throw new Error(body.error || `Router gateway failed with ${response.status}`);
  return body.wsUrl;
}

export class HermesRoutingSpecialist {
  private rpc: JsonRpcSocket | null = null;
  private runtimeSessionId = "";
  private storedSessionId: string;
  private turnCount = 0;
  private warming: Promise<void> | null = null;
  private prepared = false;
  private preparing: Promise<void> | null = null;
  private active: {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    output: string;
    sessionId: string;
  } | null = null;

  constructor(private readonly input: RoutingSpecialistInput) {
    this.storedSessionId = input.storedSessionId || "";
  }

  get identity(): { runtimeSessionId: string; storedSessionId: string; ready: boolean; prepared: boolean } {
    return {
      runtimeSessionId: this.runtimeSessionId,
      storedSessionId: this.storedSessionId,
      ready: Boolean(this.rpc && this.runtimeSessionId),
      prepared: this.prepared,
    };
  }

  async warm(): Promise<void> {
    if (this.rpc && this.runtimeSessionId) return;
    if (this.warming) return this.warming;
    const warming = this.openSession();
    this.warming = warming;
    try {
      await warming;
    } finally {
      if (this.warming === warming) this.warming = null;
    }
  }

  async prepare(): Promise<void> {
    if (this.prepared) return;
    if (this.preparing) return this.preparing;
    const preparing = this.performPreparation();
    this.preparing = preparing;
    try {
      await preparing;
    } finally {
      if (this.preparing === preparing) this.preparing = null;
    }
  }

  private async performPreparation(): Promise<void> {
    const { text } = await this.submitRaw(
      fastRoutingPrompt("안녕하세요", "", undefined),
      this.input.preparationTimeoutMs ?? 60_000,
    );
    const decision = parseRoutingScreeningDecision(text);
    if (decision.questionType !== "conversation" || decision.professionalRequired || !decision.answer) {
      throw new Error("Routing Agent preparation returned a non-instant decision");
    }
    this.prepared = true;
  }

  private async openSession(): Promise<void> {
    const rpc = new JsonRpcSocket(
      (event) => this.onEvent(event),
      (error) => this.onDisconnect(error),
      Math.min(this.input.timeoutMs ?? 10_000, 30_000),
    );
    try {
      await rpc.connect(await gatewayUrl(this.input));
      if (this.storedSessionId) {
        try {
          const resumed = await rpc.request<SessionResult>("session.resume", {
            session_id: this.storedSessionId,
            source: "termes-routing-specialist",
            cols: 96,
            auto_title: false,
          });
          if (!resumed.session_id) throw new Error("Routing Agent session.resume returned no live session id");
          this.runtimeSessionId = resumed.session_id;
          this.turnCount = 1;
        } catch (error) {
          if (!/session not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
          this.storedSessionId = "";
          await this.createSession(rpc);
        }
      } else {
        await this.createSession(rpc);
      }
      this.rpc = rpc;
    } catch (error) {
      rpc.close();
      this.runtimeSessionId = "";
      throw error;
    }
  }

  private async createSession(rpc: JsonRpcSocket): Promise<void> {
    const created = await rpc.request<SessionResult>("session.create", {
      cwd: this.input.cwd,
      title: "Termes Fast Routing Agent",
      source: "termes-routing-specialist",
      close_on_disconnect: false,
      model: ROUTING_MODEL,
      provider: "openai-codex",
      reasoning_effort: "none",
      fast: true,
      auto_title: false,
    });
    if (!created.session_id || !created.stored_session_id) throw new Error("Routing Agent session.create returned an invalid identity");
    this.runtimeSessionId = created.session_id;
    this.storedSessionId = created.stored_session_id;
    this.turnCount = 0;
  }

  async classify(
    currentRequest: string,
    recentSummary: string,
    systemContext?: RoutingSystemContext,
    onScreened?: (screening: RoutingScreeningDecision, durationMs: number) => Promise<void> | void,
  ): Promise<{
    decision: RouteDecision;
    durationMs: number;
    screeningDurationMs: number;
    planningDurationMs: number;
    hash: string;
  }> {
    await this.prepare();
    const screened = await this.submitRaw(fastRoutingPrompt(currentRequest, recentSummary, systemContext));
    const screening = parseRoutingScreeningDecision(screened.text);
    await onScreened?.(screening, screened.durationMs);
    if (!screening.professionalRequired) {
      const decision = routeDecisionFromScreening(screening);
      const canonical = JSON.stringify(decision);
      return {
        decision,
        durationMs: screened.durationMs,
        screeningDurationMs: screened.durationMs,
        planningDurationMs: 0,
        hash: createHash("sha256").update(canonical).digest("hex"),
      };
    }
    const planned = await this.submitRaw(professionalPlanningPrompt(currentRequest, recentSummary, screening, systemContext));
    const decision = parseAgentRouteDecision(planned.text);
    if (!["single-specialist", "parallel-specialists", "critical-synthesis"].includes(decision.route)) {
      throw new Error("Professional Planner Agent returned a non-professional route");
    }
    const canonical = JSON.stringify(decision);
    return {
      decision,
      durationMs: screened.durationMs + planned.durationMs,
      screeningDurationMs: screened.durationMs,
      planningDurationMs: planned.durationMs,
      hash: createHash("sha256").update(canonical).digest("hex"),
    };
  }

  private async submitRaw(
    prompt: string,
    responseTimeoutMs = this.input.timeoutMs ?? 10_000,
  ): Promise<{ text: string; durationMs: number }> {
    if (this.active) throw new Error("Routing Agent received concurrent turns on one lane");
    await this.warm();
    const sessionId = this.runtimeSessionId;
    const startedAt = Date.now();
    const output = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.active = null;
        reject(new Error("Routing Agent response timed out"));
      }, responseTimeoutMs);
      timer.unref();
      this.active = { resolve, reject, timer, output: "", sessionId };
    });
    try {
      await this.rpc!.request("prompt.submit", {
        session_id: sessionId,
        text: prompt,
        ...(this.turnCount > 0 ? { truncate_before_user_ordinal: 0 } : {}),
      });
      const raw = await output;
      this.turnCount += 1;
      return { text: raw, durationMs: Date.now() - startedAt };
    } catch (error) {
      const active = this.active as { timer: NodeJS.Timeout } | null;
      if (active) {
        clearTimeout(active.timer);
        this.active = null;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/response timed out|JSON-RPC request timed out: prompt\.submit/i.test(message)) {
        await this.discardTimedOutSession(sessionId);
      } else if (/session not found/i.test(message)) {
        this.rpc?.close();
        this.rpc = null;
        this.runtimeSessionId = "";
        this.prepared = false;
      }
      throw error;
    }
  }

  private async discardTimedOutSession(sessionId: string): Promise<void> {
    const rpc = this.rpc;
    try {
      await rpc?.request("session.interrupt", { session_id: sessionId });
    } catch {
      // The timed-out session is discarded below even when interrupt acknowledgement is unavailable.
    } finally {
      rpc?.close();
      if (this.rpc === rpc) this.rpc = null;
      this.runtimeSessionId = "";
      this.storedSessionId = "";
      this.turnCount = 0;
      this.prepared = false;
    }
  }

  close(): void {
    this.rpc?.close();
    this.rpc = null;
    this.runtimeSessionId = "";
    this.prepared = false;
  }

  private onEvent(frame: NonNullable<JsonRpcFrame["params"]>): void {
    if (!this.active || frame.session_id !== this.active.sessionId) return;
    const payload = frame.payload ?? {};
    if (frame.type === "message.start") this.active.output = "";
    if (frame.type === "message.delta" && typeof payload.text === "string") this.active.output += payload.text;
    if (frame.type === "tool.start" || frame.type?.startsWith("subagent.")) {
      const current = this.active;
      this.active = null;
      clearTimeout(current.timer);
      void this.discardTimedOutSession(current.sessionId);
      current.reject(new Error(`Routing Agent attempted forbidden event: ${frame.type}`));
      return;
    }
    if (frame.type === "message.complete") {
      const current = this.active;
      this.active = null;
      clearTimeout(current.timer);
      const text = typeof payload.text === "string" ? payload.text : typeof payload.rendered === "string" ? payload.rendered : current.output;
      current.resolve(text);
    } else if (frame.type === "error") {
      const current = this.active;
      this.active = null;
      clearTimeout(current.timer);
      current.reject(new Error(typeof payload.message === "string" ? payload.message : "Routing Agent failed"));
    }
  }

  private onDisconnect(error: Error): void {
    this.rpc = null;
    this.runtimeSessionId = "";
    this.prepared = false;
    if (!this.active) return;
    const current = this.active;
    this.active = null;
    clearTimeout(current.timer);
    current.reject(error);
  }
}

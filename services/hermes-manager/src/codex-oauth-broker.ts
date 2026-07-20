import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

type RpcFrame = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type PendingCall = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type CodexOAuthSession = {
  id: string;
  loginId: string | null;
  status: "starting" | "awaiting_user" | "complete" | "error" | "expired" | "cancelled";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
};

export type CodexExternalAuthTokens = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export function normalizeCodexAccountState(value: Record<string, unknown>): Record<string, unknown> {
  const account = value.account;
  const authenticated = Boolean(
    account
    && typeof account === "object"
    && (account as Record<string, unknown>).type === "chatgpt",
  );
  return {
    ...value,
    requiresOpenaiAuth: !authenticated,
  };
}

class CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 0;
  private notificationHandler: ((frame: RpcFrame) => void) | null = null;
  private closed = false;

  constructor(codexBin: string, codexHome: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
    delete env.OPENAI_API_KEY;
    this.child = spawn(codexBin, ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    this.child.stderr.resume();
    this.child.on("exit", (code, signal) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const error = new Error(`codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "termes", title: "Termes", version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  onNotification(handler: (frame: RpcFrame) => void): void {
    this.notificationHandler = handler;
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server connection is closed"));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.send({ method, params });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("codex app-server connection closed"));
    }
    this.pending.clear();
    this.child.kill("SIGTERM");
  }

  private send(frame: RpcFrame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private handleLine(line: string): void {
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      return;
    }
    if (typeof frame.id === "number") {
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new Error(frame.error.message || `Codex RPC error ${frame.error.code ?? "unknown"}`));
      } else {
        pending.resolve(frame.result || {});
      }
      return;
    }
    if (frame.method) {
      this.notificationHandler?.(frame);
    }
  }
}

export class CodexOAuthBroker {
  private readonly sessions = new Map<string, { session: CodexOAuthSession; connection: CodexAppServerConnection }>();
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private accountCache: { expiresAt: number; value: Record<string, unknown> } | null = null;
  private authorityRefresh: Promise<CodexExternalAuthTokens> | null = null;

  constructor(
    private readonly codexBin: string,
    private readonly codexHome: string,
  ) {}

  async start(): Promise<CodexOAuthSession> {
    const active = [...this.sessions.values()].find(({ session }) =>
      session.status === "starting" || session.status === "awaiting_user",
    );
    if (active) {
      return { ...active.session };
    }

    const now = Date.now();
    const session: CodexOAuthSession = {
      id: randomUUID(),
      loginId: null,
      status: "starting",
      verificationUrl: null,
      userCode: null,
      error: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 15 * 60_000).toISOString(),
    };
    const connection = new CodexAppServerConnection(this.codexBin, this.codexHome);
    this.sessions.set(session.id, { session, connection });
    connection.onNotification((frame) => this.handleNotification(session.id, frame));

    try {
      await connection.initialize();
      const result = await connection.request("account/login/start", { type: "chatgptDeviceCode" });
      if (
        result.type !== "chatgptDeviceCode" ||
        typeof result.loginId !== "string" ||
        typeof result.verificationUrl !== "string" ||
        typeof result.userCode !== "string"
      ) {
        throw new Error("Codex returned an invalid ChatGPT device-code response");
      }
      session.loginId = result.loginId;
      session.verificationUrl = result.verificationUrl;
      session.userCode = result.userCode;
      session.status = "awaiting_user";
      setTimeout(() => this.expire(session.id), 15 * 60_000).unref();
      return { ...session };
    } catch (error) {
      session.status = "error";
      session.error = error instanceof Error ? error.message : String(error);
      connection.close();
      this.scheduleCleanup(session.id);
      return { ...session };
    }
  }

  get(sessionId: string): CodexOAuthSession | null {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.session } : null;
  }

  async cancel(sessionId: string): Promise<CodexOAuthSession | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return null;
    }
    if (entry.session.loginId && (entry.session.status === "starting" || entry.session.status === "awaiting_user")) {
      await entry.connection.request("account/login/cancel", { loginId: entry.session.loginId }).catch(() => ({}));
    }
    entry.session.status = "cancelled";
    entry.connection.close();
    this.scheduleCleanup(sessionId);
    return { ...entry.session };
  }

  async account(): Promise<Record<string, unknown>> {
    if (this.accountCache && this.accountCache.expiresAt > Date.now()) {
      return this.accountCache.value;
    }
    const connection = new CodexAppServerConnection(this.codexBin, this.codexHome);
    try {
      await connection.initialize();
      const value = normalizeCodexAccountState(
        await connection.request("account/read", { refreshToken: false }),
      );
      this.accountCache = { expiresAt: Date.now() + 15_000, value };
      return value;
    } finally {
      connection.close();
    }
  }

  async externalAuthTokens(forceRefresh: boolean): Promise<CodexExternalAuthTokens> {
    if (this.authorityRefresh) return this.authorityRefresh;
    const load = async () => {
      const connection = new CodexAppServerConnection(this.codexBin, this.codexHome);
      let account: Record<string, unknown>;
      try {
        await connection.initialize();
        account = await connection.request("account/read", { refreshToken: forceRefresh }, 30_000);
      } finally {
        connection.close();
      }
      const accountValue = account.account;
      if (!accountValue || typeof accountValue !== "object" || (accountValue as Record<string, unknown>).type !== "chatgpt") {
        throw new Error("ChatGPT OAuth authority is not authenticated");
      }
      const auth = JSON.parse(await readFile(path.join(this.codexHome, "auth.json"), "utf8")) as {
        tokens?: { access_token?: unknown; account_id?: unknown };
      };
      const accessToken = auth.tokens?.access_token;
      const chatgptAccountId = auth.tokens?.account_id;
      if (typeof accessToken !== "string" || !accessToken || typeof chatgptAccountId !== "string" || !chatgptAccountId) {
        throw new Error("ChatGPT OAuth authority returned incomplete external auth state");
      }
      const planType = (accountValue as Record<string, unknown>).planType;
      this.accountCache = {
        expiresAt: Date.now() + 15_000,
        value: normalizeCodexAccountState(account),
      };
      return {
        accessToken,
        chatgptAccountId,
        chatgptPlanType: typeof planType === "string" ? planType : null,
      };
    };
    if (!forceRefresh) return load();
    this.authorityRefresh = load().finally(() => { this.authorityRefresh = null; });
    return this.authorityRefresh;
  }

  async logout(): Promise<void> {
    const connection = new CodexAppServerConnection(this.codexBin, this.codexHome);
    try {
      await connection.initialize();
      await connection.request("account/logout");
      this.accountCache = null;
    } finally {
      connection.close();
    }
  }

  close(): void {
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
    for (const entry of this.sessions.values()) {
      entry.connection.close();
    }
    this.sessions.clear();
  }

  private handleNotification(sessionId: string, frame: RpcFrame): void {
    if (frame.method !== "account/login/completed") {
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return;
    }
    const success = frame.params?.success === true;
    entry.session.status = success ? "complete" : "error";
    entry.session.error = success ? null : String(frame.params?.error || "ChatGPT login failed");
    this.accountCache = null;
    setTimeout(() => entry.connection.close(), 250).unref();
    this.scheduleCleanup(sessionId);
  }

  private expire(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.session.status !== "awaiting_user") {
      return;
    }
    entry.session.status = "expired";
    entry.session.error = "ChatGPT device code expired";
    entry.connection.close();
    this.scheduleCleanup(sessionId);
  }

  private scheduleCleanup(sessionId: string): void {
    const existing = this.cleanupTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.cleanupTimers.delete(sessionId);
      const entry = this.sessions.get(sessionId);
      entry?.connection.close();
      this.sessions.delete(sessionId);
    }, 5 * 60_000);
    timer.unref();
    this.cleanupTimers.set(sessionId, timer);
  }
}

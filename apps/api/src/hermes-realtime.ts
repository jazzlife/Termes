import type { ApiConfig } from "./config";
import type { Db } from "./db";
import type { AccountPrincipal } from "./account-auth";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";

const TICKET_PREFIX = "termes.hermes.ws-ticket.";
const TICKET_TTL_SECONDS = 30;
const MAX_PENDING_FRAMES = 64;
const MAX_PENDING_BYTES = 1024 * 1024;
const MIRROR_STREAM = "termes.hermes.frames";
const MAX_MIRROR_QUEUE_FRAMES = 512;
const BLOCKED_SHARED_ACCOUNT_METHODS = new Set([
  "billing.auto_reload",
  "billing.charge",
  "billing.step_up",
  "model.save_key",
]);

type TicketClaims = {
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
  projectId: string | null;
  taskId: string | null;
  profile: "default";
  issuedAt: string;
  expiresAt: string;
};

type MirrorRecord = {
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
  projectId: string | null;
  taskId: string | null;
  direction: "upstream_to_client";
  frame: string;
};

const ticketInputSchema = z.object({
  projectId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
});

function ticketKey(ticket: string): string {
  return `${TICKET_PREFIX}${createHash("sha256").update(ticket).digest("hex")}`;
}

function secureTokenEqual(left: string, right: string): boolean {
  return createHash("sha256").update(left).digest().equals(createHash("sha256").update(right).digest());
}

function rawDataBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function blockedMethodResponse(data: RawData, binary: boolean): string | null {
  if (binary) return null;
  let frame: { id?: string | number | null; method?: string };
  try {
    frame = JSON.parse(data.toString()) as typeof frame;
  } catch {
    return null;
  }
  if (!frame.method || !BLOCKED_SHARED_ACCOUNT_METHODS.has(frame.method)) return null;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: frame.id ?? null,
    error: {
      code: -32001,
      message: `Termes shared-account policy blocks ${frame.method}`,
    },
  });
}

function redactFrame(raw: string): string | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }
  const secretPattern = /(password|passphrase|token|secret|credential|authorization|api[-_]?key|private[-_]?key|value)/i;
  const redact = (value: unknown, key = ""): unknown => {
    if (secretPattern.test(key)) {
      return "[REDACTED]";
    }
    if (Array.isArray(value)) {
      return value.map((item) => redact(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]),
      );
    }
    return value;
  };
  return JSON.stringify(redact(frame));
}

export class AsyncFrameMirror {
  private readonly queue: Array<{ record: MirrorRecord; attempts: number; deliver: () => void }> = [];
  private draining = false;

  constructor(private readonly redis: Redis, private readonly log: FastifyInstance["log"]) {}

  push(record: MirrorRecord, deliver: () => void): boolean {
    if (this.queue.length >= MAX_MIRROR_QUEUE_FRAMES) {
      this.log.error({ stream: MIRROR_STREAM }, "Hermes mirror queue saturated");
      return false;
    }
    this.queue.push({ record, attempts: 0, deliver });
    if (!this.draining) {
      this.draining = true;
      void this.drain();
    }
    return true;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const queued = this.queue[0];
        if (!queued) {
          continue;
        }
        try {
          const record = queued.record;
          await this.redis.xadd(
            MIRROR_STREAM,
            "*",
            "account_id",
            record.accountId,
            "workspace_id",
            record.workspaceId,
            "runtime_cell_id",
            record.runtimeCellId,
            "project_id",
            record.projectId || "",
            "task_id",
            record.taskId || "",
            "direction",
            record.direction,
            "frame",
            record.frame,
          );
          this.queue.shift();
          queued.deliver();
        } catch (error) {
          queued.attempts += 1;
          this.log.error(
            { err: error, stream: MIRROR_STREAM, attempts: queued.attempts },
            "Hermes mirror publish failed; frame retained for retry",
          );
          const retryMs = Math.min(5_000, 100 * 2 ** Math.min(queued.attempts - 1, 6));
          await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) {
        this.draining = true;
        void this.drain();
      }
    }
  }
}

export class CellFrameMirrorRegistry {
  private readonly mirrors = new Map<string, AsyncFrameMirror>();

  constructor(private readonly redis: Redis, private readonly log: FastifyInstance["log"]) {}

  push(record: MirrorRecord, deliver: () => void): boolean {
    let mirror = this.mirrors.get(record.runtimeCellId);
    if (!mirror) {
      mirror = new AsyncFrameMirror(this.redis, this.log);
      this.mirrors.set(record.runtimeCellId, mirror);
    }
    return mirror.push(record, deliver);
  }
}

async function validateTicketScope(
  db: Db,
  accountId: string,
  defaultWorkspaceId: string,
  projectId: string | null,
  taskId: string | null,
): Promise<string> {
  if (taskId) {
    const result = await db.pool.query<{ project_id: string; workspace_id: string }>(
      `
        select t.project_id, t.workspace_id
        from tasks t
        join project_members pm on pm.project_id = t.project_id and pm.user_id = $2
        where t.id = $1 and t.account_id = $2
      `,
      [taskId, accountId],
    );
    const task = result.rows[0];
    if (!task) {
      throw new Error("Task not found");
    }
    if (projectId && task.project_id !== projectId) {
      throw new Error("Task does not belong to the requested project");
    }
    return task.workspace_id;
  }
  if (projectId) {
    const result = await db.pool.query<{ workspace_id: string }>(
      `
        select p.workspace_id
        from projects p
        join project_members pm on pm.project_id = p.id and pm.user_id = $2
        where p.id = $1
      `,
      [
      projectId,
      accountId,
    ]);
    if ((result.rowCount ?? 0) === 0) {
      throw new Error("Project is not accessible by the authenticated account");
    }
    return result.rows[0]!.workspace_id;
  }
  const workspace = await db.pool.query(
    "select 1 from account_workspaces where id = $1 and account_id = $2 and status = 'active'",
    [defaultWorkspaceId, accountId],
  );
  if ((workspace.rowCount ?? 0) === 0) throw new Error("Account workspace is not active");
  return defaultWorkspaceId;
}

async function managerConnection(
  config: ApiConfig,
  claims: Pick<TicketClaims, "accountId" | "workspaceId" | "runtimeCellId">,
): Promise<string> {
  const url = new URL(`${config.hermesManagerUrl}/internal/gateway/connection`);
  url.searchParams.set("profile", "default");
  url.searchParams.set("account_id", claims.accountId);
  url.searchParams.set("workspace_id", claims.workspaceId);
  url.searchParams.set("runtime_cell_id", claims.runtimeCellId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.hermesManagerServiceToken}` },
  });
  const body = await response.json() as { wsUrl?: string; error?: string };
  if (!response.ok || !body.wsUrl) {
    throw new Error(body.error || `Hermes manager gateway connection failed with ${response.status}`);
  }
  return body.wsUrl;
}

export async function registerHermesRealtime(
  app: FastifyInstance,
  dependencies: {
    config: ApiConfig;
    db: Db;
    redis: Redis;
    principalForRequest: (request: FastifyRequest) => AccountPrincipal;
  },
): Promise<void> {
  const { config, db, redis, principalForRequest } = dependencies;
  const mirrors = new CellFrameMirrorRegistry(redis, app.log);

  app.post("/api/hermes/realtime-ticket", async (request, reply) => {
    const input = ticketInputSchema.parse(request.body || {});
    const projectId = input.projectId ?? null;
    const taskId = input.taskId ?? null;
    try {
      const presented = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice("Bearer ".length).trim()
        : "";
      const internalRequest = Boolean(
        presented && secureTokenEqual(presented, config.hermesManagerServiceToken),
      );
      let accountId: string;
      let defaultWorkspaceId: string;
      let runtimeCellId: string;
      if (internalRequest) {
        if (!taskId) throw new Error("Internal Hermes ticket requires a task scope");
        const ownership = await db.pool.query<{
          account_id: string;
          workspace_id: string;
          runtime_cell_id: string;
        }>(
          `
            select t.account_id, t.workspace_id, rc.id as runtime_cell_id
            from tasks t
            join runtime_cells rc
              on rc.account_id = t.account_id and rc.workspace_id = t.workspace_id and rc.status = 'active'
            where t.id = $1
          `,
          [taskId],
        );
        const owner = ownership.rows[0];
        if (!owner) throw new Error("Task account cell is not active");
        accountId = owner.account_id;
        defaultWorkspaceId = owner.workspace_id;
        runtimeCellId = owner.runtime_cell_id;
      } else {
        const principal = principalForRequest(request);
        accountId = principal.accountId;
        defaultWorkspaceId = principal.workspaceId;
        runtimeCellId = principal.runtimeCellId;
      }
      const workspaceId = await validateTicketScope(
        db,
        accountId,
        defaultWorkspaceId,
        projectId,
        taskId,
      );
      const ticket = randomBytes(32).toString("base64url");
      const now = Date.now();
      const claims: TicketClaims = {
        accountId,
        workspaceId,
        runtimeCellId,
        projectId,
        taskId,
        profile: "default",
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TICKET_TTL_SECONDS * 1000).toISOString(),
      };
      const stored = await redis.set(ticketKey(ticket), JSON.stringify(claims), "EX", TICKET_TTL_SECONDS, "NX");
      if (stored !== "OK") throw new Error("Failed to persist single-use Hermes realtime ticket");
      return reply.code(201).send({ ticket, expiresIn: TICKET_TTL_SECONDS, wsPath: "/api/hermes/ws" });
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get(
    "/api/hermes/ws",
    { websocket: true },
    async (socket, request: FastifyRequest<{ Querystring: { ticket?: string } }>) => {
      let upstream: WebSocket | null = null;
      const pending: Array<{ data: RawData; binary: boolean; bytes: number }> = [];
      let pendingBytes = 0;
      let closed = false;

      const closeBoth = (code: number, reason: string) => {
        if (closed) {
          return;
        }
        closed = true;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(code, reason);
        }
        if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
          upstream.close(code, reason);
        }
      };

      // The client may send session.create in the same turn as the WebSocket
      // open event. Register this listener before any ticket/database/manager
      // await so that the first JSON-RPC frame cannot be lost.
      socket.on("message", (data, binary) => {
        if (closed) {
          return;
        }
        const policyResponse = blockedMethodResponse(data, binary);
        if (policyResponse) {
          if (socket.readyState === WebSocket.OPEN) socket.send(policyResponse);
          return;
        }
        if (upstream?.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary });
          return;
        }
        const bytes = rawDataBytes(data);
        if (pending.length >= MAX_PENDING_FRAMES || pendingBytes + bytes > MAX_PENDING_BYTES) {
          closeBoth(4408, "client_buffer_limit");
          return;
        }
        pending.push({ data, binary, bytes });
        pendingBytes += bytes;
      });
      socket.on("close", () => closeBoth(1000, "client_closed"));
      socket.on("error", () => closeBoth(1011, "client_connection_failed"));

      const ticket = request.query.ticket || "";
      const rawClaims = ticket ? await redis.getdel(ticketKey(ticket)) : null;
      if (!rawClaims) {
        closeBoth(4401, "invalid_or_expired_ticket");
        return;
      }

      let claims: TicketClaims;
      try {
        claims = JSON.parse(rawClaims) as TicketClaims;
        if (Date.parse(claims.expiresAt) <= Date.now()) {
          closeBoth(4401, "expired_ticket");
          return;
        }
        const workspaceId = await validateTicketScope(
          db,
          claims.accountId,
          claims.workspaceId,
          claims.projectId,
          claims.taskId,
        );
        if (workspaceId !== claims.workspaceId) throw new Error("Ticket workspace scope changed");
      } catch {
        closeBoth(4403, "invalid_ticket_scope");
        return;
      }

      let upstreamUrl: string;
      try {
        upstreamUrl = await managerConnection(config, claims);
      } catch (error) {
        app.log.error({ err: error, accountId: claims.accountId }, "Hermes upstream connection acquisition failed");
        closeBoth(1011, "hermes_unavailable");
        return;
      }

      if (closed) {
        return;
      }
      upstream = new WebSocket(upstreamUrl, { maxPayload: 4 * 1024 * 1024 });

      upstream.on("open", () => {
        if (closed) {
          upstream?.close(1000, "client_closed");
          return;
        }
        for (const frame of pending.splice(0)) {
          upstream?.send(frame.data, { binary: frame.binary });
        }
        pendingBytes = 0;
      });

      upstream.on("message", (data, binary) => {
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }
        if (binary) {
          closeBoth(1003, "binary_hermes_frame_not_supported");
          return;
        }
        const sanitized = redactFrame(data.toString());
        if (!sanitized) {
          closeBoth(1007, "invalid_hermes_json_frame");
          return;
        }
        const accepted = mirrors.push({
          accountId: claims.accountId,
          workspaceId: claims.workspaceId,
          runtimeCellId: claims.runtimeCellId,
          projectId: claims.projectId,
          taskId: claims.taskId,
          direction: "upstream_to_client",
          frame: sanitized,
        }, () => {
          if (!closed && socket.readyState === WebSocket.OPEN) {
            socket.send(data, { binary: false });
          }
        });
        if (!accepted) {
          closeBoth(1013, "hermes_mirror_backpressure");
        }
      });

      upstream.on("error", (error) => {
        app.log.error({ err: error, accountId: claims.accountId }, "Hermes upstream WebSocket failed");
        closeBoth(1011, "hermes_connection_failed");
      });
      upstream.on("close", (code) => closeBoth(code >= 1000 && code <= 4999 ? code : 1011, "hermes_closed"));
    },
  );
}

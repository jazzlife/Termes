import type { Db } from "./db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const SESSION_COOKIE = "termes_session";
const SESSION_PREFIX = "termes.account-session.";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 10;

export type AccountPrincipal = {
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
  email: string;
  displayName: string;
  workspaceKey: string;
  workspaceRoot: string;
  canManageSharedOAuth: boolean;
};

type AccountRow = {
  account_id: string;
  workspace_id: string;
  runtime_cell_id: string;
  email: string;
  display_name: string;
  workspace_key: string;
  workspace_root: string;
};

const loginSchema = z.object({
  accountId: z.string().uuid(),
  accessCode: z.string().min(12).max(512),
});

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${sha256(token).toString("hex")}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch {
      continue;
    }
  }
  return cookies;
}

function requestIsSecure(request: FastifyRequest): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return protocol === "https" || request.protocol === "https";
}

function sessionCookie(token: string, request: FastifyRequest, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(requestIsSecure(request) ? ["Secure"] : []),
  ].join("; ");
}

function remoteKey(request: FastifyRequest, accountId: string): string {
  const forwarded = request.headers["x-forwarded-for"];
  const address = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim()
    || request.ip;
  return `termes.login-attempt.${sha256(`${address}:${accountId}`).toString("hex")}`;
}

export function parseAccountAccessHashes(raw: string): Map<string, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TERMES_ACCOUNT_ACCESS_HASHES_JSON must be valid JSON");
  }
  const record = z.record(z.string().uuid(), z.string().regex(/^[a-fA-F0-9]{64}$/)).parse(parsed);
  const entries = Object.entries(record);
  if (entries.length === 0) throw new Error("At least one Termes account access hash is required");
  return new Map(entries.map(([accountId, digest]) => [accountId, Buffer.from(digest, "hex")]));
}

async function activeAccount(db: Db, accountId: string): Promise<AccountPrincipal | null> {
  const result = await db.pool.query<AccountRow>(
    `
      select
        u.id as account_id,
        aw.id as workspace_id,
        rc.id as runtime_cell_id,
        u.email,
        u.display_name,
        aw.key as workspace_key,
        aw.root_path as workspace_root
      from users u
      join account_workspaces aw on aw.account_id = u.id and aw.status = 'active'
      join runtime_cells rc on rc.account_id = u.id and rc.workspace_id = aw.id and rc.status = 'active'
      where u.id = $1
      order by aw.created_at asc
      limit 1
    `,
    [accountId],
  );
  const row = result.rows[0];
  return row ? {
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    runtimeCellId: row.runtime_cell_id,
    email: row.email,
    displayName: row.display_name,
    workspaceKey: row.workspace_key,
    workspaceRoot: row.workspace_root,
    canManageSharedOAuth: false,
  } : null;
}

async function activeRuntimeCell(
  db: Db,
  accountId: string,
  workspaceId: string,
  runtimeCellId: string,
): Promise<AccountPrincipal | null> {
  const result = await db.pool.query<AccountRow>(
    `
      select
        u.id as account_id,
        aw.id as workspace_id,
        rc.id as runtime_cell_id,
        u.email,
        u.display_name,
        aw.key as workspace_key,
        aw.root_path as workspace_root
      from users u
      join account_workspaces aw on aw.account_id = u.id and aw.status = 'active'
      join runtime_cells rc on rc.account_id = u.id and rc.workspace_id = aw.id and rc.status = 'active'
      where u.id = $1 and aw.id = $2 and rc.id = $3
      limit 1
    `,
    [accountId, workspaceId, runtimeCellId],
  );
  const row = result.rows[0];
  return row ? {
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    runtimeCellId: row.runtime_cell_id,
    email: row.email,
    displayName: row.display_name,
    workspaceKey: row.workspace_key,
    workspaceRoot: row.workspace_root,
    canManageSharedOAuth: false,
  } : null;
}

export function createAccountAuth(dependencies: {
  db: Db;
  redis: Redis;
  accessHashes: Map<string, Buffer>;
  oauthAdminAccountId: string;
}) {
  const { db, redis, accessHashes, oauthAdminAccountId } = dependencies;

  function authorizePrincipal(principal: AccountPrincipal): AccountPrincipal {
    return {
      ...principal,
      canManageSharedOAuth: principal.accountId === oauthAdminAccountId,
    };
  }

  async function authenticate(request: FastifyRequest): Promise<AccountPrincipal | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length < 32 || token.length > 256) return null;
    const raw = await redis.get(sessionKey(token));
    if (!raw) return null;
    let accountId: string;
    try {
      const parsed = z.object({ accountId: z.string().uuid() }).parse(JSON.parse(raw));
      accountId = parsed.accountId;
    } catch {
      await redis.del(sessionKey(token));
      return null;
    }
    const principal = await activeAccount(db, accountId);
    if (!principal || !accessHashes.has(accountId)) {
      await redis.del(sessionKey(token));
      return null;
    }
    await redis.expire(sessionKey(token), SESSION_TTL_SECONDS);
    return authorizePrincipal(principal);
  }

  async function authenticateServicePrincipal(input: {
    accountId: string;
    workspaceId: string;
    runtimeCellId: string;
  }): Promise<AccountPrincipal | null> {
    if (!accessHashes.has(input.accountId)) return null;
    const principal = await activeRuntimeCell(
      db,
      input.accountId,
      input.workspaceId,
      input.runtimeCellId,
    );
    return principal ? authorizePrincipal(principal) : null;
  }

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    app.get("/api/account-auth/accounts", async () => {
      const ids = [...accessHashes.keys()];
      const result = await db.pool.query<{
        account_id: string;
        display_name: string;
        workspace_key: string;
      }>(
        `
          select u.id as account_id, u.display_name, aw.key as workspace_key
          from users u
          join account_workspaces aw on aw.account_id = u.id and aw.status = 'active'
          join runtime_cells rc on rc.account_id = u.id and rc.workspace_id = aw.id and rc.status = 'active'
          where u.id = any($1::uuid[])
          order by case when u.id = $2 then 0 else 1 end, u.display_name asc
        `,
        [ids, oauthAdminAccountId],
      );
      return {
        accounts: result.rows.map((row) => ({
          accountId: row.account_id,
          displayName: row.display_name,
          workspaceKey: row.workspace_key,
        })),
      };
    });

    app.post("/api/account-auth/login", async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const attemptsKey = remoteKey(request, input.accountId);
      const attempts = await redis.incr(attemptsKey);
      if (attempts === 1) await redis.expire(attemptsKey, LOGIN_WINDOW_SECONDS);
      if (attempts > LOGIN_ATTEMPT_LIMIT) {
        return reply.code(429).send({ error: "Too many login attempts" });
      }
      const expected = accessHashes.get(input.accountId);
      const presented = sha256(input.accessCode);
      if (!expected || expected.byteLength !== presented.byteLength || !timingSafeEqual(expected, presented)) {
        return reply.code(401).send({ error: "Invalid account or access code" });
      }
      const principal = await activeAccount(db, input.accountId);
      if (!principal) return reply.code(403).send({ error: "Account runtime cell is not active" });
      const token = randomBytes(32).toString("base64url");
      await redis.set(
        sessionKey(token),
        JSON.stringify({ accountId: principal.accountId, createdAt: new Date().toISOString() }),
        "EX",
        SESSION_TTL_SECONDS,
      );
      await redis.del(attemptsKey);
      reply.header("set-cookie", sessionCookie(token, request, SESSION_TTL_SECONDS));
      return { principal: authorizePrincipal(principal), expiresIn: SESSION_TTL_SECONDS };
    });

    app.get("/api/account-auth/session", async (request, reply) => {
      const principal = await authenticate(request);
      return { principal };
    });

    app.delete("/api/account-auth/session", async (request, reply) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) await redis.del(sessionKey(token));
      reply.header("set-cookie", sessionCookie("", request, 0));
      return reply.code(204).send();
    });
  }

  return { authenticate, authenticateServicePrincipal, registerRoutes };
}

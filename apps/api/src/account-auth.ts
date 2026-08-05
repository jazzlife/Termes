import type { Db } from "./db";
import { hashMemberPassword, verifyMemberPassword } from "./member-password";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";

const SESSION_COOKIE = "termes_session";
const SESSION_PREFIX = "termes.account-session.";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_IP_ATTEMPT_LIMIT = 50;
const PASSWORD_CHANGE_ATTEMPT_LIMIT = 6;
const PASSWORD_KDF_CONCURRENCY_LIMIT = 8;
const REGISTER_WINDOW_SECONDS = 60 * 60;
const REGISTER_ATTEMPT_LIMIT = 5;
const INVALID_LOGIN_ERROR = "아이디 또는 비밀번호가 올바르지 않습니다.";
const DUMMY_PASSWORD_HASH = hashMemberPassword("termes-invalid-login-dummy");

export type AccountPrincipal = {
  memberId: string;
  accountId: string;
  workspaceId: string;
  runtimeCellId: string;
  email: string;
  displayName: string;
  workspaceKey: string;
  workspaceRoot: string;
  canManageSharedOAuth: boolean;
  canApproveMembers: boolean;
};

type AccountRow = {
  member_id: string;
  account_id: string;
  workspace_id: string;
  runtime_cell_id: string;
  email: string;
  display_name: string;
  workspace_key: string;
  workspace_root: string;
  login_id: string;
  auth_session_version: string | number;
  is_account_owner: boolean;
  password_hash: string | null;
};

export type PendingMember = {
  memberId: string;
  loginId: string;
  email: string;
  displayName: string;
  createdAt: string;
};

export const MEMBER_SESSION_REVOKED_CHANNEL = "termes.member-session-revoked";

const loginSchema = z.object({
  loginId: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
});

const registerSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  loginId: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  email: z.string().trim().email().max(254),
  password: z.string().min(4).max(512),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(4).max(512),
}).refine((input) => input.currentPassword !== input.newPassword, {
  message: "새 비밀번호는 현재 비밀번호와 달라야 합니다.",
  path: ["newPassword"],
});

const approveMemberParamsSchema = z.object({ memberId: z.string().uuid() });

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

function normalizeLoginId(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function remoteKey(request: FastifyRequest, action: string, identity = ""): string {
  return `termes.${action}-attempt.${sha256(`${request.ip}:${normalizeLoginId(identity)}`).toString("hex")}`;
}

function identityAttemptKey(action: string, identity: string): string {
  return `termes.${action}-attempt.${sha256(normalizeLoginId(identity)).toString("hex")}`;
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

function principalFromRow(row: AccountRow): AccountPrincipal {
  return {
    memberId: row.member_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    runtimeCellId: row.runtime_cell_id,
    email: row.email,
    displayName: row.display_name,
    workspaceKey: row.workspace_key,
    workspaceRoot: row.workspace_root,
    canManageSharedOAuth: false,
    canApproveMembers: false,
  };
}

const ACTIVE_MEMBER_SELECT = `
  select
    m.id as member_id,
    m.account_id,
    aw.id as workspace_id,
    rc.id as runtime_cell_id,
    m.email,
    m.display_name,
    aw.key as workspace_key,
    aw.root_path as workspace_root,
    m.login_id,
    m.auth_session_version,
    m.is_account_owner,
    c.password_hash
  from account_members m
  join users u on u.id = m.account_id
  join account_workspaces aw on aw.account_id = u.id and aw.status = 'active'
  join runtime_cells rc on rc.account_id = u.id and rc.workspace_id = aw.id and rc.status = 'active'
  left join account_member_credentials c on c.member_id = m.id
  where m.status = 'approved'
`;

async function activeMember(db: Db, memberId: string): Promise<AccountRow | null> {
  const result = await db.pool.query<AccountRow>(
    `${ACTIVE_MEMBER_SELECT} and m.id = $1 order by aw.created_at asc limit 1`,
    [memberId],
  );
  return result.rows[0] ?? null;
}

async function activeMemberByLoginId(db: Db, loginId: string): Promise<AccountRow | null> {
  const result = await db.pool.query<AccountRow>(
    `${ACTIVE_MEMBER_SELECT} and lower(btrim(m.login_id)) = $1 order by aw.created_at asc limit 1`,
    [normalizeLoginId(loginId)],
  );
  return result.rows[0] ?? null;
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
        u.id as member_id,
        u.id as account_id,
        aw.id as workspace_id,
        rc.id as runtime_cell_id,
        u.email,
        u.display_name,
        aw.key as workspace_key,
        aw.root_path as workspace_root,
        u.login_id,
        0 as auth_session_version,
        true as is_account_owner,
        null::text as password_hash
      from users u
      join account_workspaces aw on aw.account_id = u.id and aw.status = 'active'
      join runtime_cells rc on rc.account_id = u.id and rc.workspace_id = aw.id and rc.status = 'active'
      where u.id = $1 and aw.id = $2 and rc.id = $3
      limit 1
    `,
    [accountId, workspaceId, runtimeCellId],
  );
  const row = result.rows[0];
  return row ? principalFromRow(row) : null;
}

async function withTransaction<T>(db: Db, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export function createAccountAuth(dependencies: {
  db: Db;
  redis: Redis;
  accessHashes: Map<string, Buffer>;
  oauthAdminAccountId: string;
}) {
  const { db, redis, accessHashes, oauthAdminAccountId } = dependencies;
  let activePasswordKdfs = 0;

  async function tryPasswordKdf<T>(work: () => Promise<T>): Promise<{ accepted: true; value: T } | { accepted: false }> {
    if (activePasswordKdfs >= PASSWORD_KDF_CONCURRENCY_LIMIT) return { accepted: false };
    activePasswordKdfs += 1;
    try {
      return { accepted: true, value: await work() };
    } finally {
      activePasswordKdfs -= 1;
    }
  }

  async function incrementAttempt(key: string, windowSeconds: number): Promise<number> {
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, windowSeconds);
    return attempts;
  }

  function authorizePrincipal(principal: AccountPrincipal): AccountPrincipal {
    const isAdminOwner = principal.memberId === principal.accountId && principal.accountId === oauthAdminAccountId;
    return {
      ...principal,
      canManageSharedOAuth: isAdminOwner,
      canApproveMembers: isAdminOwner,
    };
  }

  async function authenticate(request: FastifyRequest): Promise<AccountPrincipal | null> {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length < 32 || token.length > 256) return null;
    const key = sessionKey(token);
    const raw = await redis.get(key);
    if (!raw) return null;
    let session: { memberId: string; accountId: string; authSessionVersion: number };
    try {
      const parsed = z.object({
        memberId: z.string().uuid().optional(),
        accountId: z.string().uuid(),
        authSessionVersion: z.number().int().nonnegative().optional(),
      }).parse(JSON.parse(raw));
      session = {
        memberId: parsed.memberId ?? parsed.accountId,
        accountId: parsed.accountId,
        authSessionVersion: parsed.authSessionVersion ?? 0,
      };
    } catch {
      await redis.del(key);
      return null;
    }
    const row = await activeMember(db, session.memberId);
    if (
      !row
      || row.account_id !== session.accountId
      || Number(row.auth_session_version) !== session.authSessionVersion
      || !accessHashes.has(row.account_id)
    ) {
      await redis.del(key);
      return null;
    }
    await redis.expire(key, SESSION_TTL_SECONDS);
    return authorizePrincipal(principalFromRow(row));
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

  async function currentPasswordMatches(
    row: Pick<AccountRow, "password_hash" | "is_account_owner" | "member_id" | "account_id">,
    password: string,
  ): Promise<boolean> {
    if (row.password_hash) return verifyMemberPassword(password, row.password_hash);
    if (!row.is_account_owner || row.member_id !== row.account_id) return false;
    const expected = accessHashes.get(row.account_id);
    const presented = sha256(password);
    return Boolean(expected && expected.byteLength === presented.byteLength && timingSafeEqual(expected, presented));
  }

  async function loginPasswordMatches(row: AccountRow | null, password: string): Promise<boolean> {
    if (!row) {
      await verifyMemberPassword(password, await DUMMY_PASSWORD_HASH);
      return false;
    }
    if (row.password_hash) return currentPasswordMatches(row, password);
    const [matches] = await Promise.all([
      currentPasswordMatches(row, password),
      verifyMemberPassword(password, await DUMMY_PASSWORD_HASH),
    ]);
    return matches;
  }

  async function registerRoutes(app: FastifyInstance): Promise<void> {
    app.post("/api/account-auth/register", async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "가입 정보를 확인해 주세요." });
      }
      const attemptsKey = remoteKey(request, "register");
      const attempts = await incrementAttempt(attemptsKey, REGISTER_WINDOW_SECONDS);
      if (attempts > REGISTER_ATTEMPT_LIMIT) {
        return reply.code(429).send({ error: "가입 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
      }
      const input = parsed.data;
      const passwordHashResult = await tryPasswordKdf(() => hashMemberPassword(input.password));
      if (!passwordHashResult.accepted) {
        return reply.code(429).send({ error: "인증 요청이 많습니다. 잠시 후 다시 시도해 주세요." });
      }
      const passwordHash = passwordHashResult.value;
      try {
        await withTransaction(db, async (client) => {
          const member = await client.query<{ id: string }>(
            `
              insert into account_members (account_id, login_id, email, display_name, status)
              values ($1, $2, $3, $4, 'pending')
              returning id
            `,
            [oauthAdminAccountId, normalizeLoginId(input.loginId), normalizeEmail(input.email), input.displayName],
          );
          await client.query(
            `insert into account_member_credentials (member_id, password_hash) values ($1, $2)`,
            [member.rows[0]!.id, passwordHash],
          );
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: "아이디 또는 이메일을 사용할 수 없습니다." });
        }
        throw error;
      }
      return reply.code(201).send({ status: "pending" });
    });

    app.post("/api/account-auth/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(401).send({ error: INVALID_LOGIN_ERROR });
      }
      const input = parsed.data;
      const loginId = normalizeLoginId(input.loginId);
      const attemptsKey = remoteKey(request, "login", loginId);
      const ipAttemptsKey = remoteKey(request, "login-ip");
      const [attempts, ipAttempts] = await Promise.all([
        incrementAttempt(attemptsKey, LOGIN_WINDOW_SECONDS),
        incrementAttempt(ipAttemptsKey, LOGIN_WINDOW_SECONDS),
      ]);
      if (attempts > LOGIN_ATTEMPT_LIMIT || ipAttempts > LOGIN_IP_ATTEMPT_LIMIT) {
        return reply.code(429).send({ error: "Too many login attempts" });
      }
      const row = await activeMemberByLoginId(db, loginId);
      const passwordCheck = await tryPasswordKdf(() => loginPasswordMatches(row, input.password));
      if (!passwordCheck.accepted) return reply.code(429).send({ error: "Too many login attempts" });
      const passwordMatches = passwordCheck.value;
      if (!row || !passwordMatches || !accessHashes.has(row.account_id)) {
        return reply.code(401).send({ error: INVALID_LOGIN_ERROR });
      }
      const principal = principalFromRow(row);
      const token = randomBytes(32).toString("base64url");
      await redis.set(
        sessionKey(token),
        JSON.stringify({
          memberId: principal.memberId,
          accountId: principal.accountId,
          authSessionVersion: Number(row.auth_session_version),
          createdAt: new Date().toISOString(),
        }),
        "EX",
        SESSION_TTL_SECONDS,
      );
      await redis.del(attemptsKey);
      reply.header("set-cookie", sessionCookie(token, request, SESSION_TTL_SECONDS));
      return { principal: authorizePrincipal(principal), expiresIn: SESSION_TTL_SECONDS };
    });

    app.get("/api/account-auth/session", async (request) => {
      const principal = await authenticate(request);
      return { principal };
    });

    app.delete("/api/account-auth/session", async (request, reply) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) await redis.del(sessionKey(token));
      reply.header("set-cookie", sessionCookie("", request, 0));
      return reply.code(204).send();
    });

    app.patch("/api/account-auth/password", async (request, reply) => {
      const principal = await authenticate(request);
      if (!principal) return reply.code(401).send({ error: "Authentication required" });
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "비밀번호를 확인해 주세요." });
      }
      const [ipAttempts, memberAttempts] = await Promise.all([
        incrementAttempt(remoteKey(request, "password-change-ip"), LOGIN_WINDOW_SECONDS),
        incrementAttempt(identityAttemptKey("password-change-member", principal.memberId), LOGIN_WINDOW_SECONDS),
      ]);
      if (ipAttempts > PASSWORD_CHANGE_ATTEMPT_LIMIT || memberAttempts > PASSWORD_CHANGE_ATTEMPT_LIMIT) {
        return reply.code(429).send({ error: "비밀번호 변경 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." });
      }
      const snapshot = await activeMember(db, principal.memberId);
      if (!snapshot) return reply.code(401).send({ error: "Authentication required" });
      const passwordPreparation = await tryPasswordKdf(async () => {
        if (!await currentPasswordMatches(snapshot, parsed.data.currentPassword)) return null;
        return hashMemberPassword(parsed.data.newPassword);
      });
      if (!passwordPreparation.accepted) {
        return reply.code(429).send({ error: "인증 요청이 많습니다. 잠시 후 다시 시도해 주세요." });
      }
      if (!passwordPreparation.value) {
        return reply.code(401).send({ error: "현재 비밀번호가 올바르지 않습니다." });
      }
      const changed = await withTransaction(db, async (client) => {
        const member = await client.query<Pick<AccountRow, "member_id" | "account_id" | "auth_session_version">>(
          `
            select id as member_id, account_id, auth_session_version
            from account_members
            where id = $1 and status = 'approved'
            for update
          `,
          [principal.memberId],
        );
        const lockedMember = member.rows[0];
        if (!lockedMember) return false;
        const credential = await client.query<{ password_hash: string | null }>(
          `select password_hash from account_member_credentials where member_id = $1`,
          [principal.memberId],
        );
        if (
          lockedMember.account_id !== snapshot.account_id
          || Number(lockedMember.auth_session_version) !== Number(snapshot.auth_session_version)
          || (credential.rows[0]?.password_hash ?? null) !== snapshot.password_hash
        ) return false;
        await client.query(
          `
            insert into account_member_credentials (member_id, password_hash, password_changed_at)
            values ($1, $2, now())
            on conflict (member_id) do update
              set password_hash = excluded.password_hash,
                  password_changed_at = excluded.password_changed_at
          `,
          [principal.memberId, passwordPreparation.value],
        );
        await client.query(
          `update account_members set auth_session_version = auth_session_version + 1, updated_at = now() where id = $1`,
          [principal.memberId],
        );
        return true;
      });
      if (!changed) {
        return reply.code(409).send({ error: "비밀번호가 이미 변경되었습니다. 다시 로그인해 주세요." });
      }
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token) await redis.del(sessionKey(token));
      const publisher = redis as Redis & { publish?: (channel: string, message: string) => Promise<number> };
      if (publisher.publish) await publisher.publish(MEMBER_SESSION_REVOKED_CHANNEL, principal.memberId);
      reply.header("set-cookie", sessionCookie("", request, 0));
      return reply.code(204).send();
    });

    app.get("/api/account-auth/members/pending", async (request, reply) => {
      const principal = await authenticate(request);
      if (!principal) return reply.code(401).send({ error: "Authentication required" });
      if (!principal.canApproveMembers) return reply.code(403).send({ error: "Forbidden" });
      const result = await db.pool.query<{
        id: string;
        login_id: string;
        email: string;
        display_name: string;
        created_at: Date | string;
      }>(
        `
          select id, login_id, email, display_name, created_at
          from account_members
          where status = 'pending' and account_id = $1
          order by created_at asc, id asc
        `,
        [principal.accountId],
      );
      const members: PendingMember[] = result.rows.map((member) => ({
        memberId: member.id,
        loginId: member.login_id,
        email: member.email,
        displayName: member.display_name,
        createdAt: new Date(member.created_at).toISOString(),
      }));
      return { members };
    });

    app.post("/api/account-auth/members/:memberId/approve", async (request, reply) => {
      const principal = await authenticate(request);
      if (!principal) return reply.code(401).send({ error: "Authentication required" });
      if (!principal.canApproveMembers) return reply.code(403).send({ error: "Forbidden" });
      const parsed = approveMemberParamsSchema.safeParse(request.params);
      if (!parsed.success) return reply.code(404).send({ error: "Member not found" });
      const result = await db.pool.query<{ id: string }>(
        `
          update account_members
          set status = 'approved',
              approved_at = now(),
              approved_by = $1,
              updated_at = now()
          where id = $2 and account_id = $3 and status = 'pending'
          returning id
        `,
        [principal.memberId, parsed.data.memberId, principal.accountId],
      );
      if (!result.rows[0]) return reply.code(404).send({ error: "Member not found" });
      return reply.code(204).send();
    });
  }

  return { authenticate, authenticateServicePrincipal, registerRoutes };
}

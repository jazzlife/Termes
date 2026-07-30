import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import { createAccountAuth, parseAccountAccessHashes } from "../../apps/api/src/account-auth.ts";

const accountA = "00000000-0000-0000-0000-000000000001";
const accountB = "00000000-0000-0000-0000-000000000002";
const accessCodeA = "short";
const accessCodeB = "account-b-test-access-code";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryRedis {
  private readonly values = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.values.delete(key) || this.counters.delete(key);
    return existed ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async publish(): Promise<number> {
    return 0;
  }
}

function accountRow(accountId: string) {
  const suffix = accountId === accountA ? "a" : "b";
  return {
    member_id: accountId,
    account_id: accountId,
    workspace_id: accountId === accountA
      ? "10000000-0000-0000-0000-000000000001"
      : "10000000-0000-0000-0000-000000000002",
    runtime_cell_id: accountId === accountA
      ? "20000000-0000-0000-0000-000000000001"
      : "20000000-0000-0000-0000-000000000002",
    email: `${suffix}@termes.local`,
    login_id: accountId === accountA ? "master" : "cell-b",
    display_name: `Account ${suffix.toUpperCase()}`,
    workspace_key: `account-${suffix}`,
    workspace_root: `/workspaces/${accountId}`,
    auth_session_version: 0,
    is_account_owner: true,
    password_hash: null,
  };
}

function fakeDb() {
  const members = new Map<string, {
    id: string;
    accountId: string | null;
    loginId: string;
    email: string;
    displayName: string;
    status: "pending" | "approved";
    isAccountOwner: boolean;
    authSessionVersion: number;
    createdAt: Date;
  }>([
    [accountA, { id: accountA, accountId: accountA, loginId: "master", email: "a@termes.local", displayName: "Account A", status: "approved", isAccountOwner: true, authSessionVersion: 0, createdAt: new Date("2026-01-01T00:00:00Z") }],
    [accountB, { id: accountB, accountId: accountB, loginId: "cell-b", email: "b@termes.local", displayName: "Account B", status: "approved", isAccountOwner: true, authSessionVersion: 0, createdAt: new Date("2026-01-02T00:00:00Z") }],
  ]);
  const credentials = new Map<string, string>();
  let nextMember = 3;

  const memberRow = (member: (typeof members extends Map<string, infer T> ? T : never)) => {
    if (!member.accountId) return null;
    return {
      ...accountRow(member.accountId),
      member_id: member.id,
      login_id: member.loginId,
      email: member.email,
      display_name: member.displayName,
      auth_session_version: member.authSessionVersion,
      is_account_owner: member.isAccountOwner,
      password_hash: credentials.get(member.id) ?? null,
    };
  };

  async function query(sql: string, params: unknown[] = []) {
    if (/^\s*(begin|commit|rollback)\s*$/i.test(sql)) return { rows: [] };
    if (/select id as member_id, account_id, auth_session_version/i.test(sql)) {
      const member = members.get(String(params[0]));
      return {
        rows: member?.status === "approved"
          ? [{ member_id: member.id, account_id: member.accountId, auth_session_version: member.authSessionVersion }]
          : [],
      };
    }
    if (/select password_hash from account_member_credentials/i.test(sql)) {
      const passwordHash = credentials.get(String(params[0]));
      return { rows: passwordHash ? [{ password_hash: passwordHash }] : [] };
    }
    if (/insert into account_members/i.test(sql)) {
      const accountId = String(params[0]);
      const loginId = String(params[1]).toLowerCase();
      const email = String(params[2]).toLowerCase();
      if ([...members.values()].some((member) => member.loginId === loginId || member.email === email)) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const id = `00000000-0000-0000-0000-${String(nextMember).padStart(12, "0")}`;
      nextMember += 1;
      members.set(id, { id, accountId, loginId, email, displayName: String(params[3]), status: "pending", isAccountOwner: false, authSessionVersion: 0, createdAt: new Date("2026-02-01T00:00:00Z") });
      return { rows: [{ id }] };
    }
    if (/insert into account_member_credentials/i.test(sql)) {
      credentials.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    if (/set auth_session_version = auth_session_version \+ 1/i.test(sql)) {
      const member = members.get(String(params[0]));
      if (member) member.authSessionVersion += 1;
      return { rows: [] };
    }
    if (/where status = 'pending'/i.test(sql) && /select id, login_id/i.test(sql)) {
      return {
        rows: [...members.values()].filter((member) => member.status === "pending" && member.accountId === String(params[0])).map((member) => ({
          id: member.id,
          login_id: member.loginId,
          email: member.email,
          display_name: member.displayName,
          created_at: member.createdAt,
        })),
      };
    }
    if (/update account_members\s+set status = 'approved'/i.test(sql)) {
      const member = members.get(String(params[1]));
      if (!member || member.status !== "pending" || member.accountId !== String(params[2])) return { rows: [] };
      member.status = "approved";
      return { rows: [{ id: member.id }] };
    }
    if (/lower\(btrim\(m\.login_id\)\) = \$1/i.test(sql)) {
      const loginId = String(params[0]).toLowerCase();
      const member = [...members.values()].find((candidate) => candidate.loginId === loginId && candidate.status === "approved");
      const row = member ? memberRow(member) : null;
      return { rows: row ? [row] : [] };
    }
    if (/m\.id = \$1/i.test(sql)) {
      const member = members.get(String(params[0]));
      const row = member?.status === "approved" ? memberRow(member) : null;
      return { rows: row ? [row] : [] };
    }
    const accountId = String(params[0]);
    const row = accountId === accountA || accountId === accountB ? accountRow(accountId) : null;
    if (/aw\.id = \$2 and rc\.id = \$3/i.test(sql)) {
      return {
        rows: row
          && String(params[1]) === row.workspace_id
          && String(params[2]) === row.runtime_cell_id
          ? [row]
          : [],
      };
    }
    return { rows: row ? [row] : [] };
  }

  return {
    pool: {
      query,
      async connect() {
        return { query, release() {} };
      },
    },
    async close() {},
  };
}

function accessHashes() {
  return parseAccountAccessHashes(JSON.stringify({
    [accountA]: digest(accessCodeA),
    [accountB]: digest(accessCodeB),
  }));
}

test("계정 접근 hash 설정은 UUID와 SHA-256만 허용한다", () => {
  assert.equal(accessHashes().size, 2);
  assert.throws(() => parseAccountAccessHashes("{}"), /At least one/);
  assert.throws(() => parseAccountAccessHashes(JSON.stringify({ [accountA]: "plain-text" })));
});

test("회원 로그인은 아이디를 정규화하고 HttpOnly 세션을 발급한 뒤 활성 Workspace로 재인증한다", async () => {
  const app = Fastify();
  const auth = createAccountAuth({
    db: fakeDb() as never,
    redis: new MemoryRedis() as never,
    accessHashes: accessHashes(),
    oauthAdminAccountId: accountA,
  });
  await auth.registerRoutes(app);

  const accounts = await app.inject({ method: "GET", url: "/api/account-auth/accounts" });
  assert.equal(accounts.statusCode, 404);

  const denied = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "master", password: "incorrect-password" },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().error, "아이디 또는 비밀번호가 올바르지 않습니다.");

  const unknown = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "unknown", password: "incorrect-password" },
  });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json().error, denied.json().error);

  const malformed = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "", password: "x" },
  });
  assert.equal(malformed.statusCode, 401);
  assert.deepEqual(malformed.json(), denied.json());

  const legacyEmailPayload = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { email: "a@termes.local", password: accessCodeA },
  });
  assert.equal(legacyEmailPayload.statusCode, 401);
  assert.deepEqual(legacyEmailPayload.json(), denied.json());

  const login = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: " MASTER ", password: accessCodeA },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().principal.accountId, accountA);
  assert.equal(login.json().principal.canManageSharedOAuth, true);
  assert.equal(login.json().principal.canApproveMembers, true);
  const cookie = String(login.headers["set-cookie"]);
  assert.match(cookie, /termes_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const session = await app.inject({ method: "GET", url: "/api/account-auth/session", headers: { cookie } });
  assert.equal(session.statusCode, 200);
  assert.equal(session.json().principal.workspaceKey, "account-a");

  const logout = await app.inject({ method: "DELETE", url: "/api/account-auth/session", headers: { cookie } });
  assert.equal(logout.statusCode, 204);
  const expired = await app.inject({ method: "GET", url: "/api/account-auth/session", headers: { cookie } });
  assert.equal(expired.statusCode, 200);
  assert.equal(expired.json().principal, null);
  await app.close();
});

test("회원가입은 승인 대기로 생성되고 관리자 승인 후 로그인과 비밀번호 변경이 가능하다", async () => {
  const app = Fastify();
  const auth = createAccountAuth({
    db: fakeDb() as never,
    redis: new MemoryRedis() as never,
    accessHashes: accessHashes(),
    oauthAdminAccountId: accountA,
  });
  await auth.registerRoutes(app);
  const originalPassword = "registered-member-password";
  const changedPassword = "changed-member-password";

  const registered = await app.inject({
    method: "POST",
    url: "/api/account-auth/register",
    payload: { displayName: "New Member", loginId: " NEW-MEMBER ", email: " NEW@EXAMPLE.COM ", password: originalPassword },
  });
  assert.equal(registered.statusCode, 201);
  assert.deepEqual(registered.json(), { status: "pending" });

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/account-auth/register",
    payload: { displayName: "Duplicate", loginId: "new-member", email: "other@example.com", password: originalPassword },
  });
  assert.equal(duplicate.statusCode, 409);

  const pendingLogin = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "new-member", password: originalPassword },
  });
  assert.equal(pendingLogin.statusCode, 401);

  const adminLogin = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "master", password: accessCodeA },
  });
  assert.equal(adminLogin.statusCode, 200);
  const adminCookie = String(adminLogin.headers["set-cookie"]);
  const pending = await app.inject({ method: "GET", url: "/api/account-auth/members/pending", headers: { cookie: adminCookie } });
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().members.length, 1);
  assert.equal(pending.json().members[0].loginId, "new-member");
  assert.equal(pending.json().members[0].email, "new@example.com");

  const memberId = String(pending.json().members[0].memberId);
  const approved = await app.inject({ method: "POST", url: `/api/account-auth/members/${memberId}/approve`, headers: { cookie: adminCookie } });
  assert.equal(approved.statusCode, 204);

  const memberLogin = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "NEW-MEMBER", password: originalPassword },
  });
  assert.equal(memberLogin.statusCode, 200);
  assert.equal(memberLogin.json().principal.accountId, accountA);
  assert.equal(memberLogin.json().principal.memberId, memberId);
  assert.equal(memberLogin.json().principal.canApproveMembers, false);
  const memberCookie = String(memberLogin.headers["set-cookie"]);

  const forbidden = await app.inject({ method: "GET", url: "/api/account-auth/members/pending", headers: { cookie: memberCookie } });
  assert.equal(forbidden.statusCode, 403);

  const changed = await app.inject({
    method: "PATCH",
    url: "/api/account-auth/password",
    headers: { cookie: memberCookie },
    payload: { currentPassword: originalPassword, newPassword: changedPassword },
  });
  assert.equal(changed.statusCode, 204);
  const expired = await app.inject({ method: "GET", url: "/api/account-auth/session", headers: { cookie: memberCookie } });
  assert.equal(expired.json().principal, null);

  const oldPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "new-member", password: originalPassword },
  });
  assert.equal(oldPasswordLogin.statusCode, 401);
  const changedPasswordLogin = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { loginId: "new-member", password: changedPassword },
  });
  assert.equal(changedPasswordLogin.statusCode, 200);
  await app.close();
});

test("동일 IP와 정규화된 회원 아이디의 반복 로그인 실패는 15분 창에서 차단한다", async () => {
  const app = Fastify();
  const auth = createAccountAuth({
    db: fakeDb() as never,
    redis: new MemoryRedis() as never,
    accessHashes: accessHashes(),
    oauthAdminAccountId: accountA,
  });
  await auth.registerRoutes(app);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": `198.51.100.${attempt}` },
      payload: { loginId: attempt % 2 === 0 ? "CELL-B" : "cell-b", password: "incorrect-password" },
    });
    assert.equal(response.statusCode, 401);
  }
  const blocked = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    remoteAddress: "203.0.113.9",
    headers: { "x-forwarded-for": "198.51.100.250" },
    payload: { loginId: "cell-b", password: accessCodeB },
  });
  assert.equal(blocked.statusCode, 429);
  await app.close();
});

test("동일 IP에서 아이디를 바꿔도 전역 로그인 제한을 우회할 수 없다", async () => {
  const app = Fastify();
  const auth = createAccountAuth({
    db: fakeDb() as never,
    redis: new MemoryRedis() as never,
    accessHashes: accessHashes(),
    oauthAdminAccountId: accountA,
  });
  await auth.registerRoutes(app);
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      remoteAddress: "203.0.113.10",
      payload: { loginId: `unknown-${attempt}`, password: "incorrect-password" },
    });
    assert.equal(response.statusCode, 401);
  }
  const blocked = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    remoteAddress: "203.0.113.10",
    payload: { loginId: "another-unknown", password: "incorrect-password" },
  });
  assert.equal(blocked.statusCode, 429);
  await app.close();
});

test("내부 서비스 주체는 Account, Workspace, Runtime Cell의 정확한 조합만 허용한다", async () => {
  const auth = createAccountAuth({
    db: fakeDb() as never,
    redis: new MemoryRedis() as never,
    accessHashes: accessHashes(),
    oauthAdminAccountId: accountA,
  });
  const row = accountRow(accountA);
  const principal = await auth.authenticateServicePrincipal({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    runtimeCellId: row.runtime_cell_id,
  });
  assert.equal(principal?.accountId, accountA);
  assert.equal(principal?.workspaceId, row.workspace_id);

  const denied = await auth.authenticateServicePrincipal({
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    runtimeCellId: "20000000-0000-0000-0000-000000000099",
  });
  assert.equal(denied, null);
});

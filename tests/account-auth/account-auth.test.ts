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
}

function accountRow(accountId: string) {
  const suffix = accountId === accountA ? "a" : "b";
  return {
    account_id: accountId,
    workspace_id: accountId === accountA
      ? "10000000-0000-0000-0000-000000000001"
      : "10000000-0000-0000-0000-000000000002",
    runtime_cell_id: accountId === accountA
      ? "20000000-0000-0000-0000-000000000001"
      : "20000000-0000-0000-0000-000000000002",
    email: `${suffix}@termes.local`,
    display_name: `Account ${suffix.toUpperCase()}`,
    workspace_key: `account-${suffix}`,
    workspace_root: `/workspaces/${accountId}`,
  };
}

function fakeDb() {
  return {
    pool: {
      async query(sql: string, params: unknown[]) {
        if (/where lower\(u\.email\) = \$1/i.test(sql)) {
          const email = String(params[0]).toLowerCase();
          const row = [accountRow(accountA), accountRow(accountB)].find((candidate) => candidate.email === email);
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

test("회원 로그인은 이메일을 정규화하고 HttpOnly 세션을 발급한 뒤 활성 Workspace로 재인증한다", async () => {
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
    payload: { email: "a@termes.local", password: "incorrect-password" },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.json().error, "이메일 또는 비밀번호가 올바르지 않습니다.");

  const unknown = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { email: "unknown@termes.local", password: "incorrect-password" },
  });
  assert.equal(unknown.statusCode, 401);
  assert.equal(unknown.json().error, denied.json().error);

  const malformed = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { email: "not-an-email", password: "x" },
  });
  assert.equal(malformed.statusCode, 401);
  assert.deepEqual(malformed.json(), denied.json());

  const login = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    payload: { email: " A@TERMES.LOCAL ", password: accessCodeA },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().principal.accountId, accountA);
  assert.equal(login.json().principal.canManageSharedOAuth, true);
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

test("동일 IP와 정규화된 회원 이메일의 반복 로그인 실패는 15분 창에서 차단한다", async () => {
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
      payload: { email: attempt % 2 === 0 ? "B@TERMES.LOCAL" : "b@termes.local", password: "incorrect-password" },
    });
    assert.equal(response.statusCode, 401);
  }
  const blocked = await app.inject({
    method: "POST",
    url: "/api/account-auth/login",
    remoteAddress: "203.0.113.9",
    headers: { "x-forwarded-for": "198.51.100.250" },
    payload: { email: "b@termes.local", password: accessCodeB },
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

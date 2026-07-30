import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import pg from "../../apps/api/node_modules/pg/lib/index.js";
import { createAccountAuth, parseAccountAccessHashes } from "../../apps/api/src/account-auth.ts";

const databaseUrl = process.env.TERMES_TEST_DATABASE_URL;
const accountA = "00000000-0000-0000-0000-000000000001";
const accountB = "00000000-0000-0000-0000-000000000002";
const legacyPassword = "legacy-owner-test-password";

type InjectResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  json(): any;
};

type TestPool = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("실제 PostgreSQL에서 가입·승인·비밀번호 변경 경합을 원자적으로 처리한다", {
  skip: databaseUrl ? false : "TERMES_TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl }) as unknown as TestPool;
  const app = Fastify();
  const auth = createAccountAuth({
    db: { pool, close: () => pool.end() } as never,
    redis: new MemoryRedis() as never,
    accessHashes: parseAccountAccessHashes(JSON.stringify({
      [accountA]: digest(legacyPassword),
      [accountB]: digest("cell-b-test-password"),
    })),
    oauthAdminAccountId: accountA,
  });
  await auth.registerRoutes(app);

  try {
    const registrationPayload = {
      displayName: "Postgres Member",
      loginId: "postgres-member",
      email: "postgres-member@example.com",
      password: "original-postgres-password",
    };
    const registrations = await Promise.all([
      app.inject({ method: "POST", url: "/api/account-auth/register", payload: registrationPayload, remoteAddress: "203.0.113.10" }),
      app.inject({ method: "POST", url: "/api/account-auth/register", payload: registrationPayload, remoteAddress: "203.0.113.11" }),
    ]);
    assert.deepEqual(
      (registrations as InjectResponse[]).map((response) => response.statusCode).sort(),
      [201, 409],
      JSON.stringify((registrations as InjectResponse[]).map((response) => response.json())),
    );

    const pendingLogin = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      payload: { loginId: registrationPayload.loginId, password: registrationPayload.password },
    });
    assert.equal(pendingLogin.statusCode, 401);

    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      payload: { loginId: "master", password: legacyPassword },
    });
    assert.equal(adminLogin.statusCode, 200);
    const adminCookie = String(adminLogin.headers["set-cookie"]);
    const pending = await app.inject({ method: "GET", url: "/api/account-auth/members/pending", headers: { cookie: adminCookie } });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.json().members.length, 1);
    const memberId = String(pending.json().members[0].memberId);

    const approvals = await Promise.all([
      app.inject({ method: "POST", url: `/api/account-auth/members/${memberId}/approve`, headers: { cookie: adminCookie } }),
      app.inject({ method: "POST", url: `/api/account-auth/members/${memberId}/approve`, headers: { cookie: adminCookie } }),
    ]);
    assert.deepEqual((approvals as InjectResponse[]).map((response) => response.statusCode).sort(), [204, 404]);

    const firstMemberLogin = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      payload: { loginId: registrationPayload.loginId, password: registrationPayload.password },
    });
    const secondMemberLogin = await app.inject({
      method: "POST",
      url: "/api/account-auth/login",
      payload: { loginId: registrationPayload.loginId, password: registrationPayload.password },
    });
    assert.equal(firstMemberLogin.statusCode, 200);
    assert.equal(secondMemberLogin.statusCode, 200);
    const firstCookie = String(firstMemberLogin.headers["set-cookie"]);
    const secondCookie = String(secondMemberLogin.headers["set-cookie"]);
    const candidatePasswords = ["first-concurrent-password", "second-concurrent-password"];

    const changes = await Promise.all(candidatePasswords.map((newPassword, index) => app.inject({
      method: "PATCH",
      url: "/api/account-auth/password",
      headers: { cookie: index === 0 ? firstCookie : secondCookie },
      payload: { currentPassword: registrationPayload.password, newPassword },
    })));
    assert.deepEqual((changes as InjectResponse[]).map((response) => response.statusCode).sort(), [204, 409]);

    const persisted = await pool.query<{ credential_count: string; auth_session_version: string }>(
      `
        select count(c.member_id)::text as credential_count, m.auth_session_version::text
        from account_members m
        left join account_member_credentials c on c.member_id = m.id
        where m.id = $1
        group by m.auth_session_version
      `,
      [memberId],
    );
    assert.equal(persisted.rows[0]?.credential_count, "1");
    assert.equal(persisted.rows[0]?.auth_session_version, "1");

    const expiredSessions = await Promise.all([firstCookie, secondCookie].map((cookie) => app.inject({
      method: "GET",
      url: "/api/account-auth/session",
      headers: { cookie },
    })));
    assert.ok((expiredSessions as InjectResponse[]).every((response) => response.json().principal === null));

    const winningPasswordIndex = (changes as InjectResponse[]).findIndex((response) => response.statusCode === 204);
    for (const [index, password] of candidatePasswords.entries()) {
      const login = await app.inject({
        method: "POST",
        url: "/api/account-auth/login",
        payload: { loginId: registrationPayload.loginId, password },
      });
      assert.equal(login.statusCode, index === winningPasswordIndex ? 200 : 401);
    }
  } finally {
    await app.close();
    await pool.end();
  }
});

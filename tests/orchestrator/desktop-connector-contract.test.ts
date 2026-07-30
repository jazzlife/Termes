import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Fastify from "../../apps/api/node_modules/fastify/fastify.js";
import websocket from "../../apps/api/node_modules/@fastify/websocket/index.js";
import pg from "../../apps/api/node_modules/pg/lib/index.js";
import {
  DesktopConnectorHub,
  hashDesktopSecret,
  normalizeDesktopPairingCode,
} from "../../apps/api/src/desktop-connectors.ts";

const databaseUrl = process.env.TERMES_TEST_DATABASE_URL;

class NoopRedis {}

type InjectResponse = {
  statusCode: number;
  json(): any;
};

type TestPool = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
};

test("desktop pairing code normalization and hashing never preserve the raw credential", () => {
  assert.equal(normalizeDesktopPairingCode("abcde-f2345"), "ABCDEF2345");
  const raw = "connector-secret-value";
  const digest = hashDesktopSecret(raw);
  assert.equal(digest.length, 32);
  assert.notEqual(digest.toString("utf8"), raw);
  assert.deepEqual(digest, hashDesktopSecret(raw));
});

test("device mutation and command routes bind device and task IDs to the authenticated account workspace", async () => {
  const source = await readFile(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8");
  const patchRoute = source.slice(source.indexOf('app.patch("/api/devices/:deviceId"'), source.indexOf('app.delete("/api/devices/:deviceId"'));
  const deleteRoute = source.slice(source.indexOf('app.delete("/api/devices/:deviceId"'), source.indexOf('app.get("/api/device-capabilities"'));
  const commandRoute = source.slice(source.indexOf('app.post("/api/devices/:deviceId/commands"'), source.indexOf('app.get("/api/device-commands/:commandId"'));
  const commandReadRoute = source.slice(source.indexOf('app.get("/api/device-commands/:commandId"'), source.indexOf('app.get("/api/device-commands/:commandId/logs"'));
  const commandLogsRoute = source.slice(source.indexOf('app.get("/api/device-commands/:commandId/logs"'), source.indexOf('app.get("/api/devices/discover"'));

  for (const route of [patchRoute, deleteRoute, commandRoute, commandReadRoute, commandLogsRoute]) {
    assert.match(route, /p\.workspace_id = \$\d+/);
    assert.match(route, /pm\.user_id = \$\d+/);
  }
  assert.match(commandRoute, /t\.project_id = \$2/);
  assert.match(commandRoute, /p\.workspace_id = \$3/);
  assert.match(commandRoute, /pm\.user_id = \$4/);
});

test("desktop connector pairing is single-use and revocation preserves its row", {
  skip: databaseUrl ? false : "TERMES_TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl }) as unknown as TestPool;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const memberId = randomUUID();
  const projectId = randomUUID();
  const marker = randomUUID().slice(0, 8);
  const principal = {
    memberId,
    accountId,
    workspaceId,
    runtimeCellId: randomUUID(),
    email: `connector-${marker}@example.test`,
    displayName: "Connector Test",
    workspaceKey: `connector-${marker}`,
    workspaceRoot: `/tmp/connector-${marker}`,
    canManageSharedOAuth: false,
    canApproveMembers: false,
  };

  await pool.query(
    "insert into users (id, email, display_name, login_id) values ($1, $2, $3, $4)",
    [accountId, principal.email, principal.displayName, `connector-${marker}`],
  );
  await pool.query(
    "insert into account_workspaces (id, account_id, key, root_path) values ($1, $2, $3, $4)",
    [workspaceId, accountId, principal.workspaceKey, principal.workspaceRoot],
  );
  await pool.query(
    `insert into account_members (
       id, account_id, login_id, email, display_name, status, is_account_owner, approved_at
     ) values ($1, $2, $3, $4, $5, 'approved', false, now())`,
    [memberId, accountId, `member-${marker}`, `member-${marker}@example.test`, "Connector Member"],
  );
  await pool.query(
    "insert into projects (id, key, name, workspace_id) values ($1, $2, $3, $4)",
    [projectId, `connector-${marker}`, "Connector Project", workspaceId],
  );
  await pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
    [projectId, accountId],
  );

  const app = Fastify();
  await app.register(websocket);
  const hub = new DesktopConnectorHub({
    db: { pool, close: () => pool.end() } as never,
    redis: new NoopRedis() as never,
    artifactRoot: `/tmp/termes-desktop-connector-tests/${marker}`,
    principalForRequest: () => principal,
  });
  await hub.registerRoutes(app);

  try {
    const pairingResponse = await app.inject({
      method: "POST",
      url: "/api/desktop-connectors/pairing-codes",
      payload: { projectId },
    });
    assert.equal(pairingResponse.statusCode, 201);
    const pairing = pairingResponse.json() as { pairingCode: string };
    assert.match(pairing.pairingCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const pairPayload = {
      pairingCode: pairing.pairingCode,
      name: "Test Mac",
      platform: "macos",
      machineFingerprint: `test-machine-${marker}-1234567890`,
      publicKey: null,
      appVersion: "0.1.0-test",
      capabilities: ["macos.system.info", "macos.screen.capture"],
      permissions: {
        accessibility: "granted",
        screenCapture: "granted",
        inputControl: "denied",
        processInspection: "granted",
      },
    };
    const pairAttempts = await Promise.all([
      app.inject({ method: "POST", url: "/api/desktop-connectors/pair", payload: pairPayload }),
      app.inject({ method: "POST", url: "/api/desktop-connectors/pair", payload: pairPayload }),
    ]);
    assert.deepEqual((pairAttempts as InjectResponse[]).map((response) => response.statusCode).sort(), [201, 410]);
    const successfulPair = (pairAttempts as InjectResponse[]).find((response) => response.statusCode === 201);
    assert.ok(successfulPair);
    const paired = successfulPair.json() as {
      connectorId: string;
      deviceId: string;
      deviceToken: string;
      workspaceId: string;
      projectId: string;
    };
    assert.equal(paired.workspaceId, workspaceId);
    assert.equal(paired.projectId, projectId);
    assert.ok(paired.deviceToken.length >= 32);

    const stored = await pool.query<{ token_hash: Buffer; consumed_at: Date | null }>(
      `select dc.token_hash, pc.consumed_at
       from desktop_connectors dc
       join desktop_pairing_codes pc on pc.project_id = dc.project_id
       where dc.id = $1`,
      [paired.connectorId],
    );
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0]?.token_hash.toString("utf8"), paired.deviceToken);
    assert.ok(stored.rows[0]?.consumed_at);

    const list = await app.inject({
      method: "GET",
      url: `/api/desktop-connectors?projectId=${projectId}`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().connectors.length, 1);
    assert.equal(list.json().connectors[0].permissions.processInspection, "granted");

    const interruptedCommandId = randomUUID();
    await pool.query(
      `insert into device_commands (id, project_id, device_id, action, params, status, started_at)
       values ($1, $2, $3, 'macos.system.info', '{}'::jsonb, 'running', now())`,
      [interruptedCommandId, projectId, paired.deviceId],
    );
    await pool.query(
      `insert into desktop_connector_receipts (
         device_command_id, connector_id, sequence, request_hash, state
       ) values ($1, $2, 1, 'restart-test-hash', 'dispatched')`,
      [interruptedCommandId, paired.connectorId],
    );
    await pool.query("update desktop_connectors set status = 'online' where id = $1", [paired.connectorId]);
    await pool.query("update devices set status = 'online' where id = $1", [paired.deviceId]);
    await hub.initialize();
    const reconciled = await pool.query<{
      command_status: string;
      receipt_state: string;
      connector_status: string;
      device_status: string;
    }>(
      `select dc.status as command_status, dccr.state as receipt_state,
              desktop.status as connector_status, device.status as device_status
       from device_commands dc
       join desktop_connector_receipts dccr on dccr.device_command_id = dc.id
       join desktop_connectors desktop on desktop.id = dccr.connector_id
       join devices device on device.id = dc.device_id
       where dc.id = $1`,
      [interruptedCommandId],
    );
    assert.deepEqual(reconciled.rows[0], {
      command_status: "unknown",
      receipt_state: "unknown",
      connector_status: "offline",
      device_status: "offline",
    });

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/desktop-connectors/${paired.connectorId}`,
    });
    assert.equal(revoke.statusCode, 204);
    const persisted = await pool.query<{ status: string; revoked_at: Date | null }>(
      "select status, revoked_at from desktop_connectors where id = $1",
      [paired.connectorId],
    );
    assert.equal(persisted.rows[0]?.status, "revoked");
    assert.ok(persisted.rows[0]?.revoked_at);
  } finally {
    await app.close();
    await hub.close();
    await pool.query("delete from projects where id = $1", [projectId]);
    await pool.query("delete from users where id = $1", [accountId]);
    await pool.end();
  }
});

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

class FakeConnectorSocket {
  readyState = 1;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  private readonly messageListeners: Array<(data: unknown) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closed.push({ code, reason });
    for (const listener of this.closeListeners) listener();
  }

  on(event: "message" | "close" | "error", listener: ((data: unknown) => void) | (() => void)): void {
    if (event === "message") this.messageListeners.push(listener as (data: unknown) => void);
    if (event === "close") this.closeListeners.push(listener as () => void);
  }

  emitMessage(message: Record<string, unknown>): void {
    const data = JSON.stringify(message);
    for (const listener of this.messageListeners) listener(data);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for connector test state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

test("account-owned devices stay account-scoped while commands retain their invoking workspace and project", async () => {
  const source = await readFile(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8");
  const patchRoute = source.slice(source.indexOf('app.patch("/api/devices/:deviceId"'), source.indexOf('app.delete("/api/devices/:deviceId"'));
  const deleteRoute = source.slice(source.indexOf('app.delete("/api/devices/:deviceId"'), source.indexOf('app.get("/api/device-capabilities"'));
  const commandRoute = source.slice(source.indexOf('app.post("/api/devices/:deviceId/commands"'), source.indexOf('app.get("/api/device-commands/:commandId"'));
  const commandReadRoute = source.slice(source.indexOf('app.get("/api/device-commands/:commandId"'), source.indexOf('app.get("/api/device-commands/:commandId/logs"'));
  const commandLogsRoute = source.slice(source.indexOf('app.get("/api/device-commands/:commandId/logs"'), source.indexOf('app.get("/api/devices/discover"'));

  for (const route of [patchRoute, deleteRoute]) {
    assert.match(route, /d\.transport <> 'connector'/);
    assert.match(route, /p\.workspace_id = \$2/);
    assert.match(route, /pm\.user_id = \$3/);
  }
  assert.match(commandRoute, /d\.account_id = \$2/);
  assert.match(commandRoute, /connector\.revoked_at is null/);
  assert.match(commandRoute, /device\.transport !== "connector" && device\.projectId !== commandProjectId/);
  assert.match(commandRoute, /t\.account_id = \$2 and t\.workspace_id = \$3/);
  assert.match(commandRoute, /insert into device_commands \(account_id, workspace_id, project_id[\s\S]*select \$1, \$2, p\.id/);
  assert.match(commandRoute, /join project_members command_member[\s\S]*command_member\.user_id = \$1/);
  assert.match(commandRoute, /d\.transport <> 'connector' and d\.project_id = p\.id/);
  for (const route of [commandReadRoute, commandLogsRoute]) {
    assert.match(route, /dc\.account_id = \$2 and dc\.workspace_id = \$3/);
  }
});

test("account device migration detaches only connector devices from legacy project ownership", async () => {
  const migration = await readFile(
    new URL("../../infra/db/migrations/021_account_owned_devices.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /drop constraint if exists desktop_connectors_device_id_project_id_fkey/);
  assert.match(migration, /update devices d\s+set project_id = null[\s\S]*where d\.transport = 'connector'/);
  assert.match(migration, /transport = 'connector' and project_id is null/);
  assert.match(migration, /transport <> 'connector' and project_id is not null/);
  assert.match(migration, /desktop_connector_receipts_state_check[\s\S]*'processing'/);
  assert.doesNotMatch(migration, /alter table desktop_pairing_codes/);

  const orchestrator = await readFile(new URL("../../services/orchestrator/src/main.ts", import.meta.url), "utf8");
  assert.match(orchestrator, /d\.transport = 'connector' and connector\.id is not null/);
  assert.match(orchestrator, /d\.transport <> 'connector' and d\.project_id = \$3/);

});

test("desktop connector lifecycle serializes replacement connection tasks", async () => {
  const source = await readFile(
    new URL("../../apps/desktop-connector/src-tauri/src/connector.rs", import.meta.url),
    "utf8",
  );
  assert.match(source, /lifecycle:\s*Mutex<\(\)>/);
  assert.match(source, /async fn connect_locked/);
  assert.match(source, /task\.abort\(\);\s*let _ = task\.await;/);
});

test("desktop connector pairing is single-use and revocation preserves its row", {
  skip: databaseUrl ? false : "TERMES_TEST_DATABASE_URL is not configured",
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl }) as unknown as TestPool;
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const secondWorkspaceId = randomUUID();
  const memberId = randomUUID();
  const projectId = randomUUID();
  const secondProjectId = randomUUID();
  const genericDeviceId = randomUUID();
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
  let activePrincipal = principal;

  await pool.query(
    "insert into users (id, email, display_name, login_id) values ($1, $2, $3, $4)",
    [accountId, principal.email, principal.displayName, `connector-${marker}`],
  );
  await pool.query(
    "insert into account_workspaces (id, account_id, key, root_path) values ($1, $2, $3, $4)",
    [workspaceId, accountId, principal.workspaceKey, principal.workspaceRoot],
  );
  await pool.query(
    "insert into account_workspaces (id, account_id, key, root_path) values ($1, $2, $3, $4)",
    [secondWorkspaceId, accountId, `${principal.workspaceKey}-second`, `${principal.workspaceRoot}-second`],
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
  await pool.query(
    "insert into projects (id, key, name, workspace_id) values ($1, $2, $3, $4)",
    [secondProjectId, `connector-second-${marker}`, "Second Connector Project", secondWorkspaceId],
  );
  await pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'owner')",
    [secondProjectId, accountId],
  );
  await pool.query(
    `insert into devices (
       id, account_id, project_id, key, name, platform, transport, labels, status
     ) values ($1, $2, $3, $4, 'Project Linux', 'linux', 'ssh', '{}'::jsonb, 'offline')`,
    [genericDeviceId, accountId, projectId, `project-linux-${marker}`],
  );

  const app = Fastify();
  await app.register(websocket);
  const hub = new DesktopConnectorHub({
    db: { pool, close: () => pool.end() } as never,
    redis: new NoopRedis() as never,
    artifactRoot: `/tmp/termes-desktop-connector-tests/${marker}`,
    principalForRequest: () => activePrincipal,
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

    const stored = await pool.query<{
      token_hash: Buffer;
      connector_workspace_id: string | null;
      connector_project_id: string | null;
      device_account_id: string;
      device_project_id: string | null;
    }>(
      `select dc.token_hash, dc.workspace_id as connector_workspace_id,
              dc.project_id as connector_project_id, d.account_id as device_account_id,
              d.project_id as device_project_id
       from desktop_connectors dc
       join devices d on d.id = dc.device_id and d.account_id = dc.account_id
       where dc.id = $1`,
      [paired.connectorId],
    );
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0]?.token_hash.toString("utf8"), paired.deviceToken);
    assert.equal(stored.rows[0]?.connector_workspace_id, null);
    assert.equal(stored.rows[0]?.connector_project_id, null);
    assert.equal(stored.rows[0]?.device_account_id, accountId);
    assert.equal(stored.rows[0]?.device_project_id, null);
    const consumed = await pool.query<{ consumed_at: Date | null }>(
      "select consumed_at from desktop_pairing_codes where code_hash = $1",
      [hashDesktopSecret(normalizeDesktopPairingCode(pairing.pairingCode))],
    );
    assert.ok(consumed.rows[0]?.consumed_at);

    const list = await app.inject({
      method: "GET",
      url: `/api/desktop-connectors?projectId=${projectId}`,
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().connectors.length, 1);
    assert.equal(list.json().connectors[0].permissions.processInspection, "granted");

    activePrincipal = {
      ...principal,
      workspaceId: secondWorkspaceId,
      workspaceKey: `${principal.workspaceKey}-second`,
      workspaceRoot: `${principal.workspaceRoot}-second`,
    };
    const secondWorkspaceList = await app.inject({ method: "GET", url: "/api/desktop-connectors" });
    assert.equal(secondWorkspaceList.statusCode, 200);
    assert.equal(secondWorkspaceList.json().connectors[0]?.id, paired.connectorId);
    const crossWorkspaceCommand = await pool.query<{
      account_id: string;
      workspace_id: string;
      project_id: string;
      device_id: string;
    }>(
      `insert into device_commands (
         account_id, workspace_id, project_id, device_id, action, params, status
       ) values ($1, $2, $3, $4, 'macos.system.info', '{}'::jsonb, 'created')
       returning account_id, workspace_id, project_id, device_id`,
      [accountId, secondWorkspaceId, secondProjectId, paired.deviceId],
    );
    assert.deepEqual(crossWorkspaceCommand.rows[0], {
      account_id: accountId,
      workspace_id: secondWorkspaceId,
      project_id: secondProjectId,
      device_id: paired.deviceId,
    });
    await assert.rejects(
      pool.query(
        `insert into device_commands (
           account_id, workspace_id, project_id, device_id, action, params, status
         ) values ($1, $2, $3, $4, 'linux.system.info', '{}'::jsonb, 'created')`,
        [accountId, secondWorkspaceId, secondProjectId, genericDeviceId],
      ),
      /Project device command must use the device project/,
    );

    const socket = new FakeConnectorSocket();
    await (
      hub as unknown as {
        acceptSocket(socket: FakeConnectorSocket, request: Record<string, unknown>): Promise<void>;
      }
    ).acceptSocket(socket, {
      query: { connectorId: paired.connectorId },
      headers: { authorization: `Bearer ${paired.deviceToken}` },
    });
    await pool.query("update desktop_connectors set status = 'online' where id = $1", [paired.connectorId]);

    const concurrentCommandIds = [randomUUID(), randomUUID()];
    for (const commandId of concurrentCommandIds) {
      await pool.query(
        `insert into device_commands (
           id, account_id, workspace_id, project_id, device_id, action, params, status
         ) values ($1, $2, $3, $4, $5, 'macos.system.info', '{}'::jsonb, 'created')`,
        [commandId, accountId, secondWorkspaceId, secondProjectId, paired.deviceId],
      );
    }
    const executions = concurrentCommandIds.map((commandId) =>
      hub.executeCommand({
        commandId,
        deviceId: paired.deviceId,
        action: "macos.system.info",
        params: {},
        timeoutMs: 500,
      }),
    );
    const executionResults = Promise.allSettled(executions);
    await waitFor(() => socket.sent.some((message) => message.type === "command"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const message of socket.sent.filter((candidate) => candidate.type === "command")) {
      socket.emitMessage({
        type: "command.result",
        commandId: message.commandId,
        sequence: message.sequence,
        status: "completed",
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        completedAt: new Date().toISOString(),
      });
    }
    const concurrentResults = await executionResults;
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
    assert.match(
      String((concurrentResults.find((result) => result.status === "rejected") as PromiseRejectedResult).reason),
      /desktop_connector_busy/,
    );

    await waitFor(async () => {
      const status = await pool.query<{ status: string }>(
        "select status from desktop_connectors where id = $1",
        [paired.connectorId],
      );
      return status.rows[0]?.status === "online";
    });
    const duplicateResultCommandId = randomUUID();
    await pool.query(
      `insert into device_commands (
         id, account_id, workspace_id, project_id, device_id, action, params, status
       ) values ($1, $2, $3, $4, $5, 'macos.screen.capture', '{}'::jsonb, 'created')`,
      [duplicateResultCommandId, accountId, secondWorkspaceId, secondProjectId, paired.deviceId],
    );
    const sentBeforeDuplicateResult = socket.sent.length;
    const duplicateExecution = hub.executeCommand({
      commandId: duplicateResultCommandId,
      deviceId: paired.deviceId,
      action: "macos.screen.capture",
      params: {},
      timeoutMs: 1_000,
    });
    await waitFor(() => socket.sent.length > sentBeforeDuplicateResult);
    const duplicateEnvelope = socket.sent.find(
      (message, index) => index >= sentBeforeDuplicateResult && message.type === "command",
    );
    assert.ok(duplicateEnvelope);
    const artifactContent = Buffer.from("single artifact despite duplicate results");
    const resultMessage = {
      type: "command.result",
      commandId: duplicateResultCommandId,
      sequence: duplicateEnvelope.sequence,
      status: "completed",
      stdout: "captured",
      stderr: "",
      exitCode: 0,
      completedAt: new Date().toISOString(),
      artifact: {
        mimeType: "text/plain",
        base64: artifactContent.toString("base64"),
        sha256: createHash("sha256").update(artifactContent).digest("hex"),
        metadata: {},
      },
    };
    socket.emitMessage(resultMessage);
    socket.emitMessage(resultMessage);
    socket.emitMessage({
      type: "command.ack",
      commandId: duplicateResultCommandId,
      sequence: duplicateEnvelope.sequence,
      accepted: true,
      acknowledgedAt: new Date().toISOString(),
    });
    const duplicateResult = await duplicateExecution;
    assert.equal(duplicateResult.status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const duplicatePersistence = await pool.query<{ receipt_state: string; artifact_count: string }>(
      `select r.state as receipt_state, count(a.id)::text as artifact_count
       from desktop_connector_receipts r
       left join artifacts a on a.metadata->>'deviceCommandId' = r.device_command_id::text
       where r.device_command_id = $1
       group by r.state`,
      [duplicateResultCommandId],
    );
    assert.deepEqual(duplicatePersistence.rows[0], {
      receipt_state: "completed",
      artifact_count: "1",
    });

    const timeoutRaceCommandId = randomUUID();
    await pool.query(
      `insert into device_commands (
         id, account_id, workspace_id, project_id, device_id, action, params, status
       ) values ($1, $2, $3, $4, $5, 'macos.system.info', '{}'::jsonb, 'created')`,
      [timeoutRaceCommandId, accountId, secondWorkspaceId, secondProjectId, paired.deviceId],
    );
    const sentBeforeTimeoutRace = socket.sent.length;
    const timeoutRaceExecution = hub.executeCommand({
      commandId: timeoutRaceCommandId,
      deviceId: paired.deviceId,
      action: "macos.system.info",
      params: {},
      timeoutMs: 10_000,
    });
    await waitFor(() => socket.sent.length > sentBeforeTimeoutRace);
    const timeoutRaceEnvelope = socket.sent.find(
      (message, index) => index >= sentBeforeTimeoutRace && message.type === "command",
    );
    assert.ok(timeoutRaceEnvelope);
    const lockClient = await (pool as unknown as {
      connect(): Promise<{
        query(sql: string, params?: unknown[]): Promise<unknown>;
        release(): void;
      }>;
    }).connect();
    await lockClient.query("begin");
    try {
      await lockClient.query(
        "select id from desktop_connector_receipts where device_command_id = $1 for update",
        [timeoutRaceCommandId],
      );
      socket.emitMessage({
        type: "command.result",
        commandId: timeoutRaceCommandId,
        sequence: timeoutRaceEnvelope.sequence,
        status: "completed",
        stdout: "race completed",
        stderr: "",
        exitCode: 0,
        completedAt: new Date().toISOString(),
      });
      const internals = hub as unknown as {
        pending: Map<string, { processingResult: boolean }>;
        timeoutCommand(commandId: string, timeoutMs: number): Promise<void>;
      };
      await waitFor(() => internals.pending.get(timeoutRaceCommandId)?.processingResult === true);
      await internals.timeoutCommand(timeoutRaceCommandId, 10_000);
    } finally {
      await lockClient.query("rollback");
      lockClient.release();
    }
    const timeoutRaceResult = await timeoutRaceExecution;
    assert.equal(timeoutRaceResult.status, "completed");
    const timeoutRaceReceipt = await pool.query<{ state: string }>(
      "select state from desktop_connector_receipts where device_command_id = $1",
      [timeoutRaceCommandId],
    );
    assert.equal(timeoutRaceReceipt.rows[0]?.state, "completed");

    const rotatedCodeResponse = await app.inject({
      method: "POST",
      url: "/api/desktop-connectors/pairing-codes",
      payload: { projectId: secondProjectId },
    });
    assert.equal(rotatedCodeResponse.statusCode, 201);
    const rotatedPair = await app.inject({
      method: "POST",
      url: "/api/desktop-connectors/pair",
      payload: {
        ...pairPayload,
        pairingCode: rotatedCodeResponse.json().pairingCode,
      },
    });
    assert.equal(rotatedPair.statusCode, 201);
    const rotatedCredentials = rotatedPair.json() as { deviceToken: string };
    assert.equal(socket.closed.at(-1)?.code, 4002);
    await waitFor(async () => {
      const status = await pool.query<{ status: string }>(
        "select status from desktop_connectors where id = $1",
        [paired.connectorId],
      );
      return status.rows[0]?.status === "offline";
    });

    const rotatedCommandId = randomUUID();
    await pool.query(
      `insert into device_commands (
         id, account_id, workspace_id, project_id, device_id, action, params, status
       ) values ($1, $2, $3, $4, $5, 'macos.system.info', '{}'::jsonb, 'created')`,
      [rotatedCommandId, accountId, secondWorkspaceId, secondProjectId, paired.deviceId],
    );
    await assert.rejects(
      hub.executeCommand({
        commandId: rotatedCommandId,
        deviceId: paired.deviceId,
        action: "macos.system.info",
        params: {},
        timeoutMs: 50,
      }),
      /desktop_connector_offline|desktop_connector_credential_expired/,
    );

    activePrincipal = { ...activePrincipal, accountId: randomUUID() };
    const otherAccountList = await app.inject({ method: "GET", url: "/api/desktop-connectors" });
    assert.equal(otherAccountList.statusCode, 200);
    assert.equal(otherAccountList.json().connectors.length, 0);
    const otherAccountRevoke = await app.inject({
      method: "DELETE",
      url: `/api/desktop-connectors/${paired.connectorId}`,
    });
    assert.equal(otherAccountRevoke.statusCode, 404);
    activePrincipal = {
      ...principal,
      workspaceId: secondWorkspaceId,
      workspaceKey: `${principal.workspaceKey}-second`,
      workspaceRoot: `${principal.workspaceRoot}-second`,
    };

    const interruptedCommandId = randomUUID();
    await pool.query(
      `insert into device_commands (id, project_id, device_id, action, params, status, started_at)
       values ($1, $2, $3, 'macos.system.info', '{}'::jsonb, 'running', now())`,
      [interruptedCommandId, projectId, paired.deviceId],
    );
    await pool.query(
      `insert into desktop_connector_receipts (
         device_command_id, connector_id, sequence, request_hash, state
       )
       select $1, $2, coalesce(max(sequence), 0) + 1, 'restart-test-hash', 'dispatched'
       from desktop_connector_receipts
       where connector_id = $2`,
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

    const racingSocket = new FakeConnectorSocket();
    const acceptance = (
      hub as unknown as {
        acceptSocket(socket: FakeConnectorSocket, request: Record<string, unknown>): Promise<void>;
      }
    ).acceptSocket(racingSocket, {
      query: { connectorId: paired.connectorId },
      headers: { authorization: `Bearer ${rotatedCredentials.deviceToken}` },
    });
    const [acceptanceResult, revokeResult] = await Promise.allSettled([
      acceptance,
      app.inject({
        method: "DELETE",
        url: `/api/desktop-connectors/${paired.connectorId}`,
      }),
    ]);
    assert.equal(revokeResult.status, "fulfilled");
    const revoke = (revokeResult as PromiseFulfilledResult<InjectResponse>).value;
    assert.equal(revoke.statusCode, 204);
    if (acceptanceResult.status === "fulfilled") {
      assert.ok(racingSocket.closed.some((entry) => entry.code === 4001 || entry.code === 4401));
    }
    const persisted = await pool.query<{ status: string; revoked_at: Date | null }>(
      "select status, revoked_at from desktop_connectors where id = $1",
      [paired.connectorId],
    );
    assert.equal(persisted.rows[0]?.status, "revoked");
    assert.ok(persisted.rows[0]?.revoked_at);
  } finally {
    await app.close();
    await hub.close();
    await pool.query("delete from projects where id = any($1::uuid[])", [[projectId, secondProjectId]]);
    await pool.query("delete from users where id = $1", [accountId]);
    await pool.end();
  }
});

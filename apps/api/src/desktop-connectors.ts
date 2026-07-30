import type {
  DesktopConnectorPairingCodeSummary,
  DesktopConnectorPairingResult,
  DesktopConnectorPermissionState,
  DesktopConnectorStatus,
  DesktopConnectorSummary,
  DeviceCommandStatus,
} from "@termes/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type Redis from "ioredis";
import { z } from "zod";
import type { AccountPrincipal } from "./account-auth";
import type { Db } from "./db";
import { appendEvent } from "./events";

const protocolVersion = 1;
const pairingTtlMs = 10 * 60 * 1000;
const heartbeatStaleMs = 35_000;
const maximumArtifactBytes = 6 * 1024 * 1024;
const pairingAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const connectorPlatformSchema = z.enum(["windows", "macos"]);
const permissionValueSchema = z.enum(["granted", "denied", "not_determined", "unsupported"]);
const permissionsSchema = z.object({
  accessibility: permissionValueSchema,
  screenCapture: permissionValueSchema,
  inputControl: permissionValueSchema,
  processInspection: permissionValueSchema,
});
const capabilitiesSchema = z.array(z.string().trim().min(1).max(120)).max(64);
const pairingRequestSchema = z.object({
  pairingCode: z.string().trim().min(8).max(32),
  name: z.string().trim().min(1).max(120),
  platform: connectorPlatformSchema,
  machineFingerprint: z.string().trim().min(16).max(256).regex(/^[A-Za-z0-9._:-]+$/),
  publicKey: z.string().trim().min(16).max(4096).nullable().optional(),
  appVersion: z.string().trim().min(1).max(80),
  capabilities: capabilitiesSchema,
  permissions: permissionsSchema,
});
const createPairingCodeSchema = z.object({
  projectId: z.string().uuid(),
});
const listConnectorsSchema = z.object({
  projectId: z.string().uuid().optional(),
});
const connectorParamsSchema = z.object({ connectorId: z.string().uuid() });
const artifactParamsSchema = z.object({ artifactId: z.string().uuid() });
const connectQuerySchema = z.object({ connectorId: z.string().uuid() });

const helloMessageSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  appVersion: z.string().trim().min(1).max(80),
  capabilities: capabilitiesSchema,
  permissions: permissionsSchema,
});
const heartbeatMessageSchema = z.object({
  type: z.literal("heartbeat"),
  sentAt: z.string().datetime(),
  capabilities: capabilitiesSchema.optional(),
  permissions: permissionsSchema.optional(),
});
const commandAckSchema = z.object({
  type: z.literal("command.ack"),
  commandId: z.string().uuid(),
  sequence: z.number().int().positive(),
  accepted: z.boolean(),
  reason: z.string().max(2000).optional(),
  acknowledgedAt: z.string().datetime(),
});
const artifactSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "application/json", "text/plain"]),
  base64: z.string().min(1).max(maximumArtifactBytes * 2),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.record(z.unknown()).optional(),
});
const commandResultSchema = z.object({
  type: z.literal("command.result"),
  commandId: z.string().uuid(),
  sequence: z.number().int().positive(),
  status: z.enum(["completed", "failed", "cancelled", "refused", "unknown"]),
  stdout: z.string().max(262_144).optional(),
  stderr: z.string().max(262_144).optional(),
  exitCode: z.number().int().nullable().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime(),
  artifact: artifactSchema.optional(),
});

const connectorMessageSchema = z.discriminatedUnion("type", [
  helloMessageSchema,
  heartbeatMessageSchema,
  commandAckSchema,
  commandResultSchema,
]);

type ConnectorRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  project_id: string;
  project_name: string;
  workspace_key: string;
  device_id: string;
  name: string;
  platform: "windows" | "macos";
  status: DesktopConnectorStatus;
  app_version: string;
  protocol_version: number;
  credential_version: number;
  capabilities: unknown;
  permissions: unknown;
  last_connected_at: Date | null;
  last_heartbeat_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ConnectorSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

export type DesktopCommandResult = {
  status: DeviceCommandStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  artifactUri: string | null;
  startedAt: string;
  completedAt: string;
};

export type DesktopCommandRequest = {
  commandId: string;
  deviceId: string;
  action: string;
  params: Record<string, unknown>;
  timeoutMs: number;
};

type PendingCommand = {
  connectorId: string;
  sequence: number;
  timer: NodeJS.Timeout;
  resolve: (result: DesktopCommandResult) => void;
};

export type DesktopConnectorDependencies = {
  db: Db;
  redis: Redis;
  artifactRoot: string;
  principalForRequest: (request: FastifyRequest) => AccountPrincipal;
};

function parseJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function defaultPermissions(): DesktopConnectorPermissionState {
  return {
    accessibility: "not_determined",
    screenCapture: "not_determined",
    inputControl: "not_determined",
    processInspection: "not_determined",
  };
}

function parsePermissions(value: unknown): DesktopConnectorPermissionState {
  const parsed = permissionsSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultPermissions();
}

function effectiveConnectorStatus(row: ConnectorRow): DesktopConnectorStatus {
  if (row.revoked_at) return "revoked";
  if (row.status === "online" || row.status === "busy" || row.status === "connecting") {
    const heartbeat = row.last_heartbeat_at?.getTime() || row.last_connected_at?.getTime() || 0;
    if (Date.now() - heartbeat > heartbeatStaleMs) return "offline";
  }
  return row.status;
}

function mapConnector(row: ConnectorRow): DesktopConnectorSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    deviceId: row.device_id,
    name: row.name,
    platform: row.platform,
    status: effectiveConnectorStatus(row),
    appVersion: row.app_version,
    protocolVersion: row.protocol_version,
    credentialVersion: row.credential_version,
    capabilities: parseJsonArray(row.capabilities),
    permissions: parsePermissions(row.permissions),
    lastConnectedAt: row.last_connected_at?.toISOString() || null,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() || null,
    revokedAt: row.revoked_at?.toISOString() || null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function normalizeDesktopPairingCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashDesktopSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function createPairingCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) code += pairingAlphabet[byte % pairingAlphabet.length];
  return formatPairingCode(code);
}

function machineDeviceKey(platform: "windows" | "macos", fingerprint: string): string {
  const suffix = createHash("sha256").update(fingerprint).digest("hex").slice(0, 20);
  return `desktop-${platform}-${suffix}`;
}

function requestDigest(input: DesktopCommandRequest, sequence: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ commandId: input.commandId, sequence, action: input.action, params: input.params }))
    .digest("hex");
}

function websocketBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length).trim();
  const protocol = request.headers["sec-websocket-protocol"];
  const protocols = typeof protocol === "string" ? protocol.split(",").map((value) => value.trim()) : [];
  const encoded = protocols.find((value) => value.startsWith("termes-token."));
  return encoded ? encoded.slice("termes-token.".length) : null;
}

function socketText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) return Buffer.concat(data).toString("utf8");
  if (data && typeof data === "object" && "toString" in data) return String(data);
  return null;
}

function artifactExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "application/json": return ".json";
    default: return ".txt";
  }
}

export class DesktopConnectorHub {
  private readonly sockets = new Map<string, ConnectorSocket>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly activeByConnector = new Map<string, string>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly deps: DesktopConnectorDependencies) {
    this.sweeper = setInterval(() => {
      void this.markStaleConnectorsOffline();
    }, 15_000);
    this.sweeper.unref();
  }

  async initialize(): Promise<void> {
    const client = await this.deps.db.pool.connect();
    try {
      await client.query("begin");
      const interrupted = await client.query<{ device_command_id: string }>(
        `
          update desktop_connector_receipts
          set state = 'unknown', completed_at = coalesce(completed_at, now()),
              result = jsonb_build_object('reason', 'Termes API restarted before the connector result was finalized'),
              updated_at = now()
          where state in ('dispatched', 'acknowledged')
          returning device_command_id
        `,
      );
      if (interrupted.rows.length > 0) {
        await client.query(
          `
            update device_commands
            set status = 'unknown',
                stderr = 'Connector execution outcome is unknown because the Termes API restarted',
                completed_at = coalesce(completed_at, now()), updated_at = now()
            where id = any($1::uuid[]) and status in ('created', 'queued', 'running')
          `,
          [interrupted.rows.map((row) => row.device_command_id)],
        );
      }
      const disconnected = await client.query<{ device_id: string }>(
        `
          update desktop_connectors
          set status = 'offline', disconnected_at = coalesce(disconnected_at, now()), updated_at = now()
          where revoked_at is null and status in ('connecting', 'online', 'busy')
          returning device_id
        `,
      );
      if (disconnected.rows.length > 0) {
        await client.query(
          "update devices set status = 'offline', updated_at = now() where id = any($1::uuid[])",
          [disconnected.rows.map((row) => row.device_id)],
        );
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async registerRoutes(app: FastifyInstance): Promise<void> {
    app.post("/api/desktop-connectors/pairing-codes", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const input = createPairingCodeSchema.parse(request.body);
      const projectResult = await this.deps.db.pool.query<{ id: string; name: string }>(
        `
          select p.id, p.name
          from projects p
          join project_members pm on pm.project_id = p.id and pm.user_id = $2
          where p.id = $1 and p.workspace_id = $3
        `,
        [input.projectId, principal.accountId, principal.workspaceId],
      );
      const project = projectResult.rows[0];
      if (!project) return reply.code(404).send({ error: "Project not found" });

      const pairingCode = createPairingCode();
      const expiresAt = new Date(Date.now() + pairingTtlMs);
      await this.deps.db.pool.query(
        `
          insert into desktop_pairing_codes (
            account_id, workspace_id, project_id, created_by, code_hash, expires_at
          ) values ($1, $2, $3, $4, $5, $6)
        `,
        [
          principal.accountId,
          principal.workspaceId,
          project.id,
          principal.memberId,
          hashDesktopSecret(normalizeDesktopPairingCode(pairingCode)),
          expiresAt,
        ],
      );
      await this.deps.db.pool.query(
        "delete from desktop_pairing_codes where consumed_at is not null or expires_at < now() - interval '1 hour'",
      );
      const summary: DesktopConnectorPairingCodeSummary = {
        pairingCode,
        expiresAt: expiresAt.toISOString(),
        projectId: project.id,
        projectName: project.name,
      };
      return reply.code(201).send(summary);
    });

    app.post("/api/desktop-connectors/pair", async (request, reply) => {
      const input = pairingRequestSchema.parse(request.body);
      const normalizedCode = normalizeDesktopPairingCode(input.pairingCode);
      const client = await this.deps.db.pool.connect();
      let result: DesktopConnectorPairingResult | null = null;
      let eventProjectId: string | null = null;
      try {
        await client.query("begin");
        const pairingResult = await client.query<{
          id: string;
          account_id: string;
          workspace_id: string;
          workspace_key: string;
          project_id: string;
          project_name: string;
          expires_at: Date;
          consumed_at: Date | null;
        }>(
          `
            select pc.id, pc.account_id, pc.workspace_id, aw.key as workspace_key,
                   pc.project_id, p.name as project_name, pc.expires_at, pc.consumed_at
            from desktop_pairing_codes pc
            join account_workspaces aw on aw.id = pc.workspace_id and aw.account_id = pc.account_id
            join projects p on p.id = pc.project_id and p.workspace_id = pc.workspace_id
            where pc.code_hash = $1
            for update of pc
          `,
          [hashDesktopSecret(normalizedCode)],
        );
        const pairing = pairingResult.rows[0];
        if (!pairing || pairing.consumed_at || pairing.expires_at.getTime() <= Date.now()) {
          await client.query("rollback");
          return reply.code(410).send({ error: "pairing_code_invalid_or_expired" });
        }

        const deviceResult = await client.query<{ id: string }>(
          `
            insert into devices (project_id, key, name, platform, transport, endpoint, labels, status)
            values ($1, $2, $3, $4, 'connector', null, $5::jsonb, 'offline')
            on conflict (project_id, key) do update
            set name = excluded.name,
                platform = excluded.platform,
                transport = 'connector',
                endpoint = null,
                labels = excluded.labels,
                status = 'offline',
                updated_at = now()
            returning id
          `,
          [
            pairing.project_id,
            machineDeviceKey(input.platform, input.machineFingerprint),
            input.name,
            input.platform,
            JSON.stringify({ source: "desktop-connector", appVersion: input.appVersion }),
          ],
        );
        const deviceId = deviceResult.rows[0]?.id;
        if (!deviceId) throw new Error("Desktop device upsert did not return an id");

        const deviceToken = randomBytes(32).toString("base64url");
        const priorResult = await client.query<{ id: string; device_id: string }>(
          `
            select id, device_id
            from desktop_connectors
            where workspace_id = $1 and machine_fingerprint = $2
            order by created_at desc
            limit 1
            for update
          `,
          [pairing.workspace_id, input.machineFingerprint],
        );
        const prior = priorResult.rows[0];
        let connectorId: string;
        if (prior) {
          connectorId = prior.id;
          await client.query(
            `
              update desktop_connectors
              set account_id = $2,
                  workspace_id = $3,
                  project_id = $4,
                  device_id = $5,
                  name = $6,
                  platform = $7,
                  public_key = $8,
                  token_hash = $9,
                  credential_version = credential_version + 1,
                  protocol_version = $10,
                  app_version = $11,
                  capabilities = $12::jsonb,
                  permissions = $13::jsonb,
                  status = 'offline',
                  revoked_at = null,
                  disconnected_at = now(),
                  updated_at = now()
              where id = $1
            `,
            [
              connectorId,
              pairing.account_id,
              pairing.workspace_id,
              pairing.project_id,
              deviceId,
              input.name,
              input.platform,
              input.publicKey ?? null,
              hashDesktopSecret(deviceToken),
              protocolVersion,
              input.appVersion,
              JSON.stringify(input.capabilities),
              JSON.stringify(input.permissions),
            ],
          );
          if (prior.device_id !== deviceId) {
            await client.query("update devices set status = 'offline', updated_at = now() where id = $1", [prior.device_id]);
          }
        } else {
          const connectorResult = await client.query<{ id: string }>(
            `
              insert into desktop_connectors (
                account_id, workspace_id, project_id, device_id, name, platform,
                machine_fingerprint, public_key, token_hash, protocol_version,
                app_version, capabilities, permissions
              ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb)
              returning id
            `,
            [
              pairing.account_id,
              pairing.workspace_id,
              pairing.project_id,
              deviceId,
              input.name,
              input.platform,
              input.machineFingerprint,
              input.publicKey ?? null,
              hashDesktopSecret(deviceToken),
              protocolVersion,
              input.appVersion,
              JSON.stringify(input.capabilities),
              JSON.stringify(input.permissions),
            ],
          );
          connectorId = connectorResult.rows[0]?.id || "";
          if (!connectorId) throw new Error("Desktop connector insert did not return an id");
        }

        await client.query("update desktop_pairing_codes set consumed_at = now() where id = $1", [pairing.id]);
        await client.query("commit");
        eventProjectId = pairing.project_id;
        result = {
          connectorId,
          deviceId,
          deviceToken,
          accountId: pairing.account_id,
          workspaceId: pairing.workspace_id,
          workspaceKey: pairing.workspace_key,
          projectId: pairing.project_id,
          projectName: pairing.project_name,
          websocketPath: `/api/desktop-connectors/connect?connectorId=${encodeURIComponent(connectorId)}`,
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      if (!result || !eventProjectId) throw new Error("Desktop connector pairing did not complete");
      await appendEvent(this.deps.db.pool, this.deps.redis, {
        projectId: eventProjectId,
        type: "device.connector.paired",
        payload: { connectorId: result.connectorId, deviceId: result.deviceId, platform: input.platform },
      });
      return reply.code(201).send(result);
    });

    app.get("/api/desktop-connectors", async (request) => {
      const principal = this.deps.principalForRequest(request);
      const query = listConnectorsSchema.parse(request.query);
      const values: string[] = [principal.accountId, principal.workspaceId];
      const projectClause = query.projectId ? "and dc.project_id = $3" : "";
      if (query.projectId) values.push(query.projectId);
      const connectors = await this.deps.db.pool.query<ConnectorRow>(
        `
          select dc.*, p.name as project_name, aw.key as workspace_key
          from desktop_connectors dc
          join projects p on p.id = dc.project_id and p.workspace_id = dc.workspace_id
          join account_workspaces aw on aw.id = dc.workspace_id and aw.account_id = dc.account_id
          where dc.account_id = $1 and dc.workspace_id = $2 ${projectClause}
          order by dc.updated_at desc, dc.created_at desc
        `,
        values,
      );
      return { connectors: connectors.rows.map(mapConnector) };
    });

    app.post("/api/desktop-connectors/:connectorId/disconnect", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const params = connectorParamsSchema.parse(request.params);
      const row = await this.ownedConnector(params.connectorId, principal);
      if (!row) return reply.code(404).send({ error: "Desktop connector not found" });
      this.closeSocket(params.connectorId, 4000, "Disconnected from Termes workspace");
      await this.markConnectorOffline(params.connectorId, row.device_id);
      return reply.code(204).send();
    });

    app.delete("/api/desktop-connectors/:connectorId", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const params = connectorParamsSchema.parse(request.params);
      const client = await this.deps.db.pool.connect();
      let revoked: { id: string; device_id: string; project_id: string } | undefined;
      try {
        await client.query("begin");
        const result = await client.query<{ id: string; device_id: string; project_id: string }>(
          `
            update desktop_connectors
            set status = 'revoked', revoked_at = now(), disconnected_at = now(), updated_at = now()
            where id = $1 and account_id = $2 and workspace_id = $3 and revoked_at is null
            returning id, device_id, project_id
          `,
          [params.connectorId, principal.accountId, principal.workspaceId],
        );
        revoked = result.rows[0];
        if (revoked) {
          await client.query("update devices set status = 'offline', updated_at = now() where id = $1", [revoked.device_id]);
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      if (!revoked) return reply.code(404).send({ error: "Desktop connector not found" });
      this.closeSocket(params.connectorId, 4001, "Connector access revoked");
      await appendEvent(this.deps.db.pool, this.deps.redis, {
        projectId: revoked.project_id,
        type: "device.connector.revoked",
        payload: { connectorId: revoked.id, deviceId: revoked.device_id },
      });
      return reply.code(204).send();
    });

    app.get("/api/desktop-artifacts/:artifactId", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const params = artifactParamsSchema.parse(request.params);
      const result = await this.deps.db.pool.query<{
        uri: string;
        metadata: Record<string, unknown>;
      }>(
        `
          select a.uri, a.metadata
          from artifacts a
          join projects p on p.id = a.project_id and p.workspace_id = a.workspace_id
          join project_members pm on pm.project_id = p.id and pm.user_id = $2
          where a.id = $1 and a.account_id = $2 and a.workspace_id = $3
        `,
        [params.artifactId, principal.accountId, principal.workspaceId],
      );
      const artifact = result.rows[0];
      const storagePath = artifact?.metadata?.storagePath;
      const mimeType = artifact?.metadata?.mimeType;
      if (!artifact || typeof storagePath !== "string" || typeof mimeType !== "string") {
        return reply.code(404).send({ error: "Artifact not found" });
      }
      const resolvedRoot = path.resolve(this.deps.artifactRoot);
      const resolvedPath = path.resolve(storagePath);
      if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return reply.code(404).send({ error: "Artifact not found" });
      }
      const content = await readFile(resolvedPath);
      return reply.type(mimeType).header("cache-control", "private, no-store").send(content);
    });

    app.get("/api/desktop-connectors/connect", { websocket: true }, (socket, request) => {
      void this.acceptSocket(socket as unknown as ConnectorSocket, request).catch(() => {
        (socket as unknown as ConnectorSocket).close(4401, "Connector authentication failed");
      });
    });
  }

  async executeCommand(input: DesktopCommandRequest): Promise<DesktopCommandResult> {
    const connectorResult = await this.deps.db.pool.query<{
      id: string;
      device_id: string;
      status: DesktopConnectorStatus;
      revoked_at: Date | null;
    }>(
      `
        select id, device_id, status, revoked_at
        from desktop_connectors
        where device_id = $1
        order by created_at desc
        limit 1
      `,
      [input.deviceId],
    );
    const connector = connectorResult.rows[0];
    if (!connector || connector.revoked_at) throw new Error("desktop_connector_not_paired");
    const socket = this.sockets.get(connector.id);
    if (!socket || socket.readyState !== 1) throw new Error("desktop_connector_offline");
    if (this.activeByConnector.has(connector.id)) throw new Error("desktop_connector_busy");

    const sequenceResult = await this.deps.db.pool.query<{ command_sequence: string | number }>(
      `
        update desktop_connectors
        set command_sequence = command_sequence + 1, status = 'busy', updated_at = now()
        where id = $1 and revoked_at is null
        returning command_sequence
      `,
      [connector.id],
    );
    const sequence = Number(sequenceResult.rows[0]?.command_sequence || 0);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("desktop_connector_sequence_failed");
    const digest = requestDigest(input, sequence);
    await this.deps.db.pool.query(
      `
        insert into desktop_connector_receipts (
          connector_id, device_command_id, sequence, request_hash, state
        ) values ($1, $2, $3, $4, 'dispatched')
        on conflict (device_command_id) do nothing
      `,
      [connector.id, input.commandId, sequence, digest],
    );

    this.activeByConnector.set(connector.id, input.commandId);
    socket.send(JSON.stringify({
      type: "command",
      protocolVersion,
      commandId: input.commandId,
      sequence,
      action: input.action,
      params: input.params,
      deadline: new Date(Date.now() + input.timeoutMs).toISOString(),
      requestHash: digest,
    }));

    return await new Promise<DesktopCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.commandId);
        this.activeByConnector.delete(connector.id);
        void this.deps.db.pool.query(
          "update desktop_connector_receipts set state = 'unknown', completed_at = now(), updated_at = now() where device_command_id = $1",
          [input.commandId],
        );
        void this.deps.db.pool.query(
          "update desktop_connectors set status = 'online', updated_at = now() where id = $1 and revoked_at is null",
          [connector.id],
        );
        resolve({
          status: "unknown",
          stdout: "",
          stderr: "Connector command timed out; execution outcome is unknown",
          exitCode: null,
          artifactUri: null,
          startedAt: new Date(Date.now() - input.timeoutMs).toISOString(),
          completedAt: new Date().toISOString(),
        });
      }, input.timeoutMs + 2_000);
      this.pending.set(input.commandId, { connectorId: connector.id, sequence, timer, resolve });
    });
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const connectorId of this.sockets.keys()) this.closeSocket(connectorId, 1001, "Termes API shutting down");
    for (const commandId of this.pending.keys()) this.settleUnknown(commandId, "Connector service shutting down");
  }

  private async acceptSocket(socket: ConnectorSocket, request: FastifyRequest): Promise<void> {
    const query = connectQuerySchema.parse(request.query);
    const token = websocketBearerToken(request);
    if (!token || token.length < 32 || token.length > 256) throw new Error("connector_authentication_required");
    const connectorResult = await this.deps.db.pool.query<ConnectorRow>(
      `
        select dc.*, p.name as project_name, aw.key as workspace_key
        from desktop_connectors dc
        join projects p on p.id = dc.project_id and p.workspace_id = dc.workspace_id
        join account_workspaces aw on aw.id = dc.workspace_id and aw.account_id = dc.account_id
        where dc.id = $1 and dc.token_hash = $2 and dc.revoked_at is null
      `,
      [query.connectorId, hashDesktopSecret(token)],
    );
    const connector = connectorResult.rows[0];
    if (!connector) throw new Error("connector_authentication_failed");

    this.closeSocket(connector.id, 4002, "A newer connector session replaced this connection");
    this.sockets.set(connector.id, socket);
    await this.deps.db.pool.query(
      `
        update desktop_connectors
        set status = 'connecting', last_connected_at = now(), last_heartbeat_at = now(),
            disconnected_at = null, updated_at = now()
        where id = $1
      `,
      [connector.id],
    );
    await this.deps.db.pool.query(
      "update devices set status = 'online', last_seen_at = now(), updated_at = now() where id = $1",
      [connector.device_id],
    );

    socket.on("message", (data) => {
      const text = socketText(data);
      if (!text || text.length > maximumArtifactBytes * 2 + 524_288) {
        socket.close(4400, "Invalid connector message");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        socket.close(4400, "Invalid connector JSON");
        return;
      }
      const message = connectorMessageSchema.safeParse(parsed);
      if (!message.success) {
        socket.close(4400, "Invalid connector protocol message");
        return;
      }
      void this.handleMessage(connector, socket, message.data).catch(() => {
        socket.close(1011, "Connector message processing failed");
      });
    });
    socket.on("close", () => {
      if (this.sockets.get(connector.id) !== socket) return;
      this.sockets.delete(connector.id);
      const activeCommand = this.activeByConnector.get(connector.id);
      if (activeCommand) this.settleUnknown(activeCommand, "Connector disconnected before returning a result");
      void this.markConnectorOffline(connector.id, connector.device_id);
      void appendEvent(this.deps.db.pool, this.deps.redis, {
        projectId: connector.project_id,
        type: "device.connector.disconnected",
        payload: { connectorId: connector.id, deviceId: connector.device_id },
      });
    });
    socket.on("error", () => undefined);
    socket.send(JSON.stringify({
      type: "connected",
      protocolVersion,
      connectorId: connector.id,
      deviceId: connector.device_id,
      workspaceId: connector.workspace_id,
      workspaceKey: connector.workspace_key,
      projectId: connector.project_id,
      projectName: connector.project_name,
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs: 10_000,
    }));
  }

  private async handleMessage(
    connector: ConnectorRow,
    socket: ConnectorSocket,
    message: z.infer<typeof connectorMessageSchema>,
  ): Promise<void> {
    if (this.sockets.get(connector.id) !== socket) return;
    if (message.type === "hello") {
      if (message.protocolVersion !== protocolVersion) {
        socket.close(4406, "Unsupported connector protocol version");
        return;
      }
      await this.deps.db.pool.query(
        `
          update desktop_connectors
          set status = 'online', protocol_version = $2, app_version = $3,
              capabilities = $4::jsonb, permissions = $5::jsonb,
              last_heartbeat_at = now(), updated_at = now()
          where id = $1 and revoked_at is null
        `,
        [connector.id, message.protocolVersion, message.appVersion, JSON.stringify(message.capabilities), JSON.stringify(message.permissions)],
      );
      await appendEvent(this.deps.db.pool, this.deps.redis, {
        projectId: connector.project_id,
        type: "device.connector.connected",
        payload: { connectorId: connector.id, deviceId: connector.device_id, platform: connector.platform },
      });
      socket.send(JSON.stringify({ type: "ready", serverTime: new Date().toISOString() }));
      return;
    }
    if (message.type === "heartbeat") {
      await this.deps.db.pool.query(
        `
          update desktop_connectors
          set status = case when status = 'busy' then 'busy' else 'online' end,
              capabilities = coalesce($2::jsonb, capabilities),
              permissions = coalesce($3::jsonb, permissions),
              last_heartbeat_at = now(), updated_at = now()
          where id = $1 and revoked_at is null
        `,
        [
          connector.id,
          message.capabilities ? JSON.stringify(message.capabilities) : null,
          message.permissions ? JSON.stringify(message.permissions) : null,
        ],
      );
      await this.deps.db.pool.query(
        "update devices set status = 'online', last_seen_at = now(), updated_at = now() where id = $1",
        [connector.device_id],
      );
      socket.send(JSON.stringify({ type: "heartbeat.ack", serverTime: new Date().toISOString() }));
      return;
    }
    if (message.type === "command.ack") {
      const pending = this.pending.get(message.commandId);
      if (!pending || pending.connectorId !== connector.id || pending.sequence !== message.sequence) return;
      await this.deps.db.pool.query(
        `
          update desktop_connector_receipts
          set state = $2, acknowledged_at = $3::timestamptz,
              result = case when $4::text is null then result else jsonb_build_object('reason', $4::text) end,
              updated_at = now()
          where device_command_id = $1 and sequence = $5
        `,
        [message.commandId, message.accepted ? "acknowledged" : "refused", message.acknowledgedAt, message.reason ?? null, message.sequence],
      );
      if (!message.accepted) {
        this.settle(message.commandId, {
          status: "failed",
          stdout: "",
          stderr: message.reason || "Connector refused the command",
          exitCode: 126,
          artifactUri: null,
          startedAt: message.acknowledgedAt,
          completedAt: new Date().toISOString(),
        });
      }
      return;
    }
    const pending = this.pending.get(message.commandId);
    if (!pending || pending.connectorId !== connector.id || pending.sequence !== message.sequence) return;
    let artifactUri: string | null = null;
    if (message.artifact) {
      artifactUri = await this.storeArtifact(connector, message.commandId, message.artifact);
    }
    const status: DeviceCommandStatus = message.status === "refused" ? "failed" : message.status;
    const receiptState = message.status === "refused" ? "refused" : message.status;
    await this.deps.db.pool.query(
      `
        update desktop_connector_receipts
        set state = $2, completed_at = $3::timestamptz,
            result = $4::jsonb, updated_at = now()
        where device_command_id = $1 and sequence = $5
      `,
      [
        message.commandId,
        receiptState,
        message.completedAt,
        JSON.stringify({
          status: message.status,
          exitCode: message.exitCode ?? null,
          artifactUri,
          stdoutBytes: Buffer.byteLength(message.stdout || ""),
          stderrBytes: Buffer.byteLength(message.stderr || ""),
        }),
        message.sequence,
      ],
    );
    this.settle(message.commandId, {
      status,
      stdout: message.stdout || "",
      stderr: message.stderr || "",
      exitCode: message.exitCode ?? null,
      artifactUri,
      startedAt: message.startedAt || message.completedAt,
      completedAt: message.completedAt,
    });
  }

  private async storeArtifact(
    connector: ConnectorRow,
    commandId: string,
    artifact: z.infer<typeof artifactSchema>,
  ): Promise<string> {
    const content = Buffer.from(artifact.base64, "base64");
    if (content.length < 1 || content.length > maximumArtifactBytes) throw new Error("desktop_artifact_size_invalid");
    const checksum = createHash("sha256").update(content).digest("hex");
    if (checksum !== artifact.sha256) throw new Error("desktop_artifact_checksum_mismatch");
    const artifactId = randomUUID();
    const relative = path.join(
      connector.account_id,
      connector.workspace_id,
      connector.project_id,
      connector.device_id,
      commandId,
      `${artifactId}${artifactExtension(artifact.mimeType)}`,
    );
    const storagePath = path.resolve(this.deps.artifactRoot, relative);
    const root = path.resolve(this.deps.artifactRoot);
    if (!storagePath.startsWith(`${root}${path.sep}`)) throw new Error("desktop_artifact_path_invalid");
    await mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${storagePath}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
    const uri = `/api/desktop-artifacts/${artifactId}`;
    const client = await this.deps.db.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query<{ id: string }>(
        `
          insert into artifacts (
            id, account_id, workspace_id, project_id, task_id, kind, uri, checksum, metadata
          )
          select $1, $2, $3, $4, dc.task_id, 'desktop.connector', $5, $6, $7::jsonb
          from device_commands dc
          where dc.id = $8 and dc.device_id = $9 and dc.project_id = $4
          returning id
        `,
        [
          artifactId,
          connector.account_id,
          connector.workspace_id,
          connector.project_id,
          uri,
          checksum,
          JSON.stringify({
            ...artifact.metadata,
            storagePath,
            mimeType: artifact.mimeType,
            byteSize: content.length,
            desktopConnectorId: connector.id,
            deviceId: connector.device_id,
            deviceCommandId: commandId,
          }),
          commandId,
          connector.device_id,
        ],
      );
      if (!inserted.rows[0]) throw new Error("desktop_artifact_command_scope_invalid");
      await rename(temporaryPath, storagePath);
      await client.query("commit");
      return uri;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await Promise.all([
        rm(temporaryPath, { force: true }).catch(() => undefined),
        rm(storagePath, { force: true }).catch(() => undefined),
      ]);
      throw error;
    } finally {
      client.release();
    }
  }

  private settle(commandId: string, result: DesktopCommandResult): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    this.activeByConnector.delete(pending.connectorId);
    void this.deps.db.pool.query(
      "update desktop_connectors set status = 'online', updated_at = now() where id = $1 and revoked_at is null",
      [pending.connectorId],
    );
    pending.resolve(result);
  }

  private settleUnknown(commandId: string, reason: string): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    void this.deps.db.pool.query(
      "update desktop_connector_receipts set state = 'unknown', completed_at = now(), result = $2::jsonb, updated_at = now() where device_command_id = $1",
      [commandId, JSON.stringify({ reason })],
    );
    this.settle(commandId, {
      status: "unknown",
      stdout: "",
      stderr: reason,
      exitCode: null,
      artifactUri: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
  }

  private closeSocket(connectorId: string, code: number, reason: string): void {
    const socket = this.sockets.get(connectorId);
    if (!socket) return;
    this.sockets.delete(connectorId);
    socket.close(code, reason);
  }

  private async ownedConnector(connectorId: string, principal: AccountPrincipal): Promise<{ device_id: string } | null> {
    const result = await this.deps.db.pool.query<{ device_id: string }>(
      `
        select device_id
        from desktop_connectors
        where id = $1 and account_id = $2 and workspace_id = $3 and revoked_at is null
      `,
      [connectorId, principal.accountId, principal.workspaceId],
    );
    return result.rows[0] || null;
  }

  private async markConnectorOffline(connectorId: string, deviceId: string): Promise<void> {
    await Promise.all([
      this.deps.db.pool.query(
        `
          update desktop_connectors
          set status = case when revoked_at is null then 'offline' else 'revoked' end,
              disconnected_at = now(), updated_at = now()
          where id = $1
        `,
        [connectorId],
      ),
      this.deps.db.pool.query("update devices set status = 'offline', updated_at = now() where id = $1", [deviceId]),
    ]);
  }

  private async markStaleConnectorsOffline(): Promise<void> {
    const stale = await this.deps.db.pool.query<{ id: string; device_id: string }>(
      `
        update desktop_connectors
        set status = 'offline', disconnected_at = coalesce(disconnected_at, now()), updated_at = now()
        where revoked_at is null
          and status in ('connecting', 'online', 'busy')
          and coalesce(last_heartbeat_at, last_connected_at, created_at) < now() - interval '35 seconds'
        returning id, device_id
      `,
    );
    for (const row of stale.rows) {
      if (this.sockets.has(row.id)) this.closeSocket(row.id, 4008, "Connector heartbeat expired");
      await this.deps.db.pool.query("update devices set status = 'offline', updated_at = now() where id = $1", [row.device_id]);
      const activeCommand = this.activeByConnector.get(row.id);
      if (activeCommand) this.settleUnknown(activeCommand, "Connector heartbeat expired while command was active");
    }
  }
}

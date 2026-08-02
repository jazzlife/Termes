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
  workspace_id: string | null;
  project_id: string | null;
  project_name: string | null;
  workspace_key: string | null;
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

type ConnectorSession = {
  socket: ConnectorSocket;
  credentialVersion: number;
  active: boolean;
  messageChain: Promise<void>;
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
  credentialVersion: number;
  sequence: number;
  timer: NodeJS.Timeout;
  processingResult: boolean;
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
    accountId: row.account_id,
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
  private readonly sockets = new Map<string, ConnectorSession>();
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
          where state in ('dispatched', 'acknowledged', 'processing')
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
      let rotatedConnectorId: string | null = null;
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

        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${pairing.account_id}:${input.machineFingerprint}`,
        ]);
        const priorResult = await client.query<{ id: string; device_id: string }>(
          `
            select id, device_id
            from desktop_connectors
            where account_id = $1 and machine_fingerprint = $2
            order by (revoked_at is null) desc, updated_at desc, created_at desc
            limit 1
            for update
          `,
          [pairing.account_id, input.machineFingerprint],
        );
        const prior = priorResult.rows[0];
        let deviceId: string;
        if (prior) {
          deviceId = prior.device_id;
          await client.query(
            `
              update devices
              set account_id = $2, project_id = null, key = $3, name = $4, platform = $5,
                  transport = 'connector', endpoint = null, labels = $6::jsonb,
                  status = 'offline', updated_at = now()
              where id = $1
            `,
            [
              deviceId,
              pairing.account_id,
              machineDeviceKey(input.platform, input.machineFingerprint),
              input.name,
              input.platform,
              JSON.stringify({ source: "desktop-connector", appVersion: input.appVersion }),
            ],
          );
        } else {
          const deviceResult = await client.query<{ id: string }>(
            `
              insert into devices (account_id, project_id, key, name, platform, transport, endpoint, labels, status)
              values ($1, null, $2, $3, $4, 'connector', null, $5::jsonb, 'offline')
              returning id
            `,
            [
              pairing.account_id,
              machineDeviceKey(input.platform, input.machineFingerprint),
              input.name,
              input.platform,
              JSON.stringify({ source: "desktop-connector", appVersion: input.appVersion }),
            ],
          );
          deviceId = deviceResult.rows[0]?.id || "";
          if (!deviceId) throw new Error("Desktop device insert did not return an id");
        }

        const deviceToken = randomBytes(32).toString("base64url");
        let connectorId: string;
        if (prior) {
          connectorId = prior.id;
          rotatedConnectorId = connectorId;
          await client.query(
            `
              update desktop_connectors
              set account_id = $2,
                  workspace_id = null,
                  project_id = null,
                  device_id = $3,
                  name = $4,
                  platform = $5,
                  public_key = $6,
                  token_hash = $7,
                  credential_version = credential_version + 1,
                  protocol_version = $8,
                  app_version = $9,
                  capabilities = $10::jsonb,
                  permissions = $11::jsonb,
                  status = 'offline',
                  revoked_at = null,
                  disconnected_at = now(),
                  updated_at = now()
              where id = $1
            `,
            [
              connectorId,
              pairing.account_id,
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
        } else {
          const connectorResult = await client.query<{ id: string }>(
            `
              insert into desktop_connectors (
                account_id, device_id, name, platform,
                machine_fingerprint, public_key, token_hash, protocol_version,
                app_version, capabilities, permissions
              ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
              returning id
            `,
            [
              pairing.account_id,
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
      if (rotatedConnectorId) {
        this.closeSocket(rotatedConnectorId, 4002, "Connector credentials rotated by a new pairing");
      }
      await appendEvent(this.deps.db.pool, this.deps.redis, {
        projectId: eventProjectId,
        type: "device.connector.paired",
        payload: { connectorId: result.connectorId, deviceId: result.deviceId, platform: input.platform },
      });
      return reply.code(201).send(result);
    });

    app.get("/api/desktop-connectors", async (request) => {
      const principal = this.deps.principalForRequest(request);
      listConnectorsSchema.parse(request.query);
      const connectors = await this.deps.db.pool.query<ConnectorRow>(
        `
          select dc.*, null::text as project_name, null::text as workspace_key
          from desktop_connectors dc
          join devices d on d.id = dc.device_id and d.account_id = dc.account_id
          where dc.account_id = $1
          order by dc.updated_at desc, dc.created_at desc
        `,
        [principal.accountId],
      );
      return { connectors: connectors.rows.map(mapConnector) };
    });

    app.post("/api/desktop-connectors/:connectorId/disconnect", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const params = connectorParamsSchema.parse(request.params);
      const row = await this.ownedConnector(params.connectorId, principal);
      if (!row) return reply.code(404).send({ error: "Desktop connector not found" });
      this.closeSocket(params.connectorId, 4000, "Disconnected from Termes account");
      await this.markConnectorOffline(params.connectorId, row.device_id);
      return reply.code(204).send();
    });

    app.delete("/api/desktop-connectors/:connectorId", async (request, reply) => {
      const principal = this.deps.principalForRequest(request);
      const params = connectorParamsSchema.parse(request.params);
      const client = await this.deps.db.pool.connect();
      let revoked: { id: string; device_id: string; project_id: string | null } | undefined;
      try {
        await client.query("begin");
        const result = await client.query<{ id: string; device_id: string; project_id: string | null }>(
          `
            update desktop_connectors
            set status = 'revoked', revoked_at = now(), disconnected_at = now(), updated_at = now()
            where id = $1 and account_id = $2 and revoked_at is null
            returning id, device_id, project_id
          `,
          [params.connectorId, principal.accountId],
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
      credential_version: number;
      revoked_at: Date | null;
    }>(
      `
        select connector.id, connector.device_id, connector.status,
               connector.credential_version, connector.revoked_at
        from desktop_connectors connector
        join device_commands command
          on command.id = $2
         and command.device_id = connector.device_id
         and command.account_id = connector.account_id
        where connector.device_id = $1 and connector.revoked_at is null
        order by connector.created_at desc
        limit 1
      `,
      [input.deviceId, input.commandId],
    );
    const connector = connectorResult.rows[0];
    if (!connector || connector.revoked_at) throw new Error("desktop_connector_not_paired");
    const session = this.sockets.get(connector.id);
    if (!session?.active || session.socket.readyState !== 1) throw new Error("desktop_connector_offline");
    if (session.credentialVersion !== connector.credential_version) {
      this.closeSocket(connector.id, 4002, "Connector credentials expired");
      throw new Error("desktop_connector_credential_expired");
    }
    if (this.activeByConnector.has(connector.id)) throw new Error("desktop_connector_busy");

    const client = await this.deps.db.pool.connect();
    let sequence = 0;
    let digest = "";
    let committed = false;
    try {
      await client.query("begin");
      const sequenceResult = await client.query<{ command_sequence: string | number }>(
        `
          update desktop_connectors
          set command_sequence = command_sequence + 1, status = 'busy', updated_at = now()
          where id = $1
            and credential_version = $2
            and revoked_at is null
            and status = 'online'
          returning command_sequence
        `,
        [connector.id, session.credentialVersion],
      );
      sequence = Number(sequenceResult.rows[0]?.command_sequence || 0);
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("desktop_connector_busy");
      digest = requestDigest(input, sequence);
      const receipt = await client.query<{ device_command_id: string }>(
        `
          insert into desktop_connector_receipts (
            connector_id, device_command_id, sequence, request_hash, state
          ) values ($1, $2, $3, $4, 'dispatched')
          on conflict (device_command_id) do nothing
          returning device_command_id
        `,
        [connector.id, input.commandId, sequence, digest],
      );
      if (!receipt.rows[0]) throw new Error("desktop_connector_command_already_dispatched");
      await client.query("commit");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return await new Promise<DesktopCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        void this.timeoutCommand(input.commandId, input.timeoutMs);
      }, input.timeoutMs + 2_000);
      this.pending.set(input.commandId, {
        connectorId: connector.id,
        credentialVersion: session.credentialVersion,
        sequence,
        timer,
        processingResult: false,
        resolve,
      });
      this.activeByConnector.set(connector.id, input.commandId);
      const currentSession = this.sockets.get(connector.id);
      if (
        currentSession !== session
        || !currentSession.active
        || currentSession.credentialVersion !== connector.credential_version
        || currentSession.socket.readyState !== 1
      ) {
        this.settleUnknown(input.commandId, "Connector session changed before command dispatch");
        return;
      }
      try {
        currentSession.socket.send(JSON.stringify({
          type: "command",
          protocolVersion,
          commandId: input.commandId,
          sequence,
          action: input.action,
          params: input.params,
          deadline: new Date(Date.now() + input.timeoutMs).toISOString(),
          requestHash: digest,
        }));
      } catch {
        this.settleUnknown(input.commandId, "Connector disconnected before command dispatch");
      }
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
    const tokenHash = hashDesktopSecret(token);
    const connectorResult = await this.deps.db.pool.query<ConnectorRow>(
      `
        select dc.*, null::text as project_name, null::text as workspace_key
        from desktop_connectors dc
        join devices d on d.id = dc.device_id and d.account_id = dc.account_id
        where dc.id = $1 and dc.token_hash = $2 and dc.revoked_at is null
      `,
      [query.connectorId, tokenHash],
    );
    const connector = connectorResult.rows[0];
    if (!connector) throw new Error("connector_authentication_failed");

    const activated = await this.deps.db.pool.query<{ id: string }>(
      `
        update desktop_connectors
        set status = 'connecting', last_connected_at = now(), last_heartbeat_at = now(),
            disconnected_at = null, updated_at = now()
        where id = $1
          and token_hash = $2
          and credential_version = $3
          and revoked_at is null
        returning id
      `,
      [connector.id, tokenHash, connector.credential_version],
    );
    if (!activated.rows[0]) throw new Error("connector_authentication_expired");

    this.closeSocket(connector.id, 4002, "A newer connector session replaced this connection");
    const session: ConnectorSession = {
      socket,
      credentialVersion: connector.credential_version,
      active: false,
      messageChain: Promise.resolve(),
    };
    this.sockets.set(connector.id, session);
    const confirmed = await this.deps.db.pool.query<{ id: string }>(
      `
        select id
        from desktop_connectors
        where id = $1
          and token_hash = $2
          and credential_version = $3
          and revoked_at is null
      `,
      [connector.id, tokenHash, connector.credential_version],
    );
    if (!confirmed.rows[0] || this.sockets.get(connector.id) !== session || socket.readyState !== 1) {
      if (this.sockets.get(connector.id) === session) this.sockets.delete(connector.id);
      socket.close(4401, "Connector authentication expired");
      throw new Error("connector_authentication_expired");
    }
    session.active = true;
    await this.deps.db.pool.query(
      `
        update devices d
        set status = 'online', last_seen_at = now(), updated_at = now()
        where d.id = $1
          and exists (
            select 1
            from desktop_connectors dc
            where dc.id = $2
              and dc.device_id = d.id
              and dc.credential_version = $3
              and dc.revoked_at is null
          )
      `,
      [connector.device_id, connector.id, connector.credential_version],
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
      session.messageChain = session.messageChain
        .then(() => this.handleMessage(connector, session, message.data))
        .catch(() => {
          socket.close(1011, "Connector message processing failed");
        });
    });
    socket.on("close", () => {
      if (this.sockets.get(connector.id) !== session) return;
      this.sockets.delete(connector.id);
      const activeCommand = this.activeByConnector.get(connector.id);
      if (activeCommand) this.settleUnknown(activeCommand, "Connector disconnected before returning a result");
      void this.markConnectorOffline(connector.id, connector.device_id);
    });
    socket.on("error", () => undefined);
    socket.send(JSON.stringify({
      type: "connected",
      protocolVersion,
      connectorId: connector.id,
      deviceId: connector.device_id,
      accountId: connector.account_id,
      scope: "account",
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs: 10_000,
    }));
  }

  private async handleMessage(
    connector: ConnectorRow,
    session: ConnectorSession,
    message: z.infer<typeof connectorMessageSchema>,
  ): Promise<void> {
    if (this.sockets.get(connector.id) !== session || !session.active) return;
    const authorized = await this.deps.db.pool.query<{ id: string }>(
      `
        select id
        from desktop_connectors
        where id = $1 and credential_version = $2 and revoked_at is null
      `,
      [connector.id, session.credentialVersion],
    );
    if (!authorized.rows[0]) {
      this.closeSocket(connector.id, 4002, "Connector credentials expired");
      return;
    }
    if (this.sockets.get(connector.id) !== session || !session.active) return;
    const socket = session.socket;
    if (message.type === "hello") {
      if (message.protocolVersion !== protocolVersion) {
        socket.close(4406, "Unsupported connector protocol version");
        return;
      }
      await this.deps.db.pool.query(
        `
          update desktop_connectors
          set status = 'online', protocol_version = $3, app_version = $4,
              capabilities = $5::jsonb, permissions = $6::jsonb,
              last_heartbeat_at = now(), updated_at = now()
          where id = $1 and credential_version = $2 and revoked_at is null
        `,
        [
          connector.id,
          session.credentialVersion,
          message.protocolVersion,
          message.appVersion,
          JSON.stringify(message.capabilities),
          JSON.stringify(message.permissions),
        ],
      );
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
          where id = $1 and credential_version = $4 and revoked_at is null
        `,
        [
          connector.id,
          message.capabilities ? JSON.stringify(message.capabilities) : null,
          message.permissions ? JSON.stringify(message.permissions) : null,
          session.credentialVersion,
        ],
      );
      await this.deps.db.pool.query(
        `
          update devices d
          set status = 'online', last_seen_at = now(), updated_at = now()
          where d.id = $1
            and exists (
              select 1
              from desktop_connectors dc
              where dc.id = $2
                and dc.device_id = d.id
                and dc.credential_version = $3
                and dc.revoked_at is null
            )
        `,
        [connector.device_id, connector.id, session.credentialVersion],
      );
      socket.send(JSON.stringify({ type: "heartbeat.ack", serverTime: new Date().toISOString() }));
      return;
    }
    if (message.type === "command.ack") {
      const pending = this.pending.get(message.commandId);
      if (
        !pending
        || pending.processingResult
        || pending.connectorId !== connector.id
        || pending.sequence !== message.sequence
      ) return;
      const acknowledged = await this.deps.db.pool.query<{ id: string }>(
        `
          update desktop_connector_receipts receipt
          set state = $2, acknowledged_at = $3::timestamptz,
              result = case when $4::text is null then result else jsonb_build_object('reason', $4::text) end,
              updated_at = now()
          from desktop_connectors active_connector
          where receipt.device_command_id = $1
            and receipt.sequence = $5
            and receipt.state = 'dispatched'
            and active_connector.id = receipt.connector_id
            and active_connector.id = $6
            and active_connector.credential_version = $7
            and active_connector.revoked_at is null
          returning receipt.id
        `,
        [
          message.commandId,
          message.accepted ? "acknowledged" : "refused",
          message.acknowledgedAt,
          message.reason ?? null,
          message.sequence,
          connector.id,
          session.credentialVersion,
        ],
      );
      if (!acknowledged.rows[0]) return;
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
    if (
      !pending
      || pending.processingResult
      || pending.connectorId !== connector.id
      || pending.sequence !== message.sequence
    ) return;
    pending.processingResult = true;
    clearTimeout(pending.timer);
    let claimedRows: Array<{ id: string }>;
    try {
      const claimed = await this.deps.db.pool.query<{ id: string }>(
        `
          update desktop_connector_receipts receipt
          set state = 'processing', updated_at = now()
          from desktop_connectors active_connector
          where receipt.device_command_id = $1
            and receipt.sequence = $2
            and receipt.state in ('dispatched', 'acknowledged')
            and active_connector.id = receipt.connector_id
            and active_connector.id = $3
            and active_connector.credential_version = $4
            and active_connector.revoked_at is null
          returning receipt.id
        `,
        [message.commandId, message.sequence, connector.id, session.credentialVersion],
      );
      claimedRows = claimed.rows;
    } catch (error) {
      pending.processingResult = false;
      this.settleUnknown(message.commandId, "Connector result claim failed");
      throw error;
    }
    if (!claimedRows[0]) {
      pending.processingResult = false;
      this.settleUnknown(message.commandId, "Connector result arrived after command settlement");
      return;
    }
    const status: DeviceCommandStatus = message.status === "refused" ? "failed" : message.status;
    const receiptState = message.status === "refused" ? "refused" : message.status;
    let artifactUri: string | null = null;
    try {
      if (message.artifact) {
        artifactUri = await this.storeArtifact(
          connector,
          session.credentialVersion,
          message.commandId,
          message.artifact,
          {
            state: receiptState,
            completedAt: message.completedAt,
            sequence: message.sequence,
            status: message.status,
            exitCode: message.exitCode ?? null,
            stdoutBytes: Buffer.byteLength(message.stdout || ""),
            stderrBytes: Buffer.byteLength(message.stderr || ""),
          },
        );
      } else {
        const persisted = await this.deps.db.pool.query<{ id: string }>(
          `
            update desktop_connector_receipts receipt
            set state = $2, completed_at = $3::timestamptz,
                result = $4::jsonb, updated_at = now()
            from desktop_connectors active_connector
            where receipt.device_command_id = $1
              and receipt.sequence = $5
              and receipt.state = 'processing'
              and active_connector.id = receipt.connector_id
              and active_connector.id = $6
              and active_connector.credential_version = $7
              and active_connector.revoked_at is null
            returning receipt.id
          `,
          [
            message.commandId,
            receiptState,
            message.completedAt,
            JSON.stringify({
              status: message.status,
              exitCode: message.exitCode ?? null,
              artifactUri: null,
              stdoutBytes: Buffer.byteLength(message.stdout || ""),
              stderrBytes: Buffer.byteLength(message.stderr || ""),
            }),
            message.sequence,
            connector.id,
            session.credentialVersion,
          ],
        );
        if (!persisted.rows[0]) {
          pending.processingResult = false;
          this.settleUnknown(message.commandId, "Connector credentials changed while processing the result");
          return;
        }
      }
      this.settle(message.commandId, {
        status,
        stdout: message.stdout || "",
        stderr: message.stderr || "",
        exitCode: message.exitCode ?? null,
        artifactUri,
        startedAt: message.startedAt || message.completedAt,
        completedAt: message.completedAt,
      });
    } catch (error) {
      pending.processingResult = false;
      this.settleUnknown(message.commandId, "Connector result processing failed");
      throw error;
    }
  }

  private async storeArtifact(
    connector: ConnectorRow,
    credentialVersion: number,
    commandId: string,
    artifact: z.infer<typeof artifactSchema>,
    completion: {
      state: string;
      completedAt: string;
      sequence: number;
      status: string;
      exitCode: number | null;
      stdoutBytes: number;
      stderrBytes: number;
    },
  ): Promise<string> {
    const content = Buffer.from(artifact.base64, "base64");
    if (content.length < 1 || content.length > maximumArtifactBytes) throw new Error("desktop_artifact_size_invalid");
    const checksum = createHash("sha256").update(content).digest("hex");
    if (checksum !== artifact.sha256) throw new Error("desktop_artifact_checksum_mismatch");
    const client = await this.deps.db.pool.connect();
    let temporaryPath: string | null = null;
    let storagePath: string | null = null;
    try {
      await client.query("begin");
      const authorized = await client.query<{ id: string }>(
        `
          select id
          from desktop_connectors
          where id = $1
            and account_id = $2
            and device_id = $3
            and credential_version = $4
            and revoked_at is null
          for update
        `,
        [connector.id, connector.account_id, connector.device_id, credentialVersion],
      );
      if (!authorized.rows[0]) throw new Error("desktop_connector_credential_expired");
      const commandScope = await client.query<{
        account_id: string;
        workspace_id: string;
        project_id: string;
        task_id: string | null;
      }>(
        `
          select account_id, workspace_id, project_id, task_id
          from device_commands
          where id = $1 and device_id = $2 and account_id = $3
        `,
        [commandId, connector.device_id, connector.account_id],
      );
      const scope = commandScope.rows[0];
      if (!scope) throw new Error("desktop_artifact_command_scope_invalid");
      const artifactId = randomUUID();
      const relative = path.join(
        scope.account_id,
        scope.workspace_id,
        scope.project_id,
        connector.device_id,
        commandId,
        `${artifactId}${artifactExtension(artifact.mimeType)}`,
      );
      storagePath = path.resolve(this.deps.artifactRoot, relative);
      const root = path.resolve(this.deps.artifactRoot);
      if (!storagePath.startsWith(`${root}${path.sep}`)) throw new Error("desktop_artifact_path_invalid");
      await mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
      temporaryPath = `${storagePath}.tmp-${randomUUID()}`;
      await writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
      const uri = `/api/desktop-artifacts/${artifactId}`;
      const inserted = await client.query<{ id: string }>(
        `
          insert into artifacts (
            id, account_id, workspace_id, project_id, task_id, kind, uri, checksum, metadata
          )
          select $1, dc.account_id, dc.workspace_id, dc.project_id, dc.task_id,
                 'desktop.connector', $2, $3, $4::jsonb
          from device_commands dc
          where dc.id = $5 and dc.device_id = $6 and dc.account_id = $7
          returning id
        `,
        [
          artifactId,
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
          connector.account_id,
        ],
      );
      if (!inserted.rows[0]) throw new Error("desktop_artifact_command_scope_invalid");
      const completed = await client.query<{ id: string }>(
        `
          update desktop_connector_receipts
          set state = $2,
              completed_at = $3::timestamptz,
              result = $4::jsonb,
              updated_at = now()
          where device_command_id = $1
            and connector_id = $5
            and sequence = $6
            and state = 'processing'
          returning id
        `,
        [
          commandId,
          completion.state,
          completion.completedAt,
          JSON.stringify({
            status: completion.status,
            exitCode: completion.exitCode,
            artifactUri: uri,
            stdoutBytes: completion.stdoutBytes,
            stderrBytes: completion.stderrBytes,
          }),
          connector.id,
          completion.sequence,
        ],
      );
      if (!completed.rows[0]) throw new Error("desktop_artifact_receipt_state_invalid");
      await rename(temporaryPath, storagePath);
      temporaryPath = null;
      await client.query("commit");
      return uri;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await Promise.all([
        temporaryPath ? rm(temporaryPath, { force: true }).catch(() => undefined) : Promise.resolve(),
        storagePath ? rm(storagePath, { force: true }).catch(() => undefined) : Promise.resolve(),
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
    if (this.activeByConnector.get(pending.connectorId) === commandId) {
      this.activeByConnector.delete(pending.connectorId);
    }
    void this.deps.db.pool.query(
      `
        update desktop_connectors
        set status = 'online', updated_at = now()
        where id = $1 and credential_version = $2 and revoked_at is null and status = 'busy'
      `,
      [pending.connectorId, pending.credentialVersion],
    );
    pending.resolve(result);
  }

  private async timeoutCommand(commandId: string, timeoutMs: number): Promise<void> {
    const pending = this.pending.get(commandId);
    if (!pending || pending.processingResult) return;
    try {
      const timedOut = await this.deps.db.pool.query<{ id: string }>(
        `
          update desktop_connector_receipts
          set state = 'unknown', completed_at = now(), updated_at = now()
          where device_command_id = $1
            and state in ('dispatched', 'acknowledged')
          returning id
        `,
        [commandId],
      );
      if (!timedOut.rows[0] || this.pending.get(commandId) !== pending) return;
      this.settle(commandId, {
        status: "unknown",
        stdout: "",
        stderr: "Connector command timed out; execution outcome is unknown",
        exitCode: null,
        artifactUri: null,
        startedAt: new Date(Date.now() - timeoutMs).toISOString(),
        completedAt: new Date().toISOString(),
      });
    } catch {
      this.settleUnknown(commandId, "Connector command timed out; execution outcome is unknown");
    }
  }

  private settleUnknown(commandId: string, reason: string): void {
    const pending = this.pending.get(commandId);
    if (!pending || pending.processingResult) return;
    void this.deps.db.pool.query(
      `
        update desktop_connector_receipts
        set state = 'unknown', completed_at = now(), result = $2::jsonb, updated_at = now()
        where device_command_id = $1
          and state in ('dispatched', 'acknowledged', 'processing')
      `,
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
    const session = this.sockets.get(connectorId);
    if (!session) return;
    this.sockets.delete(connectorId);
    session.active = false;
    session.socket.close(code, reason);
    const activeCommand = this.activeByConnector.get(connectorId);
    if (activeCommand) this.settleUnknown(activeCommand, reason);
  }

  private async ownedConnector(connectorId: string, principal: AccountPrincipal): Promise<{ device_id: string } | null> {
    const result = await this.deps.db.pool.query<{ device_id: string }>(
      `
        select device_id
        from desktop_connectors
        where id = $1 and account_id = $2 and revoked_at is null
      `,
      [connectorId, principal.accountId],
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

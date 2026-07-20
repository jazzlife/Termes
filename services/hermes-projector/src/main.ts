import { TERMES_VERSION } from "@termes/shared";
import { appendTransactionalEvent } from "@termes/eventing";
import Fastify from "fastify";
import Redis from "ioredis";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  applyMirroredFrame,
  compareRedisStreamIds,
  gatewayEventFromFrame,
  selectSpecialistCandidate,
  settleProjectionBatch,
  type MirroredFrame,
} from "./projector";
import type { RichStreamState } from "@termes/hermes-compat";

const STREAM = "termes.hermes.frames";
const GROUP = "termes-hermes-projector-v1";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function fieldRecord(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < fields.length; index += 2) {
    const key = fields[index];
    if (key) result[key] = fields[index + 1] || "";
  }
  return result;
}

function streamDate(id: string): Date {
  const millis = Number.parseInt(id.split("-")[0] || "", 10);
  if (!Number.isFinite(millis)) throw new Error(`Invalid Redis stream id: ${id}`);
  return new Date(millis);
}

async function syncSpecialistEvent(
  client: pg.PoolClient,
  taskId: string,
  hermesSessionId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!eventType.startsWith("subagent.")) return;
  const result = await client.query<{
    id: string;
    blueprint_id: string;
    role_name: string;
    status: "planned" | "running" | "completed" | "failed" | "cancelled";
    hermes_subagent_id: string | null;
  }>(
    `
      select sa.id, sa.blueprint_id, sa.role_name, sa.status, sa.hermes_subagent_id
      from specialist_assignments sa
      join orchestration_blueprints ob on ob.id = sa.blueprint_id
      where ob.turn_id = (
        select turn_id
        from runtime_sessions
        where task_id = $1 and hermes_live_session_id = $2
        order by updated_at desc
        limit 1
      )
      order by sa.created_at asc
      for update of sa
    `,
    [taskId, hermesSessionId],
  );
  const selected = selectSpecialistCandidate(
    result.rows.map((row) => ({
      id: row.id,
      roleName: row.role_name,
      status: row.status,
      hermesSubagentId: row.hermes_subagent_id,
    })),
    payload,
  );
  if (!selected) return;
  const row = result.rows.find((candidate) => candidate.id === selected.id)!;
  const childId = typeof payload.child_session_id === "string"
    ? payload.child_session_id
    : typeof payload.subagent_id === "string"
      ? payload.subagent_id
      : null;
  if (eventType === "subagent.complete") {
    const rawStatus = typeof payload.status === "string" ? payload.status : "completed";
    const completed = ["completed", "complete", "success", "ok"].includes(rawStatus);
    const summary = typeof payload.summary === "string"
      ? payload.summary
      : typeof payload.text === "string" ? payload.text : null;
    await client.query(
      `
        update specialist_assignments
        set status = $2, hermes_subagent_id = coalesce($3, hermes_subagent_id),
            result_summary = $4, completed_at = now(), updated_at = now()
        where id = $1
      `,
      [row.id, completed ? "completed" : "failed", childId, summary],
    );
  } else if (["subagent.start", "subagent.tool", "subagent.progress"].includes(eventType)) {
    await client.query(
      `
        update specialist_assignments
        set status = case when status = 'planned' then 'running' else status end,
            hermes_subagent_id = coalesce($2, hermes_subagent_id),
            started_at = coalesce(started_at, now()), updated_at = now()
        where id = $1
      `,
      [row.id, childId],
    );
  }
  await client.query(
    `
      update orchestration_blueprints ob
      set status = case
        when exists (select 1 from specialist_assignments where blueprint_id = ob.id and status = 'failed') then 'failed'
        when not exists (select 1 from specialist_assignments where blueprint_id = ob.id and status in ('planned', 'running')) then 'synthesizing'
        else 'delegating'
      end,
      updated_at = now()
      where ob.id = $1 and ob.status not in ('verified', 'failed')
    `,
    [row.blueprint_id],
  );
}

class ProjectorWorker {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private processed = 0;
  private readonly lastNotifiedAt = new Map<string, number>();
  private lastClaimAt = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly consumer: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  get processedFrames(): number { return this.processed; }

  async start(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    } catch (error) {
      if (!String(error).includes("BUSYGROUP")) throw error;
    }
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (Date.now() - this.lastClaimAt >= 10_000) {
          this.lastClaimAt = Date.now();
          const claimed = await this.redis.xautoclaim(
            STREAM, GROUP, this.consumer, 30_000, "0-0", "COUNT", 100,
          ) as unknown as [string, Array<[string, string[]]>, string[]?];
          if (claimed[1]?.length) {
            await this.persist(claimed[1]);
            continue;
          }
        }
        const response = await this.redis.xreadgroup(
          "GROUP", GROUP, this.consumer,
          "COUNT", 100,
          "BLOCK", 1000,
          "STREAMS", STREAM, ">",
        ) as unknown as Array<[string, Array<[string, string[]]>]> | null;
        const messages = response?.[0]?.[1] || [];
        if (messages.length) await this.persist(messages);
      } catch (error) {
        this.onError(error);
      }
    }
  }

  private async persist(messages: Array<[string, string[]]>): Promise<void> {
    const orderedMessages = [...messages].sort(([left], [right]) => compareRedisStreamIds(left, right));
    const prepared = orderedMessages.map(([redisStreamId, fields]) => {
      const record = fieldRecord(fields);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(record.frame || "") as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid mirrored Hermes JSON frame at ${redisStreamId}`);
      }
      if (!record.account_id) throw new Error(`Missing account_id at ${redisStreamId}`);
      if (!record.workspace_id) throw new Error(`Missing workspace_id at ${redisStreamId}`);
      return { redisStreamId, record, parsed };
    });
    const ownershipLocks = [...new Set(
      prepared.map(({ record }) => `termes.hermes-projector.v1:${record.account_id}:${record.workspace_id}`),
    )].sort();
    const client = await this.pool.connect();
    const nextStates = new Map<string, { frame: MirroredFrame; state: RichStreamState; eventType: string }>();
    const loadedKeys = new Set<string>();
    const currentStates = new Map<string, RichStreamState | null>();
    const latestStreamIds = new Map<string, string>();
    const ackIds: string[] = [];
    const notifiedKeys: string[] = [];
    try {
      await client.query("begin");
      for (const ownershipLock of ownershipLocks) {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ownershipLock]);
      }
      for (const { redisStreamId, record, parsed } of prepared) {
        const frame: MirroredFrame = {
          redisStreamId,
          accountId: record.account_id || "",
          workspaceId: record.workspace_id || "",
          projectId: record.project_id || null,
          taskId: record.task_id || null,
          direction: "upstream_to_client",
          frame: parsed,
        };
        const event = gatewayEventFromFrame(parsed);
        const inserted = await client.query<{ id: string }>(
          `
            insert into hermes_frame_events (
              redis_stream_id, account_id, workspace_id, project_id, task_id, direction,
              event_type, hermes_session_id, frame, created_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
            on conflict (redis_stream_id) do nothing
            returning id::text
          `,
          [
            redisStreamId, frame.accountId, frame.workspaceId, frame.projectId, frame.taskId, frame.direction,
            event?.type || null, event?.session_id || null, JSON.stringify(parsed), streamDate(redisStreamId),
          ],
        );
        ackIds.push(redisStreamId);
        if (!inserted.rowCount || !event?.session_id) continue;
        if (frame.taskId) await syncSpecialistEvent(client, frame.taskId, event.session_id, event.type, event.payload || {});

        const key = [frame.accountId, frame.projectId || "", frame.taskId || "", event.session_id].join(":");
        if (!loadedKeys.has(key)) {
          const existing = await client.query<{ state: RichStreamState; last_redis_stream_id: string }>(
            `
              select state, last_redis_stream_id
              from hermes_session_projections
              where account_id = $1 and project_id is not distinct from $2
                and task_id is not distinct from $3 and hermes_session_id = $4
              for update
            `,
            [frame.accountId, frame.projectId, frame.taskId, event.session_id],
          );
          loadedKeys.add(key);
          const persisted = existing.rows[0];
          currentStates.set(key, persisted?.state || null);
          if (persisted) {
            latestStreamIds.set(key, persisted.last_redis_stream_id);
          }
        }
        const latestStreamId = latestStreamIds.get(key);
        if (latestStreamId && compareRedisStreamIds(redisStreamId, latestStreamId) < 0) {
          const history = await client.query<{
            redis_stream_id: string;
            event_type: string | null;
            frame: Record<string, unknown>;
          }>(
            `
              select redis_stream_id, event_type, frame
              from hermes_frame_events
              where account_id = $1 and project_id is not distinct from $2
                and task_id is not distinct from $3 and hermes_session_id = $4
              order by split_part(redis_stream_id, '-', 1)::bigint,
                       split_part(redis_stream_id, '-', 2)::bigint
            `,
            [frame.accountId, frame.projectId, frame.taskId, event.session_id],
          );
          let rebuilt: RichStreamState | null = null;
          for (const historical of history.rows) {
            rebuilt = applyMirroredFrame(rebuilt, historical.frame).state;
          }
          const newest = history.rows.at(-1);
          if (rebuilt && newest) {
            const newestFrame: MirroredFrame = { ...frame, redisStreamId: newest.redis_stream_id };
            currentStates.set(key, rebuilt);
            latestStreamIds.set(key, newest.redis_stream_id);
            nextStates.set(key, {
              frame: newestFrame,
              state: rebuilt,
              eventType: event.type,
            });
          }
          continue;
        }
        const current = currentStates.get(key) || null;
        const projected = applyMirroredFrame(current, parsed).state;
        if (projected) {
          currentStates.set(key, projected);
          latestStreamIds.set(key, redisStreamId);
          nextStates.set(key, { frame, state: projected, eventType: event.type });
        }
      }

      const boundaryEvents = new Set([
        "message.start", "message.complete", "tool.start", "tool.complete", "tool.generating",
        "clarify.request", "approval.request", "sudo.request", "secret.request", "error",
      ]);
      for (const [key, { frame, state: queuedState, eventType }] of nextStates) {
        const state = settleProjectionBatch(queuedState);
        await client.query(
          `
            insert into hermes_session_projections (
              account_id, workspace_id, project_id, task_id, hermes_session_id, state, last_redis_stream_id
            )
            values ($1, $2, $3, $4, $5, $6::jsonb, $7)
            on conflict (account_id, project_id, task_id, hermes_session_id)
            do update set state = excluded.state,
                          last_redis_stream_id = excluded.last_redis_stream_id,
                          updated_at = now()
          `,
          [
            frame.accountId, frame.workspaceId, frame.projectId, frame.taskId, state.sessionId,
            JSON.stringify(state), frame.redisStreamId,
          ],
        );
        const now = Date.now();
        const shouldNotify = boundaryEvents.has(eventType) || now - (this.lastNotifiedAt.get(key) || 0) >= 100;
        if (shouldNotify && frame.taskId) {
          await appendTransactionalEvent(client, {
            projectId: frame.projectId,
            taskId: frame.taskId,
            type: "hermes.projection.updated",
            payload: {
              hermesSessionId: state.sessionId,
              lastRedisStreamId: frame.redisStreamId,
              eventType,
            },
          });
          notifiedKeys.push(key);
        }
      }
      await client.query("commit");
      const notifiedAt = Date.now();
      for (const key of notifiedKeys) this.lastNotifiedAt.set(key, notifiedAt);
      if (ackIds.length) await this.redis.xack(STREAM, GROUP, ...ackIds);
      this.processed += ackIds.length;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredEnv("DATABASE_URL") });
  const redis = new Redis(requiredEnv("REDIS_URL"), { maxRetriesPerRequest: null });
  const app = Fastify({ logger: true });
  const worker = new ProjectorWorker(pool, redis, `projector-${randomUUID()}`, (error) => {
    app.log.error({ err: error }, "Hermes projector batch failed");
  });
  await worker.start();

  app.get("/healthz", async () => {
    await pool.query("select 1");
    await redis.ping();
    return {
      service: "hermes-projector",
      version: TERMES_VERSION,
      status: "ok",
      processedFrames: worker.processedFrames,
      checkedAt: new Date().toISOString(),
    };
  });
  app.addHook("onClose", async () => {
    await worker.stop();
    redis.disconnect();
    await pool.end();
  });
  await app.listen({ host: "0.0.0.0", port: Number.parseInt(process.env.PORT || "8080", 10) });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

import type Redis from "ioredis";
import type pg from "pg";

export const TERMES_EVENT_CHANNEL = "termes.events";
export const TERMES_TURN_STREAM = "termes.turns";

export type EventEnvelope = {
  id: string;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TransactionalEventInput = {
  projectId?: string | null;
  taskId?: string | null;
  type: string;
  payload: Record<string, unknown>;
};

type Queryable = pg.Pool | pg.PoolClient;

/** Store the domain event and its publish intent in the caller's transaction. */
export async function appendTransactionalEvent(
  queryable: Queryable,
  input: TransactionalEventInput,
): Promise<EventEnvelope> {
  const result = await queryable.query<{
    id: string;
    account_id: string;
    workspace_id: string;
    project_id: string | null;
    task_id: string | null;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `
      with inserted_event as (
        insert into events (account_id, workspace_id, project_id, task_id, type, payload)
        values (
          coalesce(
            (select account_id from tasks where id = $2),
            (select pm.user_id from project_members pm where pm.project_id = $1 and pm.role = 'owner' order by pm.created_at asc limit 1)
          ),
          coalesce(
            (select workspace_id from tasks where id = $2),
            (select workspace_id from projects where id = $1)
          ),
          $1, $2, $3, $4::jsonb
        )
        returning id, account_id, workspace_id, project_id, task_id, type, payload, created_at
      ), inserted_outbox as (
        insert into event_outbox (event_id, envelope)
        select
          id,
          jsonb_build_object(
            'id', id,
            'accountId', account_id,
            'workspaceId', workspace_id,
            'projectId', project_id,
            'taskId', task_id,
            'type', type,
            'payload', payload,
            'createdAt', created_at
          )
        from inserted_event
        on conflict (event_id) do nothing
      )
      select id, account_id, workspace_id, project_id, task_id, type, payload, created_at
      from inserted_event
    `,
    [input.projectId ?? null, input.taskId ?? null, input.type, JSON.stringify(input.payload)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Transactional event insert did not return a row");
  return {
    id: row.id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    taskId: row.task_id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  };
}

type OutboxRow = {
  id: string;
  envelope: EventEnvelope;
  attempts: number;
};

export class EventOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<number> | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly options: {
      intervalMs?: number;
      batchSize?: number;
      maxAttempts?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (!this.active) {
        this.active = this.drainOnce()
          .catch((error) => {
            this.options.onError?.(error);
            return 0;
          })
          .finally(() => { this.active = null; });
      }
    };
    tick();
    this.timer = setInterval(tick, this.options.intervalMs ?? 100);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<OutboxRow>(
        `
          select id::text, envelope, attempts
          from event_outbox
          where published_at is null and dead_lettered_at is null and available_at <= now()
          order by id asc
          for update skip locked
          limit $1
        `,
        [this.options.batchSize ?? 100],
      );
      let published = 0;
      for (const row of result.rows) {
        try {
          await this.redis.publish(TERMES_EVENT_CHANNEL, JSON.stringify(row.envelope));
          await client.query(
            "update event_outbox set published_at = now(), last_error = null where id = $1",
            [row.id],
          );
          published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const maxAttempts = this.options.maxAttempts ?? 20;
          await client.query(
            `
              update event_outbox
              set attempts = attempts + 1,
                  available_at = now() + make_interval(secs => least(60, (power(2, least(attempts, 5)))::integer)),
                  last_error = $2,
                  dead_lettered_at = case when attempts + 1 >= $3 then now() else null end
              where id = $1
            `,
            [row.id, message.slice(0, 2000), maxAttempts],
          );
          this.options.onError?.(error);
        }
      }
      await client.query("commit");
      return published;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class TurnDispatchOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<number> | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.active) return;
      this.active = this.drainOnce().catch((error) => {
        this.onError?.(error);
        return 0;
      }).finally(() => { this.active = null; });
    };
    tick();
    this.timer = setInterval(tick, 100);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  async drainOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<{ turn_id: string; runtime_cell_id: string; attempts: number }>(
        `
          select turn_id, runtime_cell_id, attempts
          from turn_dispatch_outbox
          where enqueued_at is null and available_at <= now()
          order by created_at asc
          for update skip locked
          limit 100
        `,
      );
      let published = 0;
      for (const row of result.rows) {
        try {
          await this.redis.xadd(
            TERMES_TURN_STREAM,
            "*",
            "turnId", row.turn_id,
            "runtimeCellId", row.runtime_cell_id,
          );
          await client.query(
            "update turn_dispatch_outbox set enqueued_at = now(), last_error = null where turn_id = $1",
            [row.turn_id],
          );
          published += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await client.query(
            `
              update turn_dispatch_outbox
              set attempts = attempts + 1,
                  available_at = now() + make_interval(secs => least(60, power(2, least(attempts, 5))::integer)),
                  last_error = $2
              where turn_id = $1
            `,
            [row.turn_id, message.slice(0, 2000)],
          );
          this.onError?.(error);
        }
      }
      await client.query("commit");
      return published;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

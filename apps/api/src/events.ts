import type { EventType } from "@termes/shared";
import type Redis from "ioredis";
import type pg from "pg";

export interface AppendEventInput {
  projectId?: string | null;
  taskId?: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}

export const EVENT_CHANNEL = "termes.events";

export async function appendEvent(
  pool: pg.Pool,
  redis: Redis,
  input: AppendEventInput,
): Promise<void> {
  const result = await pool.query<{
    id: string;
    project_id: string | null;
    task_id: string | null;
    type: EventType;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `
      insert into events (project_id, task_id, type, payload)
      values ($1, $2, $3, $4::jsonb)
      returning id, project_id, task_id, type, payload, created_at
    `,
    [
      input.projectId ?? null,
      input.taskId ?? null,
      input.type,
      JSON.stringify(input.payload),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("Event insert did not return a row");
  }

  await redis.publish(
    EVENT_CHANNEL,
    JSON.stringify({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      type: row.type,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }),
  );
}

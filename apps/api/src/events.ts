import type { EventType } from "@termes/shared";
import {
  EventOutboxDispatcher,
  TurnDispatchOutboxDispatcher,
  TERMES_EVENT_CHANNEL,
  appendTransactionalEvent,
} from "@termes/eventing";
import type Redis from "ioredis";
import type pg from "pg";

export { EventOutboxDispatcher, TurnDispatchOutboxDispatcher };

export interface AppendEventInput {
  projectId?: string | null;
  taskId?: string | null;
  type: EventType;
  payload: Record<string, unknown>;
}

export const EVENT_CHANNEL = TERMES_EVENT_CHANNEL;

export async function appendEvent(
  pool: pg.Pool | pg.PoolClient,
  _redis: Redis,
  input: AppendEventInput,
): Promise<void> {
  await appendTransactionalEvent(pool, input);
}

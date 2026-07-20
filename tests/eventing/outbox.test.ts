import assert from "node:assert/strict";
import test from "node:test";

import {
  EventOutboxDispatcher,
  TERMES_TURN_STREAM,
  TurnDispatchOutboxDispatcher,
  appendTransactionalEvent,
} from "../../packages/eventing/src/index.ts";

test("domain event와 outbox intent를 하나의 SQL statement로 기록한다", async () => {
  let sql = "";
  const queryable = {
    async query(text: string) {
      sql = text;
      return {
        rows: [{
          id: "00000000-0000-0000-0000-000000000001",
          account_id: "00000000-0000-0000-0000-000000000001",
          workspace_id: "10000000-0000-0000-0000-000000000001",
          project_id: null,
          task_id: null,
          type: "task.created",
          payload: { ok: true },
          created_at: new Date("2026-07-12T00:00:00.000Z"),
        }],
      };
    },
  };

  const event = await appendTransactionalEvent(queryable as never, {
    type: "task.created",
    payload: { ok: true },
  });

  assert.match(sql, /with inserted_event as/i);
  assert.match(sql, /insert into event_outbox/i);
  assert.equal(event.createdAt, "2026-07-12T00:00:00.000Z");
});

test("Turn dispatch outbox는 durable Redis Stream에 기록한 뒤에만 enqueued를 확정한다", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (/select turn_id, runtime_cell_id, attempts/i.test(sql)) {
        return { rows: [{ turn_id: "turn-1", runtime_cell_id: "cell-1", attempts: 0 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const xadd: unknown[][] = [];
  const dispatcher = new TurnDispatchOutboxDispatcher(
    { async connect() { return client; } } as never,
    { async xadd(...args: unknown[]) { xadd.push(args); return "1-0"; } } as never,
  );
  assert.equal(await dispatcher.drainOnce(), 1);
  assert.deepEqual(xadd[0], [TERMES_TURN_STREAM, "*", "turnId", "turn-1", "runtimeCellId", "cell-1"]);
  assert.ok(queries.some((entry) => /set enqueued_at = now/i.test(entry.sql)));
  assert.equal(queries.at(-1)?.sql, "commit");
});

test("dispatcher는 성공을 확정하고 실패는 backoff 재시도로 남긴다", async () => {
  const updates: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      updates.push({ sql, values });
      if (/select id::text, envelope/i.test(sql)) {
        return {
          rows: [
            { id: "1", envelope: { id: "event-1", type: "ok" }, attempts: 0 },
            { id: "2", envelope: { id: "event-2", type: "fail" }, attempts: 0 },
          ],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const redis = {
    async publish(_channel: string, payload: string) {
      if (payload.includes("event-2")) throw new Error("redis unavailable");
      return 1;
    },
  };
  const errors: unknown[] = [];
  const dispatcher = new EventOutboxDispatcher(pool as never, redis as never, {
    onError: (error) => errors.push(error),
  });

  const count = await dispatcher.drainOnce();
  assert.equal(count, 1);
  assert.equal(errors.length, 1);
  assert.ok(updates.some((entry) => /set published_at = now/i.test(entry.sql)));
  assert.ok(updates.some((entry) => /set attempts = attempts \+ 1/i.test(entry.sql)));
  const failureUpdate = updates.find((entry) => /dead_lettered_at = case/i.test(entry.sql));
  assert.deepEqual(failureUpdate?.values, ["2", "redis unavailable", 20]);
  assert.equal(updates.at(-1)?.sql, "commit");
});

test("dispatcher는 dead-letter 이벤트를 다시 선택하지 않고 설정한 최대 시도 횟수를 사용한다", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (/select id::text, envelope/i.test(sql)) {
        return { rows: [{ id: "9", envelope: { id: "event-9", type: "fail" }, attempts: 2 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const dispatcher = new EventOutboxDispatcher(
    { async connect() { return client; } } as never,
    { async publish() { throw new Error("still unavailable"); } } as never,
    { maxAttempts: 3 },
  );
  assert.equal(await dispatcher.drainOnce(), 0);
  const select = queries.find((entry) => /select id::text, envelope/i.test(entry.sql));
  assert.match(select?.sql || "", /dead_lettered_at is null/i);
  const failureUpdate = queries.find((entry) => /dead_lettered_at = case/i.test(entry.sql));
  assert.deepEqual(failureUpdate?.values, ["9", "still unavailable", 3]);
});

import assert from "node:assert/strict";
import test from "node:test";

import { jsonForPostgres } from "../../services/orchestrator/src/postgres-json.ts";

test("jsonForPostgres removes NUL characters from nested Hermes tool payloads", () => {
  const serialized = jsonForPostgres({
    commands: [
      {
        tool: "exec_command",
        preview: "\u0000pnpm run test",
      },
    ],
    events: [
      {
        payload: {
          output: "before\u0000after",
        },
      },
    ],
  });

  assert.doesNotMatch(serialized, /\\u0000/);
  assert.deepEqual(JSON.parse(serialized), {
    commands: [
      {
        tool: "exec_command",
        preview: "pnpm run test",
      },
    ],
    events: [
      {
        payload: {
          output: "beforeafter",
        },
      },
    ],
  });
});

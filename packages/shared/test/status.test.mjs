import assert from "node:assert/strict";
import { test } from "node:test";

const statuses = [
  "created",
  "queued",
  "running",
  "reviewing",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

test("task status contract keeps created as the first intake state", () => {
  assert.equal(statuses[0], "created");
  assert.ok(statuses.includes("completed"));
});

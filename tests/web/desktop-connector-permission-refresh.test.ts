import assert from "node:assert/strict";
import test from "node:test";
import { installPermissionFocusRefresh } from "../../apps/desktop-connector/src/permission-refresh.ts";

test("refreshes connector permissions when the app window regains focus", () => {
  const listeners = new Set<() => void>();
  const target = {
    addEventListener(_type: "focus", listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: "focus", listener: () => void) {
      listeners.delete(listener);
    },
  };
  let refreshCount = 0;

  const dispose = installPermissionFocusRefresh(target, () => {
    refreshCount += 1;
  });
  for (const listener of listeners) listener();

  assert.equal(refreshCount, 1);
  dispose();
  assert.equal(listeners.size, 0);
});

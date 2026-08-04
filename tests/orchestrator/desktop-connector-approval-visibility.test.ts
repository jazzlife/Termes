import assert from "node:assert/strict";
import test from "node:test";

import { revealPendingApproval } from "../../apps/desktop-connector/src/approval-visibility.ts";

test("a pending approval is brought into the fixed Connector viewport", () => {
  const calls: ScrollIntoViewOptions[] = [];
  const panel = {
    scrollIntoView(options?: boolean | ScrollIntoViewOptions) {
      assert.notEqual(typeof options, "boolean");
      calls.push(options || {});
    },
  };

  revealPendingApproval(1, panel);

  assert.deepEqual(calls, [{ block: "start", behavior: "smooth" }]);
});

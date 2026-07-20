import assert from "node:assert/strict";
import test from "node:test";

import { dashboardWorkspacePath } from "../../services/orchestrator/src/workspace-path.ts";

test("계정별 host workspace 경로를 해당 Hermes Cell의 /workspace 기준으로 변환한다", () => {
  const accountId = "00000000-0000-0000-0000-000000000001";
  assert.equal(
    dashboardWorkspacePath(`/data/docker_data/termes/workspaces/users/${accountId}/projects/termes-mvp`, accountId),
    "/workspace/projects/termes-mvp",
  );
  assert.throws(
    () => dashboardWorkspacePath("/data/docker_data/termes/workspaces/users/other/projects/termes-mvp", accountId),
    /outside the account workspace root/,
  );
});

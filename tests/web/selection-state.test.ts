import assert from "node:assert/strict";
import test from "node:test";

import { resolveExistingSelectionId } from "../../apps/web/src/selection-state.ts";

test("삭제된 프로젝트 선택값은 남은 프로젝트로 교체한다", () => {
  const projects = [{ id: "new-project" }, { id: "other-project" }];
  assert.equal(resolveExistingSelectionId(projects, "deleted-project"), "new-project");
});

test("현재 프로젝트와 채팅이 존재하면 선택을 유지한다", () => {
  const items = [{ id: "first" }, { id: "selected" }];
  assert.equal(resolveExistingSelectionId(items, "selected"), "selected");
  assert.equal(resolveExistingSelectionId([], "selected"), "");
});

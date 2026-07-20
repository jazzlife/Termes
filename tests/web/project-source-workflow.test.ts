import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("apps/web/src/main.tsx", "utf8");
const apiSource = readFileSync("apps/web/src/api.ts", "utf8");

function drawerSection(mode: "folder" | "github"): string {
  const marker = mode === "folder"
    ? '{projectCreateMode === "folder" ? ('
    : '<div className="githubProjectPanel">';
  const start = appSource.indexOf(marker);
  return start >= 0 ? appSource.slice(start, start + 20_000) : "";
}

test("GitHub 프로젝트 탭은 저장소와 워크스페이스 폴더를 선택한 뒤 프로젝트 폴더로 clone한다", () => {
  const githubSection = drawerSection("github");

  assert.match(appSource, /cloneGitHubProject,/);
  assert.match(apiSource, /export async function cloneGitHubProject/);
  assert.match(appSource, /const \[selectedGithubRepository, setSelectedGithubRepository\] = useState\(""\)/);
  assert.match(githubSection, /data-testid="github-repository-select"/);
  assert.match(githubSection, /data-testid="github-clone-selected"/);
  assert.match(githubSection, /프로젝트 폴더로 선택/);
  assert.match(githubSection, /<ProjectDirectoryTree[\s\S]*selectedPath=\{githubCloneParentPath\}/);
  assert.match(appSource, /await cloneGitHubProject\(\{[\s\S]*repositoryFullName: fullName,[\s\S]*parentPath: githubCloneParentPath/);
  assert.doesNotMatch(appSource, /pendingGithubClone/);
});

test("폴더 프로젝트 탭은 워크스페이스 트리 선택을 프로젝트 폴더로 등록한다", () => {
  const folderSection = drawerSection("folder");

  assert.match(folderSection, /<ProjectDirectoryTree[\s\S]*selectedPath=\{folderPath\}/);
  assert.match(folderSection, /data-testid="submit-folder-project"/);
  assert.match(folderSection, /프로젝트 폴더로 선택/);
  assert.match(appSource, /await registerProjectFolder\(\{ path: selectedPath \}\)/);
});

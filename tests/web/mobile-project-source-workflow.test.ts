import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync("apps/web/src/main.tsx", "utf8");
const mobileSource = readFileSync("apps/web/src/experiences/mobile/MobileExperience.tsx", "utf8");

test("모바일 GitHub 프로젝트 탭은 인증·저장소·워크스페이스 폴더 선택을 제공한다", () => {
  assert.match(mobileSource, /githubStatus: GitHubConnectionSummary \| null/);
  assert.match(mobileSource, /githubRepositoryGroups: GitHubRepositoryGroupSummary\[\]/);
  assert.match(mobileSource, /projectFolders: ProjectFolderSummary\[\]/);
  assert.match(mobileSource, /data-testid="mobile-github-repository-select"/);
  assert.match(mobileSource, /"mobile-github-clone-selected"/);
  assert.match(mobileSource, /data-testid="mobile-project-folder-tree"/);
  assert.match(mobileSource, /GitHub 인증 관리/);
  assert.match(mobileSource, /props\.onCloneGitHubProject/);
  assert.doesNotMatch(mobileSource, /cloneGitHubRepository/);
});

test("모바일 프로젝트 흐름은 App의 원자적 clone·폴더 등록 경로를 사용한다", () => {
  assert.match(appSource, /githubStatus=\{githubStatus\}/);
  assert.match(appSource, /githubRepositoryGroups=\{githubRepositoryGroups\}/);
  assert.match(appSource, /projectFolders=\{projectFolders\}/);
  assert.match(appSource, /onCloneGitHubProject=\{async \(repositoryFullName, parentPath\) => \{/);
  assert.match(appSource, /await cloneGitHubProject\(\{[\s\S]*repositoryFullName,[\s\S]*parentPath/);
  assert.match(appSource, /onRegisterProjectFolder=\{async \(path\) => \{/);
  assert.match(appSource, /onCreateProjectFolder=\{async \(name, parentPath\) => \{/);
});

test("모바일 폴더 트리는 선택한 폴더의 하위 폴더를 팝업에서만 만든다", () => {
  assert.match(mobileSource, /const \[mobileFolderCreateDialog, setMobileFolderCreateDialog\] = useState/);
  assert.match(mobileSource, /data-testid="mobile-project-folder-create-dialog"/);
  assert.match(mobileSource, /새 폴더/);
  assert.doesNotMatch(mobileSource, /mobileProjectInlineField/);
  assert.doesNotMatch(mobileSource, /githubNewFolderName/);
});

test("모바일 폴더 선택기는 접기와 펼치기가 가능한 실제 계층 트리를 렌더링한다", () => {
  assert.match(mobileSource, /function MobileProjectFolderTreeNode\(/);
  assert.match(mobileSource, /className="mobileProjectFolderTreeToggle"/);
  assert.match(mobileSource, /className="mobileProjectFolderTreeChildren"/);
  assert.doesNotMatch(mobileSource, /style=\{\{ paddingLeft:/);
});

test("모바일 새 폴더 액션은 폴더 트리 헤더에 배치한다", () => {
  assert.match(mobileSource, /className="mobileProjectFolderTreeHeader"/);
  assert.match(mobileSource, /className="mobileProjectFolderTreeCreateAction"/);
});

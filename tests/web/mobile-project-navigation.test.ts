import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mobileExperience = readFileSync("apps/web/src/experiences/mobile/MobileExperience.tsx", "utf8");
const mobileCss = readFileSync("apps/web/src/experiences/mobile/mobile.css", "utf8");

test("모바일 헤더의 앱 아이콘은 프로젝트 드로어를 열고 선택된 프로젝트를 제목으로 표시한다", () => {
  assert.match(mobileExperience, /aria-label="프로젝트 목록 열기"/);
  assert.match(mobileExperience, /mobileProjectDrawer/);
  assert.match(mobileExperience, /props\.selectedProject\?\.name \|\| "프로젝트"/);
  assert.doesNotMatch(mobileExperience, /<select/);
});

test("모바일 프로젝트 드로어는 프로젝트 목록 선택과 GitHub·폴더 추가 다이얼로그를 제공한다", () => {
  assert.match(mobileExperience, /data-testid="mobile-project-drawer"/);
  assert.match(mobileExperience, /data-testid="mobile-project-add-dialog"/);
  assert.match(mobileExperience, /GitHub 프로젝트/);
  assert.match(mobileExperience, /폴더 프로젝트/);
  assert.match(mobileExperience, /props\.onCloneGitHubProject/);
  assert.match(mobileExperience, /props\.onRegisterProjectFolder/);
  assert.match(mobileCss, /\.mobileProjectDrawer/);
  assert.match(mobileCss, /\.mobileProjectAddDialog/);
});

test("모바일 검색은 설정 버튼 바로 왼쪽의 토글 버튼으로 열고 닫는다", () => {
  assert.match(mobileExperience, /"Task 검색 열기"/);
  assert.match(mobileExperience, /className=\{searchOpen \? "mobileIconButton active" : "mobileIconButton"\}/);
  assert.match(mobileExperience, /searchOpen \? \(/);
  assert.match(mobileCss, /\.mobileTaskSearchBar/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("회원 lifecycle UI는 Pencil 화면과 동일한 앱 아이콘 및 API 계약을 데스크톱·모바일에 연결한다", async () => {
  const [main, mobile, api, styles] = await Promise.all([
    source("apps/web/src/main.tsx"),
    source("apps/web/src/experiences/mobile/MobileExperience.tsx"),
    source("apps/web/src/api.ts"),
    source("apps/web/src/styles.css"),
  ]);

  assert.match(main, /termes-icon-launcher-v3-512\.png/);
  assert.match(main, /accountAuthMode === "register"/);
  assert.match(main, /handleAccountRegistration/);
  assert.match(main, /handlePasswordChange/);
  assert.match(main, /openMemberApproval/);
  assert.match(main, /accountPrincipal\.canApproveMembers/);
  assert.match(main, /renderMemberDialog\(\)/);
  assert.match(main, /accountDataGenerationRef\.current \+= 1/);
  assert.match(main, /hermesRpcClientRef\.current\?\.close\(\)/);
  assert.match(main, /setDevices\(\[\]\)/);
  assert.match(main, /setHermesCatalog\(null\)/);
  assert.match(main, /setGithubRepositoryGroups\(\[\]\)/);
  assert.match(main, /accountGeneration !== accountDataGenerationRef\.current/);

  assert.match(mobile, /onChangePassword: \(\) => void/);
  assert.match(mobile, /props\.account\.canApproveMembers/);
  assert.match(mobile, /onClick=\{props\.onApproveMembers\}/);
  assert.match(mobile, /비밀번호 변경/);
  assert.match(mobile, /회원 승인/);

  assert.match(api, /\/api\/account-auth\/register/);
  assert.match(api, /\/api\/account-auth\/password/);
  assert.match(api, /\/api\/account-auth\/members\/pending/);
  assert.match(api, /\/api\/account-auth\/members\/\$\{encodeURIComponent\(memberId\)\}\/approve/);

  assert.match(styles, /\.memberDialogBackdrop/);
  assert.match(styles, /\.accountGateAppIcon/);
  assert.match(styles, /@media \(max-width: 760px\)/);
});

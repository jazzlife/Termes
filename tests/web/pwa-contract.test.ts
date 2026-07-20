import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync("apps/web/public/manifest.webmanifest", "utf8")) as {
  display?: string;
  start_url?: string;
  launch_handler?: unknown;
  icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
};
const indexHtml = readFileSync("apps/web/index.html", "utf8");
const serviceWorker = readFileSync("apps/web/public/sw.js", "utf8");
const pwaRuntime = readFileSync("apps/web/src/pwa.ts", "utf8");
const viteConfig = readFileSync("apps/web/vite.config.ts", "utf8");
const mobileExperience = readFileSync("apps/web/src/experiences/mobile/MobileExperience.tsx", "utf8");
const mobileCss = readFileSync("apps/web/src/experiences/mobile/mobile.css", "utf8");
const appCss = readFileSync("apps/web/src/styles.css", "utf8");
const nginxConfig = readFileSync("apps/web/nginx.conf", "utf8");

function readPngMetadata(path: string) {
  const png = readFileSync(path);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    hasAlpha: png[25] === 4 || png[25] === 6
  };
}

test("Termes Web은 standalone 설치 요건과 필수 아이콘을 제공한다", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.launch_handler, undefined);
  assert.ok(
    manifest.icons?.some(
      (icon) => icon.src === "/termes-icon-launcher-v2-192.png" && icon.sizes === "192x192" && icon.purpose === "any"
    )
  );
  assert.ok(
    manifest.icons?.some(
      (icon) => icon.src === "/termes-icon-launcher-v2-512.png" && icon.sizes === "512x512" && icon.purpose === "any"
    )
  );
  assert.ok(
    manifest.icons?.some(
      (icon) => icon.src === "/termes-icon-maskable-v2-192.png" && icon.sizes === "192x192" && icon.purpose === "maskable"
    )
  );
  assert.ok(
    manifest.icons?.some(
      (icon) => icon.src === "/termes-icon-maskable-v2-512.png" && icon.sizes === "512x512" && icon.purpose === "maskable"
    )
  );
  assert.match(indexHtml, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(indexHtml, /rel="icon" href="\/termes-icon-launcher-v2-192\.png"/);
  assert.match(indexHtml, /rel="apple-touch-icon" href="\/termes-apple-touch-icon-v2\.png"/);
  assert.match(indexHtml, /apple-mobile-web-app-capable/);
  assert.match(serviceWorker, /\/termes-icon-maskable-v2-192\.png/);
  assert.match(serviceWorker, /\/termes-icon-maskable-v2-512\.png/);
  assert.match(nginxConfig, /default_type application\/manifest\+json/);
});

test("일반, Android maskable, Apple 아이콘은 용도별 크기와 투명도를 지킨다", () => {
  assert.deepEqual(readPngMetadata("apps/web/public/termes-icon-launcher-v2-192.png"), {
    width: 192,
    height: 192,
    hasAlpha: true
  });
  assert.deepEqual(readPngMetadata("apps/web/public/termes-icon-launcher-v2-512.png"), {
    width: 512,
    height: 512,
    hasAlpha: true
  });
  assert.deepEqual(readPngMetadata("apps/web/public/termes-icon-maskable-v2-192.png"), {
    width: 192,
    height: 192,
    hasAlpha: false
  });
  assert.deepEqual(readPngMetadata("apps/web/public/termes-icon-maskable-v2-512.png"), {
    width: 512,
    height: 512,
    hasAlpha: false
  });
  assert.deepEqual(readPngMetadata("apps/web/public/termes-apple-touch-icon-v2.png"), {
    width: 180,
    height: 180,
    hasAlpha: false
  });
});

test("OctOP과 같은 설치 이벤트와 standalone 실행 모드를 앱 UI에 연결한다", () => {
  assert.match(pwaRuntime, /\(display-mode: standalone\)/);
  assert.match(mobileExperience, /mobilePwaInstallBanner/);
  assert.match(mobileExperience, /Standalone 앱/);
  const appSource = readFileSync("apps/web/src/main.tsx", "utf8");
  assert.match(appSource, /beforeinstallprompt/);
  assert.match(appSource, /appinstalled/);
  assert.match(appSource, /handleInstallPwa/);
  assert.match(appSource, /"manual"/);
});

test("Service Worker는 앱 셸만 캐시하고 API와 실시간 이벤트를 우회한다", () => {
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/events\/"\)/);
  assert.match(serviceWorker, /cache: "no-store"/);
});

test("Service Worker는 빌드별 고유 ID로 조용히 교체된다", () => {
  assert.match(viteConfig, /termesServiceWorkerVersionPlugin/);
  assert.match(serviceWorker, /const BUILD_ID = "__TERMES_BUILD_ID__"/);
  assert.match(serviceWorker, /skipWaiting\(\)/);
  assert.match(serviceWorker, /clients\.claim\(\)/);
  assert.match(serviceWorker, /TERMES_SW_ACTIVATED/);
  assert.match(pwaRuntime, /register\("\/sw\.js", \{ scope: "\/", updateViaCache: "none" \}\)/);
  assert.match(pwaRuntime, /window\.setInterval/);
  assert.doesNotMatch(pwaRuntime, /sw\.js\?v=/);
  assert.doesNotMatch(pwaRuntime, /location\.reload/);
});

test("모바일 Composer는 absolute overlay가 아닌 앱 셸의 흐름형 footer다", () => {
  const composerBlock = mobileCss.match(/\.mobileComposer \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(composerBlock, /position: relative/);
  assert.match(composerBlock, /flex: 0 0 auto/);
  assert.doesNotMatch(composerBlock, /position: absolute/);
  assert.match(mobileCss, /data-mobile-keyboard="open"/);
});

test("모바일 터치는 탭 하이라이트를 숨기고 키보드 포커스 링은 유지한다", () => {
  const bodyBlock = appCss.match(/body \{([\s\S]*?)\n\}/)?.[1] || "";
  const searchInputBlock = mobileCss.match(/\.mobileTaskToolbar input \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(bodyBlock, /-webkit-tap-highlight-color: transparent/);
  assert.match(mobileCss, /\.mobileExperience button:focus-visible/);
  assert.doesNotMatch(mobileCss, /\.mobileExperience input:focus-visible/);
  assert.doesNotMatch(mobileCss, /\.mobileExperience select:focus-visible/);
  assert.doesNotMatch(mobileCss, /\.mobileExperience textarea:focus-visible/);
  assert.match(searchInputBlock, /appearance: none/);
  assert.match(searchInputBlock, /outline: 0/);
  assert.match(searchInputBlock, /box-shadow: none/);
  assert.doesNotMatch(mobileCss, /\.mobileProjectContext:has\(select:focus-visible\)/);
  assert.doesNotMatch(mobileCss, /\.mobileProjectContext:focus-within/);
  assert.doesNotMatch(mobileCss, /\.mobileComposerSurface:focus-within/);
});

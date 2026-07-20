import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const SERVICE_WORKER_BUILD_ID_TOKEN = "__TERMES_BUILD_ID__";

function createBuildId(): string {
  const configuredBuildId = process.env.TERMES_BUILD_ID?.trim();
  if (configuredBuildId) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(configuredBuildId)) {
      throw new Error("TERMES_BUILD_ID must contain only letters, numbers, dots, underscores, and hyphens");
    }
    return configuredBuildId;
  }

  return `${Date.now().toString(36)}-${randomUUID()}`;
}

function termesServiceWorkerVersionPlugin(buildId: string): Plugin {
  let resolvedConfig: ResolvedConfig;

  return {
    name: "termes-service-worker-version",
    apply: "build",
    configResolved(config) {
      resolvedConfig = config;
    },
    async writeBundle(outputOptions) {
      const outDir = resolve(resolvedConfig.root, outputOptions.dir || resolvedConfig.build.outDir);
      const serviceWorkerPath = resolve(outDir, "sw.js");
      const source = await readFile(serviceWorkerPath, "utf8");

      if (!source.includes(SERVICE_WORKER_BUILD_ID_TOKEN)) {
        throw new Error(`Service Worker build ID token is missing from ${serviceWorkerPath}`);
      }

      await writeFile(serviceWorkerPath, source.replaceAll(SERVICE_WORKER_BUILD_ID_TOKEN, buildId), "utf8");
    },
  };
}

const buildId = createBuildId();

export default defineConfig({
  define: {
    __TERMES_BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [react(), termesServiceWorkerVersionPlugin(buildId)],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/events": "http://localhost:8080",
    },
  },
});

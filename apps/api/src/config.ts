import { parseAccountAccessHashes } from "./account-auth";

export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  migrationsDir: string;
  hermesManagerUrl: string;
  hermesManagerServiceToken: string;
  deviceGatewayUrl: string;
  singleAccountId: string;
  singleWorkspaceId: string;
  singleRuntimeCellId: string;
  oauthAdminAccountId: string;
  accountAccessHashes: Map<string, Buffer>;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid port in ${name}: ${raw}`);
  }

  return parsed;
}

export function loadConfig(): ApiConfig {
  return {
    host: process.env.HOST || "0.0.0.0",
    port: optionalPort("PORT", 8080),
    databaseUrl: requiredEnv("DATABASE_URL"),
    redisUrl: requiredEnv("REDIS_URL"),
    migrationsDir: process.env.MIGRATIONS_DIR || "/app/infra/db/migrations",
    hermesManagerUrl: (process.env.HERMES_MANAGER_URL || "http://hermes-manager:8080").replace(/\/+$/, ""),
    hermesManagerServiceToken: requiredEnv("HERMES_MANAGER_SERVICE_TOKEN"),
    deviceGatewayUrl: (process.env.DEVICE_GATEWAY_URL || "http://device-gateway:8080").replace(/\/+$/, ""),
    singleAccountId: requiredEnv("TERMES_SINGLE_ACCOUNT_ID"),
    singleWorkspaceId: requiredEnv("TERMES_SINGLE_WORKSPACE_ID"),
    singleRuntimeCellId: requiredEnv("TERMES_SINGLE_RUNTIME_CELL_ID"),
    oauthAdminAccountId: requiredEnv("TERMES_OAUTH_ADMIN_ACCOUNT_ID"),
    accountAccessHashes: parseAccountAccessHashes(requiredEnv("TERMES_ACCOUNT_ACCESS_HASHES_JSON")),
  };
}

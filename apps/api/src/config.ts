export interface ApiConfig {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  migrationsDir: string;
  hermesManagerUrl: string;
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
  };
}

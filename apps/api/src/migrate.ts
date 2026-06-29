import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "./config";

async function waitForDatabase(pool: pg.Pool): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 60_000) {
    try {
      await pool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  await waitForDatabase(pool);

  try {
    await pool.query(`
      create table if not exists schema_migrations (
        id text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(config.migrationsDir))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const migrationId = file.replace(/\.sql$/, "");
      const existing = await pool.query("select 1 from schema_migrations where id = $1", [
        migrationId,
      ]);

      if ((existing.rowCount ?? 0) > 0) {
        continue;
      }

      const sql = await readFile(path.join(config.migrationsDir, file), "utf8");
      await pool.query("begin");
      try {
        await pool.query(sql);
        await pool.query("insert into schema_migrations (id) values ($1)", [migrationId]);
        await pool.query("commit");
        console.log(`Applied migration ${migrationId}`);
      } catch (error) {
        await pool.query("rollback");
        throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

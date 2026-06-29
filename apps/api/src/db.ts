import pg from "pg";

export interface Db {
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    pool,
    close: async () => {
      await pool.end();
    },
  };
}

export async function assertDbReady(pool: pg.Pool): Promise<void> {
  await pool.query("select 1");
}

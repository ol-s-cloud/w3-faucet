// packages/shared/src/db.ts
import pg from "pg";
const { Pool } = pg;

/**
 * Take Note: DATABASE_URL must be set in both API and Worker envs.
 * Example: postgres://user:pass@host:5432/dbname
 */
const DATABASE_URL = process.env.DATABASE_URL!;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

/**
 * Create a small, robust pool.
 * Tune `max`/timeouts per environment if needed.
 */
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Basic typed query helper.
 * Example:
 *   const { rows } = await query<{ id: number }>("SELECT 1 AS id");
 */
export async function query<T = any>(
  text: string,
  params?: any[],
): Promise<{ rows: T[] }> {
  return pool.query<T>(text, params);
}

/**
 * One-off client for advanced flows or multiple statements.
 * Provides a `transaction` helper for clean BEGIN/COMMIT/ROLLBACK.
 */
export async function getClient() {
  const client = await pool.connect();

  async function transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    client,
    release: () => client.release(),
    transaction,
  };
}

/**
 * Health probe — cheap connectivity check.
 * Use in /health if you want DB liveness in addition to chain checks.
 */
export async function dbHealthcheck(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Graceful shutdown — call from process.on('SIGTERM') in API/Worker.
 */
export async function closePool() {
  await pool.end();
}

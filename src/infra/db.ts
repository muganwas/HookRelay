import pg from 'pg';
import { config } from '../config.js';

/** Re-exported so other layers can type a client without importing `pg`. */
export type { PoolClient } from 'pg';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function pingDb(): Promise<void> {
  await pool.query('select 1');
}
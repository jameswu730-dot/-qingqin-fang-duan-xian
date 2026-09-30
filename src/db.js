import pg from 'pg';
import { readFile } from 'node:fs/promises';

export const LOCK = 7340921;
export function createPool(env = process.env) {
  const url = new URL(env.DATABASE_URL);
  // URL sslmode must not silently override explicit certificate verification.
  for (const key of ['sslmode','sslcert','sslkey','sslrootcert']) url.searchParams.delete(key);
  return new pg.Pool({ connectionString: url.toString(), max: 3,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    ssl: env.DB_LOCAL_TEST === 'true' ? false : {
      rejectUnauthorized: true, ...(env.DATABASE_CA_CERT ? {ca:env.DATABASE_CA_CERT.replace(/\\n/g,'\n')} : {})
    }
  });
}
export async function transaction(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Single closed-test worker order, including unlink and notification sends.
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function migrate(pool) {
  const sql = await readFile(new URL('../migrations/001_v1.sql', import.meta.url), 'utf8');
  await transaction(pool, async c => {
    await c.query('CREATE TABLE IF NOT EXISTS app_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const {rows} = await c.query('SELECT version FROM app_migrations WHERE version=1');
    if (!rows.length) { await c.query(sql); await c.query('INSERT INTO app_migrations(version) VALUES (1)'); }
  });
}
export function safeLog(code, error) {
  // Never log error.message/stack, HTTP bodies, user IDs, or conversation text.
  const allowed = new Set(['SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','28P01','42501','42P01','42703','23505']);
  const errorClass = error?.name === 'AbortError' ? 'timeout' : allowed.has(error?.code) ? error.code : 'operation_failed';
  console.error(JSON.stringify({code, errorClass}));
}

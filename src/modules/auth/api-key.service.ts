import { createHash, randomBytes } from 'node:crypto';
import { pool } from '../../infra/db.js';

export type VerifiedApiKey = {
  id: string;
  tenantId: string;
  scopes: string[];
};

export type CreatedApiKey = {
  id: string;
  /** Shown exactly once. Only the hash is stored. */
  plaintext: string;
  prefix: string;
};

function hashKey(plaintext: string): Buffer {
  return createHash('sha256').update(plaintext).digest();
}

export async function createApiKey(input: {
  tenantId: string;
  name: string;
  scopes?: string[];
}): Promise<CreatedApiKey> {
  const plaintext = `hr_live_${randomBytes(24).toString('base64url')}`;
  const prefix = plaintext.slice(0, 16);

  const result = await pool.query<{ id: string }>(
    `insert into app.api_keys (id, tenant_id, name, prefix, key_hash, scopes)
     values (gen_random_uuid(), $1, $2, $3, $4, $5)
     returning id::text as id`,
    [input.tenantId, input.name, prefix, hashKey(plaintext), input.scopes ?? []],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error('api key insert returned no row');
  return { id, plaintext, prefix };
}

/**
 * Looks the key up by hash, so the plaintext never touches the database and
 * the comparison is not a string comparison (no timing signal).
 */
export async function verifyApiKey(plaintext: string): Promise<VerifiedApiKey | null> {
  const result = await pool.query<{
    id: string;
    tenant_id: string;
    scopes: string[];
    revoked_at: Date | null;
  }>(
    `select id::text as id, tenant_id, scopes, revoked_at
     from app.api_keys
     where key_hash = $1`,
    [hashKey(plaintext)],
  );

  const row = result.rows[0];
  if (!row || row.revoked_at) return null;

  await pool.query(`update app.api_keys set last_used_at = now() where id = $1`, [row.id]);

  return { id: row.id, tenantId: row.tenant_id, scopes: row.scopes ?? [] };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const result = await pool.query(
    `update app.api_keys set revoked_at = now() where id = $1 and revoked_at is null`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

import { pool } from '../../infra/db.js';

export type AuditEntry = {
  tenantId?: string | null;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  diff?: unknown;
  requestId?: string | null;
};

export type AuditRow = {
  id: string;
  action: string;
  actor: string;
  createdAt: Date;
};

export async function recordAudit(entry: AuditEntry): Promise<AuditRow> {
  const result = await pool.query<{ id: string; action: string; actor: string; created_at: Date }>(
    `insert into audit.audit_log
       (tenant_id, actor, action, entity_type, entity_id, diff, request_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id::text as id, action, actor, created_at`,
    [
      entry.tenantId ?? null,
      entry.actor,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.diff ?? null,
      entry.requestId ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) throw new Error('audit insert returned no row');
  return { id: row.id, action: row.action, actor: row.actor, createdAt: row.created_at };
}

export async function listAudit(entityId: string): Promise<AuditRow[]> {
  const result = await pool.query<{ id: string; action: string; actor: string; created_at: Date }>(
    `select id::text as id, action, actor, created_at
     from audit.audit_log
     where entity_id = $1
     order by id desc`,
    [entityId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    action: row.action,
    actor: row.actor,
    createdAt: row.created_at,
  }));
}

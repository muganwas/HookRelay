import { config, selfBaseUrl } from '../../config.js';
import { pool } from '../../infra/db.js';
import { createApiKey } from '../auth/api-key.service.js';

export const DEMO_TENANT = 'dddddddd-0000-4000-8000-000000000001';
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function baseUrlFrom(input: unknown): string {
  const value = inputRecord(input).baseUrl;
  return typeof value === 'string' ? value : selfBaseUrl;
}

export async function ensureTenant(): Promise<void> {
  await pool.query(
    `insert into app.tenants (id, name) values ($1, 'Lab Tenant') on conflict (id) do nothing`,
    [DEMO_TENANT],
  );
}

export async function ensureEndpoint(url: string, secret: string, events: string[]): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into app.endpoints (id, tenant_id, url, secret, subscribed_events, status)
     values (gen_random_uuid(), $1, $2, $3, $4, 'active')
     on conflict (tenant_id, url) do update
       set secret = excluded.secret,
           subscribed_events = excluded.subscribed_events,
           status = 'active'
     returning id::text as id`,
    [DEMO_TENANT, url, secret, events],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('endpoint upsert returned no row');
  return id;
}

export async function issueKey(scopes: string[], label = 'lab'): Promise<string> {
  await ensureTenant();
  const created = await createApiKey({
    tenantId: DEMO_TENANT,
    name: `${label}-${Date.now()}`,
    scopes,
  });
  return created.plaintext;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index] as T, index);
    }
  });
  await Promise.all(runners);
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function configuredPort(): number {
  return config.PORT;
}

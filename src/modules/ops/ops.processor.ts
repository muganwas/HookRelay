import type { Job } from 'bullmq';
import { pool } from '../../infra/db.js';
import type { OpsJobData } from './ops.job.js';

async function runRetrySweeper(): Promise<number> {
  const res = await pool.query(
    `update app.deliveries
        set status = 'pending', next_attempt_at = now()
      where status = 'retrying' and next_attempt_at <= now()`,
  );
  return res.rowCount ?? 0;
}

async function runDailyDigest(): Promise<number> {
  const res = await pool.query(
    `select status, count(*)::int as count
       from app.deliveries group by status order by status`,
  );
  console.log('daily digest', res.rows);
  return res.rowCount ?? 0;
}

export async function processOpsJob(job: Job<OpsJobData>): Promise<void> {
  const windowStart = new Date(Math.floor(job.timestamp / 60_000) * 60_000);

  const claimed = await pool.query<{ id: string }>(
    `insert into ops.job_runs (job_name, window_start)
     values ($1, $2)
     on conflict (job_name, window_start) do nothing
     returning id`,
    [job.name, windowStart],
  );

  const [run] = claimed.rows;
  if (!run) {
    console.log(`↷ ${job.name} @ ${windowStart.toISOString()} already claimed — skipping`);
    return;
  }

  try {
    const items = job.name === 'retry-sweeper'
      ? await runRetrySweeper()
      : await runDailyDigest();

    await pool.query(
      `update ops.job_runs
          set status = 'succeeded', items_processed = $2, finished_at = now()
        where id = $1`,
      [run.id, items],
    );
    console.log(`✔ ${job.name} @ ${windowStart.toISOString()} — ${items} items`);
  } catch (err) {
    await pool.query(
      `update ops.job_runs set status = 'failed', error = $2, finished_at = now() where id = $1`,
      [run.id, (err as Error).message],
    );
    throw err;
  }
}
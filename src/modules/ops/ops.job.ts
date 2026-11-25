import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../../infra/queue.js';

export const OPS_QUEUE = 'ops';

export type OpsJobData = Record<string, never>;

let queue: Queue<OpsJobData> | undefined;
let connection: Redis | undefined;

export function getOpsQueue(): Queue<OpsJobData> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<OpsJobData>(OPS_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
      },
    });
  }
  return queue;
}

export async function registerSchedulers(): Promise<void> {
  const q = getOpsQueue();

  await q.upsertJobScheduler('retry-sweeper', { every: 60_000 });
  await q.upsertJobScheduler('daily-digest', { pattern: '0 0 6 * * *', tz: 'UTC' });
}

export async function closeOpsQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
  connection?.disconnect();
  connection = undefined;
}
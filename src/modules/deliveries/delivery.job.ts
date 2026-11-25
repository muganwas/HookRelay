import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../../infra/queue.js';

export const DELIVERY_QUEUE = 'deliveries';

export type DeliveryJob = {
  deliveryId: string;
  url: string;
  payload: unknown;
};

let queue: Queue<DeliveryJob> | undefined;
let connection: Redis | undefined;

export function getDeliveryQueue(): Queue<DeliveryJob> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<DeliveryJob>(DELIVERY_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    });
  }
  return queue;
}

export async function enqueueDelivery(job: DeliveryJob) {
  return getDeliveryQueue().add('deliver', job, { jobId: job.deliveryId });
}

/**
 * BullMQ closes only connections it created itself. We passed an external
 * client, so both the queue and that client have to be released explicitly.
 */
export async function closeDeliveryQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
  connection?.disconnect();
  connection = undefined;
}
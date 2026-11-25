import { Queue } from 'bullmq';
import { createRedisConnection } from '../../infra/queue.js';

export const DELIVERY_QUEUE = 'deliveries';

export type DeliveryJob = {
  deliveryId: string;
  url: string;
  payload: unknown;
};

let queue: Queue<DeliveryJob> | undefined;

export function getDeliveryQueue(): Queue<DeliveryJob> {
  queue ??= new Queue<DeliveryJob>(DELIVERY_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400, count: 5_000 },
    },
  });
  return queue;
}

export async function enqueueDelivery(job: DeliveryJob) {
  return getDeliveryQueue().add('deliver', job, { jobId: job.deliveryId });
}
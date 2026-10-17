import { UnrecoverableError, type Job } from 'bullmq';
import type { DeliveryJob } from './delivery.job.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function processDelivery(job: Job<DeliveryJob>): Promise<void> {
  const { deliveryId, url } = job.data;
  const attempt = job.attemptsMade + 1;

  console.log(`→ ${deliveryId} attempt ${attempt}/${job.opts.attempts} → ${url}`);

  const host = new URL(url).hostname;
  if (host.startsWith('slow')) await sleep(5_000);
  else await sleep(300);

  if (host.startsWith('fail-400')) {
    // 4xx repeats identically forever; retrying only wastes attempts.
    throw new UnrecoverableError(`400 from ${host}`);
  }
  if (host.startsWith('fail-500')) {
    throw new Error(`503 from ${host}`);
  }

  console.log(`✔ ${deliveryId} delivered (attempt ${attempt})`);
}
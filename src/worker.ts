import { Worker } from 'bullmq';
import { pool } from './infra/db.js';
import { createRedisConnection } from './infra/queue.js';
import { DELIVERY_QUEUE, type DeliveryJob } from './modules/deliveries/delivery.job.js';
import { processDelivery } from './modules/deliveries/delivery.processor.js';
import { OPS_QUEUE, getOpsQueue, registerSchedulers, type OpsJobData } from './modules/ops/ops.job.js';
import { processOpsJob } from './modules/ops/ops.processor.js';

const instance = process.env.INSTANCE_NAME ?? `worker-${process.pid}`;

const deliveryWorker = new Worker<DeliveryJob>(DELIVERY_QUEUE, processDelivery, {
  connection: createRedisConnection(),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
});

const opsWorker = new Worker<OpsJobData>(OPS_QUEUE, processOpsJob, {
  connection: createRedisConnection(),
  concurrency: 1,
});

deliveryWorker.on('completed', (job) => {
  // attemptsMade is already 1-based: it is 1 after the first successful attempt.
  console.log(`[${instance}] ✔ ${job.id} after ${job.attemptsMade} attempt(s)`);
});

deliveryWorker.on('failed', (job, err) => {
  if (!job) return;
  const max = job.opts.attempts ?? 1;
  const terminal = job.attemptsMade >= max;
  console.log(
    `[${instance}] ${terminal ? '☠ dead' : '↻ retrying'} ${job.id} ` +
      `(attempt ${job.attemptsMade}/${max}): ${err.message}`,
  );
});

deliveryWorker.on('error', (err) => console.error(`[${instance}] worker error`, err));

await registerSchedulers();
console.log(`[${instance}] worker up, queues: ${DELIVERY_QUEUE}, ${OPS_QUEUE}`);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${instance}] ${signal}: draining, active jobs finish first`);

  const force = setTimeout(() => {
    console.error(`[${instance}] drain timed out`);
    process.exit(1);
  }, 30_000);
  force.unref();

  await Promise.all([deliveryWorker.close(), opsWorker.close()]);
  await getOpsQueue().close();
  await pool.end();

  clearTimeout(force);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
import { pool } from '../src/infra/db.js';
import { redis } from '../src/infra/redis.js';
import { closeDeliveryQueue } from '../src/modules/deliveries/delivery.job.js';
import { closeOpsQueue } from '../src/modules/ops/ops.job.js';

/**
 * Closes every long-lived handle so a failing suite cannot hang the runner.
 * `redis.disconnect()` is deliberate: quit() waits for a reply, which never
 * arrives if Redis is down.
 */
export async function closeResources(): Promise<void> {
  await Promise.allSettled([closeDeliveryQueue(), closeOpsQueue()]);
  redis.disconnect();
  await pool.end().catch(() => undefined);
}

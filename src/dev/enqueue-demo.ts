import { getDeliveryQueue, enqueueDelivery } from '../modules/deliveries/delivery.job.js';

const ok = '11111111-0000-4000-8000-000000000001';
const flaky = '11111111-0000-4000-8000-000000000002';
const bad = '11111111-0000-4000-8000-000000000003';

await enqueueDelivery({ deliveryId: ok, url: 'https://ok.test/hooks', payload: { n: 1 } });
await enqueueDelivery({ deliveryId: flaky, url: 'https://fail-500.test/hooks', payload: { n: 2 } });
await enqueueDelivery({ deliveryId: bad, url: 'https://fail-400.test/hooks', payload: { n: 3 } });

// SAME jobId as the first: BullMQ must ignore this one.
const dup = await enqueueDelivery({ deliveryId: ok, url: 'https://ok.test/hooks', payload: { n: 99 } });
console.log(`duplicate enqueue returned job ${dup.id} (no second job created)`);

await getDeliveryQueue().close();
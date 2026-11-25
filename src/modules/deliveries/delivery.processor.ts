import { UnrecoverableError, type Job } from 'bullmq';
import type { DeliveryJob } from './delivery.job.js';
import { loadForDelivery, recordAttempt } from './delivery.service.js';
import { buildSignatureHeader } from '../webhooks/signature.js';

const TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;

type HttpResult = { status: number; body: string; error: string | null };

async function post(url: string, body: string, headers: Record<string, string>): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: controller.signal,
      // Never follow redirects: a receiver could bounce us to an internal host.
      redirect: 'manual',
    });
    const text = await response.text();
    return { status: response.status, body: text.slice(0, 1000), error: null };
  } catch (error) {
    return { status: 0, body: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

type Verdict = 'succeeded' | 'retryable' | 'terminal';

function classify(status: number): Verdict {
  if (status >= 200 && status < 300) return 'succeeded';
  if (status === 0) return 'retryable'; // network error or timeout
  if (status === 429 || status >= 500) return 'retryable';
  return 'terminal'; // other 4xx will repeat identically forever
}

export async function processDelivery(job: Job<DeliveryJob>): Promise<void> {
  const { deliveryId, url } = job.data;
  const attemptNo = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;

  if (url) {
    // Lab mode: real HTTP, but nothing is read from or written to the database.
    const result = await post(url, JSON.stringify(job.data.payload ?? {}), {
      'content-type': 'application/json',
      'x-lab-delivery': deliveryId,
      'x-lab-attempt': String(attemptNo),
    });
    const verdict = classify(result.status);

    if (verdict === 'succeeded') return;
    if (verdict === 'terminal') throw new UnrecoverableError(`HTTP ${result.status} from ${url}`);
    throw new Error(result.error ?? `HTTP ${result.status} from ${url}`);
  }

  const record = await loadForDelivery(deliveryId);
  if (!record) throw new UnrecoverableError(`delivery ${deliveryId} no longer exists`);

  // Replay safety: a redelivered job must not send a second webhook.
  if (record.status === 'succeeded') return;

  const body = JSON.stringify({
    id: record.event.id,
    type: record.event.type,
    payload: record.event.payload,
    createdAt: record.event.createdAt,
  });

  const started = Date.now();
  const result = await post(record.endpoint.url, body, {
    'content-type': 'application/json',
    'x-hookrelay-signature': buildSignatureHeader(record.endpoint.secret, body),
    'x-hookrelay-event-id': record.event.id,
    'x-hookrelay-delivery-id': record.id,
    'x-hookrelay-attempt': String(attemptNo),
  });
  const durationMs = Date.now() - started;
  const verdict = classify(result.status);

  const outcome =
    verdict === 'succeeded'
      ? 'succeeded'
      : verdict === 'terminal' || attemptNo >= maxAttempts
        ? 'dead'
        : 'retrying';

  await recordAttempt({
    deliveryId: record.id,
    endpointId: record.endpoint.id,
    attemptNo,
    responseStatus: result.status || null,
    responseBody: result.body || null,
    durationMs,
    error: verdict === 'succeeded' ? null : (result.error ?? `HTTP ${result.status}`),
    outcome,
    nextAttemptAt:
      outcome === 'retrying' ? new Date(Date.now() + BACKOFF_BASE_MS * 2 ** (attemptNo - 1)) : null,
  });

  if (outcome === 'succeeded') return;
  if (outcome === 'dead') throw new UnrecoverableError(result.error ?? `HTTP ${result.status}`);
  throw new Error(result.error ?? `HTTP ${result.status}`);
}

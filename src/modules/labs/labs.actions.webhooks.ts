import http from 'node:http';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { selfBaseUrl, inboundWebhookSecret } from '../../config.js';
import { pool } from '../../infra/db.js';
import { createApiKey } from '../auth/api-key.service.js';
import { createEvent } from '../events/event.service.js';
import { getDeliveryView, isTerminal, listAttempts } from '../deliveries/delivery.service.js';
import { buildSignatureHeader } from '../webhooks/signature.js';

const DEMO_TENANT = 'dddddddd-0000-4000-8000-000000000001';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureTenant(): Promise<void> {
  await pool.query(
    `insert into app.tenants (id, name) values ($1, 'Lab Tenant') on conflict (id) do nothing`,
    [DEMO_TENANT],
  );
}

async function ensureEndpoint(url: string, secret: string, events: string[]): Promise<string> {
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

async function issueKey(scopes: string[]): Promise<string> {
  await ensureTenant();
  const created = await createApiKey({
    tenantId: DEMO_TENANT,
    name: `lab-webhooks-${Date.now()}`,
    scopes,
  });
  return created.plaintext;
}

async function waitForTerminal(deliveryId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let view = await getDeliveryView(deliveryId);

  while (view && !isTerminal(view.status) && Date.now() < deadline) {
    await sleep(200);
    view = await getDeliveryView(deliveryId);
  }

  return view;
}

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

function rawGet(url: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'GET', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    request.on('error', reject);
    request.end();
  });
}

async function webhooksOutbound(): Promise<ActionResult> {
  await ensureTenant();

  const receiverUrl = `${selfBaseUrl}/v1/webhooks/inbound/lab`;
  const endpointId = await ensureEndpoint(receiverUrl, inboundWebhookSecret, ['lab.webhook']);

  const created = await createEvent({
    tenantId: DEMO_TENANT,
    type: 'lab.webhook',
    payload: { orderId: `ord_${Date.now()}`, amount: 4999 },
    idempotencyKey: `lab-hook-${Date.now()}`,
  });

  const deliveryId = created.deliveryIds[0];
  if (!deliveryId) {
    return {
      title: 'No delivery was created',
      summary: `Endpoint ${endpointId} is subscribed to lab.webhook but nothing was queued.`,
      notes: ['Check app.endpoints subscribed_events contains "lab.webhook".'],
    };
  }

  const view = await waitForTerminal(deliveryId, 15_000);
  const attempts = await listAttempts(deliveryId);

  const inbound = await pool.query<{ provider_event_id: string }>(
    `select provider_event_id from app.inbound_events where source = 'lab' and provider_event_id = $1`,
    [created.eventId],
  );

  const terminal = view ? isTerminal(view.status) : false;

  return {
    title: terminal
      ? view?.status === 'succeeded'
        ? 'Signed, delivered, verified and recorded'
        : `Delivery ended ${view?.status}`
      : 'Still pending — is the worker running?',
    summary:
      'The worker signed the body, called this API back, the receiver verified the HMAC over the raw bytes, then deduped on the event id.',
    table: {
      columns: ['Stage', 'Observation'],
      rows: [
        ['endpoint', receiverUrl],
        ['delivery status', view?.status ?? '(missing)'],
        ['attempts recorded', attempts.length],
        ['last response status', view?.lastResponseStatus ?? '—'],
        ['receiver row for event id', inbound.rows[0] ? 'present' : 'absent'],
        ['event id used for dedupe', created.eventId],
      ],
    },
    notes: [
      'This is a real HTTP round trip: worker -> api -> verify -> insert.',
      terminal
        ? 'The delivery is terminal, so a replay would be absorbed by the receiver dedupe.'
        : 'Start the worker (`npm run worker`, or the worker container) and run this again.',
      'The signature covers `${timestamp}.${body}`; the receiver recomputes it over the raw Buffer.',
      attempts.length > 0
        ? `Attempt 1 returned ${attempts[0]?.responseStatus ?? 'no status'} in ${attempts[0]?.durationMs ?? 0} ms.`
        : 'No attempt rows yet.',
    ],
    raw: { delivery: view, attempts },
  };
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function baseUrlFrom(input: unknown): string {
  const value = inputRecord(input).baseUrl;
  return typeof value === 'string' ? value : selfBaseUrl;
}

async function webhooksInbound(input: unknown): Promise<ActionResult> {
  const endpoint = `${baseUrlFrom(input)}/v1/webhooks/inbound/lab`;
  const eventId = `evt_lab_${Date.now()}`;
  const body = JSON.stringify({ id: eventId, type: 'order.created', amount: 4999 });

  async function send(payload: string, header: string | null, id: string): Promise<number> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-event-id': id,
    };
    if (header) headers['x-signature'] = header;

    const response = await fetch(endpoint, { method: 'POST', headers, body: payload });
    await response.text();
    return response.status;
  }

  const now = Math.floor(Date.now() / 1000);
  const valid = buildSignatureHeader(inboundWebhookSecret, body, now);
  const stale = buildSignatureHeader(inboundWebhookSecret, body, now - 400);

  const fresh = await send(body, valid, eventId);
  const replay = await send(body, valid, eventId);
  const tampered = await send(body.replace('4999', '1'), valid, `${eventId}_t`);
  const staleResult = await send(body, stale, `${eventId}_s`);
  const unsigned = await send(body, null, `${eventId}_u`);

  return {
    title: 'Fresh accepted, replay deduped, the rest rejected',
    summary:
      'The receiver has no API key: the HMAC over the raw body is the credential, and the provider event id is the idempotency key.',
    table: {
      columns: ['Case', 'Status', 'Meaning'],
      rows: [
        ['valid signature, new event id', fresh, '202 accepted'],
        ['same event id again', replay, '200 duplicate — absorbed, not reprocessed'],
        ['body changed after signing', tampered, '401 signature mismatch'],
        ['timestamp 400s old', staleResult, '401 outside the 300s tolerance'],
        ['no signature header', unsigned, '401 missing signature header'],
      ],
    },
    notes: [
      'Rejecting a replay matters because the provider retries on network errors — the same event WILL arrive twice.',
      'A 200 with duplicate:true is the receiver telling the provider "already handled, stop retrying".',
      'The tampered body keeps the original signature, which is exactly the attack a signature prevents.',
    ],
  };
}

async function pollingLifecycle(): Promise<ActionResult> {
  await ensureTenant();

  const targetUrl = `${selfBaseUrl}/labs/api/targets/200?lab=polling`;
  await ensureEndpoint(targetUrl, 'whsec_polling_lab', ['lab.polling']);
  const key = await issueKey(['deliveries:read', 'events:write']);

  const created = await createEvent({
    tenantId: DEMO_TENANT,
    type: 'lab.polling',
    payload: { at: Date.now() },
    idempotencyKey: `lab-poll-${Date.now()}`,
  });

  const deliveryId = created.deliveryIds[0];
  if (!deliveryId) {
    return {
      title: 'No delivery was created',
      summary: 'The lab.polling endpoint did not produce a delivery.',
      notes: ['Check that app.endpoints has an active subscription for lab.polling.'],
    };
  }

  const view = await waitForTerminal(deliveryId, 15_000);
  const url = `${selfBaseUrl}/v1/deliveries/${deliveryId}`;

  const first = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  await first.text();
  const etag = first.headers.get('etag');

  const conditional = await rawGet(url, {
    authorization: `Bearer ${key}`,
    ...(etag ? { 'if-none-match': etag } : {}),
  });

  const waitStarted = Date.now();
  const waited = await rawGet(`${url}?wait=5`, { authorization: `Bearer ${key}` });
  const waitedMs = Date.now() - waitStarted;

  return {
    title:
      conditional.status === 304
        ? `Polling costs one 304 and the long-poll returned in ${waitedMs} ms`
        : `Conditional request returned ${conditional.status}`,
    summary:
      'A terminal delivery means the long-poll returns immediately; an unchanged body means the conditional request costs no bytes.',
    table: {
      columns: ['Step', 'Status', 'Body bytes', 'Elapsed ms'],
      rows: [
        ['GET delivery', first.status, first.headers.get('content-length') ?? '(chunked)', 0],
        ['GET with If-None-Match', conditional.status, conditional.body.length, 0],
        ['GET ?wait=5 (terminal)', waited.status, waited.body.length, waitedMs],
      ],
    },
    notes: [
      `Delivery ${deliveryId} is "${view?.status ?? 'unknown'}" after ${view?.attempts ?? 0} attempt(s).`,
      'The long-poll short-circuits on terminal state, which is why 5s became a few milliseconds.',
      'While it is still pending, the same call would hold the connection — that is the latency win over a 1s poll loop.',
      `ETag: ${etag ?? '(none)'}`,
      'Node fetch injects cache-control: no-cache when you send If-None-Match, so this uses node:http for that step.',
    ],
  };
}

export const webhookActions: ActionDefinition[] = [
  {
    id: 'webhooks.outbound',
    label: 'Deliver a signed event end to end',
    topicId: 'webhooks',
    run: webhooksOutbound,
  },
  {
    id: 'webhooks.inbound',
    label: 'Accept, dedupe and reject',
    topicId: 'webhooks',
    run: webhooksInbound,
  },
  {
    id: 'polling.lifecycle',
    label: 'Poll a delivery with ETag and long-poll',
    topicId: 'polling',
    run: pollingLifecycle,
  },
];

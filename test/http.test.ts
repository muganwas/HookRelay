import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { getLabAction } from '../src/modules/labs/labs.actions.js';
import { topics } from '../src/modules/labs/labs.topics.js';
import type { ActionResult } from '../src/modules/labs/labs.types.js';
import { closeResources } from './helpers.js';

let server: Server;
let baseUrl = '';

before(async () => {
  server = createApp().listen(0) as Server;
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeResources();
});

describe('static UI', () => {
  it('serves the labs page', async () => {
    const response = await fetch(`${baseUrl}/labs`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(body, /Interview Labs/);
  });

  it('does not leak the framework', async () => {
    const response = await fetch(`${baseUrl}/labs`);
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('serves the stylesheet and script', async () => {
    const css = await fetch(`${baseUrl}/labs/labs.css`);
    const js = await fetch(`${baseUrl}/labs/labs.js`);

    assert.equal(css.status, 200);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
  });
});

describe('topics endpoint', () => {
  it('returns every topic', async () => {
    const response = await fetch(`${baseUrl}/labs/api/topics`);
    const payload = (await response.json()) as {
      topics: Array<{ id: string; actions: unknown[] }>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.topics.length, topics.length);
  });

  it('keeps declared order', async () => {
    const payload = (await fetch(`${baseUrl}/labs/api/topics`).then((r) => r.json())) as {
      topics: Array<{ order: number }>;
    };
    const orders = payload.topics.map((t) => t.order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  });
});

describe('action endpoint', () => {
  it('runs an action and reports duration', async () => {
    const response = await fetch(`${baseUrl}/labs/api/actions/architecture.layers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as {
      actionId: string;
      durationMs: number;
      data: ActionResult;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.actionId, 'architecture.layers');
    assert.equal(typeof payload.durationMs, 'number');
    assert.ok(payload.data.table);
  });

  it('returns 404 with a stable shape for an unknown action', async () => {
    const response = await fetch(`${baseUrl}/labs/api/actions/not-a-real-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await response.json()) as {
      error: { code: string; message: string };
      requestId: string;
    };

    assert.equal(response.status, 404);
    assert.equal(payload.error.code, 'NOT_FOUND');
    assert.ok(payload.requestId);
  });

  it('returns 404 for an unmatched route', async () => {
    const response = await fetch(`${baseUrl}/labs/api/nope`);
    const payload = (await response.json()) as { error: { code: string } };

    assert.equal(response.status, 404);
    assert.equal(payload.error.code, 'NOT_FOUND');
  });
});

describe('error contract', () => {
  it('serialises a ConflictError as 409 with the inbound request id', async () => {
    const response = await fetch(`${baseUrl}/labs/api/probe/error`, {
      headers: { 'x-request-id': 'http-test-trace' },
    });
    const payload = (await response.json()) as {
      error: { code: string; message: string; details: unknown };
      requestId: string;
    };

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, 'CONFLICT');
    assert.equal(payload.requestId, 'http-test-trace');
    assert.equal(response.headers.get('x-request-id'), 'http-test-trace');
    assert.ok(payload.error.details);
  });

  it('never leaks a stack trace', async () => {
    const body = await fetch(`${baseUrl}/labs/api/probe/error`).then((r) => r.text());
    assert.doesNotMatch(body, /at .*\.ts:\d+/);
  });
});

describe('server-dependent demos', () => {
  it('middleware.error-contract observes the 409 it triggers', async () => {
    const action = getLabAction('middleware.error-contract');
    assert.ok(action);

    const result = await action.run({ baseUrl });
    const rows = result.table?.rows ?? [];
    const byLabel = new Map(rows.map((row) => [String(row[0]), String(row[1])]));

    assert.match(result.title, /409/);
    assert.equal(byLabel.get('HTTP status'), '409');
    assert.equal(byLabel.get('x-powered-by'), '(absent — good)');
    assert.match(byLabel.get('body') ?? '', /CONFLICT/);
  });

  it('polling.etag gets 200 then 304', async () => {
    const action = getLabAction('polling.etag');
    assert.ok(action);

    const result = await action.run({ baseUrl });
    const rows = result.table?.rows ?? [];

    assert.match(result.title, /First 200, second 304/);
    assert.equal(rows[1]?.[1], 304, 'conditional request did not return 304');
    assert.equal(rows[1]?.[3], 0, '304 must carry no body');
    assert.ok(Number(rows[0]?.[3]) > 0, 'first response should have a body');
  });
});

describe('health', () => {
  it('still reports ok with both dependencies', async () => {
    const response = await fetch(`${baseUrl}/v1/health`);
    const payload = (await response.json()) as {
      status: string;
      checks: { db: string; redis: string };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.checks, { db: 'ok', redis: 'ok' });
  });
});

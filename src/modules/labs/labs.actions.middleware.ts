import { createHash } from 'node:crypto';
import type { ActionDefinition, ActionResult } from './labs.types.js';
import { config } from '../../config.js';
import { pool } from '../../infra/db.js';
import { createApiKey } from '../auth/api-key.service.js';
import { ECHO_RATE_LIMIT } from '../echo/echo.routes.js';

const DEMO_TENANT = 'dddddddd-0000-4000-8000-000000000001';

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function baseUrlFrom(input: unknown): string {
  const value = inputRecord(input).baseUrl;
  return typeof value === 'string' ? value : `http://127.0.0.1:${config.PORT}`;
}

async function ensureDemoTenant(): Promise<void> {
  await pool.query(
    `insert into app.tenants (id, name) values ($1, 'Middleware Lab') on conflict (id) do nothing`,
    [DEMO_TENANT],
  );
}

async function issueKey(scopes: string[], name: string): Promise<string> {
  await ensureDemoTenant();
  const created = await createApiKey({ tenantId: DEMO_TENANT, name, scopes });
  return created.plaintext;
}

type EchoResponse = {
  status: number;
  headers: Headers;
  body: string;
};

async function callEcho(
  baseUrl: string,
  options: { token?: string; body?: string; raw?: boolean } = {},
): Promise<EchoResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}/v1/echo`, {
    method: 'POST',
    headers,
    body: options.body ?? JSON.stringify({ message: 'hello', count: 2 }),
  });

  return { status: response.status, headers: response.headers, body: await response.text() };
}

function errorCode(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? '(none)';
  } catch {
    return '(unparseable)';
  }
}

async function middlewareAuth(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const token = await issueKey(['echo:write'], `lab-auth-${Date.now()}`);
  const weakToken = await issueKey([], `lab-noscope-${Date.now()}`);
  const revokedToken = await issueKey(['echo:write'], `lab-revoked-${Date.now()}`);

  const ok = await callEcho(baseUrl, { token });
  const missing = await callEcho(baseUrl, {});
  const bogus = await callEcho(baseUrl, { token: 'hr_live_not_a_real_key' });
  const noScope = await callEcho(baseUrl, { token: weakToken });

  // Revoke the third key so the last case proves revocation, not just a typo.
  const revokedId = await pool.query<{ id: string }>(
    `select id::text as id from app.api_keys where prefix = $1 order by created_at desc limit 1`,
    [revokedToken.slice(0, 16)],
  );
  const id = revokedId.rows[0]?.id;
  if (id) await pool.query(`update app.api_keys set revoked_at = now() where id = $1`, [id]);
  const revoked = await callEcho(baseUrl, { token: revokedToken });

  const parsed = ok.status === 200 ? (JSON.parse(ok.body) as { tenantId?: string }) : {};

  return {
    title: ok.status === 200 ? 'Valid key accepted, everything else rejected' : 'Auth did not accept the valid key',
    summary:
      'Keys are stored as a SHA-256 hash, so the plaintext exists only in the response that created it. Lookup is by hash, not by string compare.',
    table: {
      columns: ['Case', 'Status', 'Error code', 'Why'],
      rows: [
        ['valid key + echo:write scope', ok.status, errorCode(ok.body), `tenant ${parsed.tenantId ?? '?'}`],
        ['no Authorization header', missing.status, errorCode(missing.body), 'missing bearer token'],
        ['well-formed but unknown key', bogus.status, errorCode(bogus.body), 'no row matches the hash'],
        ['valid key, wrong scope', noScope.status, errorCode(noScope.body), 'scope check fails after auth'],
        ['revoked key', revoked.status, errorCode(revoked.body), 'revoked_at is set'],
      ],
    },
    notes: [
      '401 = "I do not know you". 403 = "I know you, but not for this". Mixing them up leaks information.',
      'The demo created three real API keys in app.api_keys and revoked one — the table is finally used.',
      'Hashing means a database dump cannot be replayed against the API.',
    ],
  };
}

async function middlewareValidation(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const token = await issueKey(['echo:write'], `lab-validation-${Date.now()}`);

  const missingField = await callEcho(baseUrl, { token, body: JSON.stringify({ count: 2 }) });
  const wrongType = await callEcho(baseUrl, { token, body: JSON.stringify({ message: 42 }) });
  const extraField = await callEcho(baseUrl, { token, body: JSON.stringify({ message: 'hi', extra: true }) });
  const tooLong = await callEcho(baseUrl, { token, body: JSON.stringify({ message: 'x'.repeat(201) }) });
  const valid = await callEcho(baseUrl, { token, body: JSON.stringify({ message: 'hi', count: 3 }) });

  function issues(body: string): Array<[string, string]> {
    try {
      const parsed = JSON.parse(body) as {
        error?: { details?: { issues?: Array<{ path: string; message: string }> } };
      };
      return (parsed.error?.details?.issues ?? []).map((issue) => [issue.path, issue.message]);
    } catch {
      return [];
    }
  }

  const rows: Array<Array<string | number | null>> = [
    ['missing required field', missingField.status, issues(missingField.body)[0]?.join(' → ') ?? ''],
    ['wrong type', wrongType.status, issues(wrongType.body)[0]?.join(' → ') ?? ''],
    ['unknown field (strict object)', extraField.status, issues(extraField.body)[0]?.join(' → ') ?? ''],
    ['too long', tooLong.status, issues(tooLong.body)[0]?.join(' → ') ?? ''],
    ['valid body', valid.status, 'accepted'],
  ];

  const allRejected = [missingField, wrongType, extraField, tooLong].every((r) => r.status === 400);

  return {
    title: allRejected ? 'Every invalid body became a 400 with structured issues' : 'A validation case slipped through',
    summary:
      'zod parses once at the edge and replaces req.body with the parsed value. Downstream code never re-checks types.',
    table: {
      columns: ['Case', 'Status', 'First issue'],
      rows,
    },
    notes: [
      'The error envelope is the same one used for every failure: code, message, details, requestId.',
      'strictObject rejects unknown keys — that is how typos and mass-assignment attempts surface.',
      'Validation runs after rate limiting on purpose: a flood of invalid requests still consumes budget.',
    ],
  };
}

async function middlewareRateLimit(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const token = await issueKey(['echo:write'], `lab-ratelimit-${Date.now()}`);
  const attempts = ECHO_RATE_LIMIT.limit + 2;

  const results: EchoResponse[] = [];
  for (let index = 0; index < attempts; index += 1) {
    results.push(await callEcho(baseUrl, { token }));
  }

  const allowed = results.filter((r) => r.status === 200).length;
  const limited = results.filter((r) => r.status === 429).length;
  const retryAfter = results.find((r) => r.status === 429)?.headers.get('retry-after') ?? '(none)';

  return {
    title: `${allowed} allowed, ${limited} rejected in one window`,
    summary: `Each API key gets its own fixed-window bucket of ${ECHO_RATE_LIMIT.limit} per ${ECHO_RATE_LIMIT.windowSeconds}s.`,
    table: {
      columns: ['Request', 'Status', 'ratelimit-remaining', 'retry-after'],
      rows: results.map((result, index) => [
        index + 1,
        result.status,
        result.headers.get('ratelimit-remaining') ?? '',
        result.headers.get('retry-after') ?? '—',
      ]),
    },
    notes: [
      `A new key was created for this run, which is why the bucket starts empty. Reusing a key would inherit its count.`,
      `429 carries Retry-After: ${retryAfter} so a well-behaved client backs off instead of hammering.`,
      'Fixed window is cheap but allows a 2x burst across the boundary; a sliding window or token bucket removes that.',
      'The limiter fails open: if Redis is down the request proceeds, because throttling must not become an outage.',
    ],
  };
}

async function middlewareRawBody(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const token = await issueKey(['echo:write'], `lab-rawbody-${Date.now()}`);

  // Deliberately odd formatting: key order, spacing, and a trailing space.
  const rawBody = '{ "message" :  "raw-bytes-matter",  "count":7 }  ';
  const clientHash = createHash('sha256').update(rawBody).digest('hex');

  const response = await fetch(`${baseUrl}/v1/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: rawBody,
  });
  const payload = (await response.json()) as {
    rawBodyBytes?: number;
    rawBodySha256?: string | null;
    received?: unknown;
  };

  const matches = payload.rawBodySha256 === clientHash;

  return {
    title: matches ? 'Server hash matches the bytes the client sent' : 'Hashes differ',
    summary:
      'This is the prerequisite for webhook signatures: HMAC must run over the exact bytes received, not over re-serialised JSON.',
    table: {
      columns: ['Item', 'Value'],
      rows: [
        ['status', response.status],
        ['client sha256', clientHash.slice(0, 32) + '…'],
        ['server sha256', (payload.rawBodySha256 ?? '(null)').slice(0, 32) + '…'],
        ['match', matches],
        ['raw bytes received', payload.rawBodyBytes ?? 0],
        ['raw bytes as sent', Buffer.byteLength(rawBody)],
      ],
    },
    notes: [
      'The body has odd spacing and a trailing space on purpose — a re-serialised object would hash differently.',
      'express.json({ verify }) runs before parsing, which is the only place the original Buffer exists.',
      'Change one byte and the signature stops matching; that is the entire point of signing the raw body.',
      payload.received ? `Parsed body: ${JSON.stringify(payload.received)}` : 'Parsed body missing',
    ],
  };
}

export const middlewareActions: ActionDefinition[] = [
  { id: 'middleware.auth', label: 'Authenticate with an API key', topicId: 'middleware', run: middlewareAuth },
  {
    id: 'middleware.validation',
    label: 'Validate a body',
    topicId: 'middleware',
    run: middlewareValidation,
  },
  {
    id: 'middleware.ratelimit',
    label: 'Exceed the rate limit',
    topicId: 'middleware',
    run: middlewareRateLimit,
  },
  {
    id: 'middleware.rawbody',
    label: 'Prove raw bytes are captured',
    topicId: 'middleware',
    run: middlewareRawBody,
  },
];

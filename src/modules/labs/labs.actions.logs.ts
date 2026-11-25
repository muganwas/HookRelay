import type { ActionDefinition, ActionResult } from './labs.types.js';
import { config } from '../../config.js';
import { createCapturingLogger } from '../../infra/logger.js';
import { LOG_STREAM, LOG_STREAM_MAXLEN, appendLog, recentLogs, streamLength } from '../../infra/log-stream.js';
import { listAudit, recordAudit } from '../audit/audit.service.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function baseUrlFrom(input: unknown): string {
  const value = inputRecord(input).baseUrl;
  return typeof value === 'string' ? value : `http://127.0.0.1:${config.PORT}`;
}

async function logsStructured(): Promise<ActionResult> {
  const { logger, lines } = createCapturingLogger('info');
  const requestId = `log-demo-${Date.now()}`;

  logger.debug({ requestId }, 'debug.line.dropped.at.info.level');
  logger.info(
    {
      requestId,
      tenantId: 'tenant_demo',
      secret: 'whsec_super_secret_value',
      apiKey: 'hr_live_abc123',
      payload: { orderId: 'ord_1', amount: 4999 },
    },
    'delivery.attempted',
  );
  logger.error({ err: new Error('upstream returned 503') }, 'delivery.failed');

  const joined = lines.join('\n');

  return {
    title: `${lines.length} lines written, 1 dropped`,
    summary:
      'One JSON object per line. Redaction happens inside the logger, before the bytes are written: not at read time.',
    table: {
      columns: ['#', 'Rendered line'],
      rows: lines.map((line, index) => [index + 1, line]),
    },
    notes: [
      `Emitting at level "debug" produced nothing because this logger runs at "info". Level filtering is per logger, not per call.`,
      joined.includes('whsec_super_secret_value')
        ? 'LEAK: the secret reached the output.'
        : 'Both `secret` and `apiKey` are `[redacted]`: the secret string never reaches the sink.',
      'The Error is serialised as type/message/stack instead of collapsing to {}.',
      'Production sends these lines to stdout; the platform collects them. Files need rotation or they fill the disk.',
    ],
  };
}

async function logsStream(): Promise<ActionResult> {
  const before = await streamLength();
  const stamp = Date.now();
  const ids: string[] = [];

  for (let index = 1; index <= 3; index += 1) {
    ids.push(
      await appendLog({
        level: 'info',
        msg: 'lab.stream.sample',
        requestId: `lab-stream-${stamp}-${index}`,
        seq: index,
      }),
    );
  }

  const recent = await recentLogs(5);
  const after = await streamLength();

  return {
    title: `${after - before} entries appended to ${LOG_STREAM}`,
    summary:
      'XADD returns the entry id (milliseconds-sequence). XREVRANGE reads newest first, which is what a live tail does.',
    table: {
      columns: ['Id', 'Level', 'Message', 'Request id'],
      rows: recent.map((entry) => [
        entry.id,
        entry.fields.level ?? '',
        entry.fields.msg ?? '',
        entry.fields.requestId ?? '',
      ]),
    },
    notes: [
      `Stream length is ${after}; the sink is capped at ~${LOG_STREAM_MAXLEN} with MAXLEN ~.`,
      'The `~` means Redis trims at whole macro-nodes instead of exactly: cheaper, slightly imprecise.',
      'This is why Streams beat Pub/Sub for logs: entries persist, can be replayed, and support consumer groups.',
      `Newest three ids: ${ids.join(', ')}`,
    ],
  };
}

async function logsCorrelation(input: unknown): Promise<ActionResult> {
  const baseUrl = baseUrlFrom(input);
  const requestId = `log-corr-${Date.now()}`;

  const response = await fetch(`${baseUrl}/v1/health`, {
    headers: { 'x-request-id': requestId },
  });
  await response.text();

  // res.on('finish') appends asynchronously; give it a moment.
  await sleep(250);

  const matches = (await recentLogs(100)).filter((entry) => entry.fields.requestId === requestId);
  const entry = matches[0];

  return {
    title: matches.length > 0 ? 'One request, one traceable line' : 'No log line found for that id',
    summary:
      'The inbound x-request-id is reused by the requestId middleware, then written by the request logger. That is the whole correlation story.',
    table: {
      columns: ['Field', 'Value'],
      rows: entry
        ? Object.entries(entry.fields).map(([key, value]) => [key, value])
        : [['requestId', requestId], ['result', 'nothing matched in the last 100 entries']],
    },
    notes: [
      `Request answered with ${response.status}; the id echoed back in the x-request-id header.`,
      'For async work, put the same requestId in the job payload so worker logs join up with the HTTP request.',
      'Without an inbound id the middleware generates a UUID, so the chain always has a root.',
      'The logger records `originalUrl`, not `req.path`: inside a mounted router the path is relative and would log "/".',
    ],
  };
}

async function logsAudit(): Promise<ActionResult> {
  const entityId = `endpoint_lab_${Date.now()}`;

  const created = await recordAudit({
    actor: 'user:lab',
    action: 'endpoint.created',
    entityType: 'endpoint',
    entityId,
    diff: { before: null, after: { url: 'https://example.test/hooks', status: 'active' } },
    requestId: 'lab-audit-demo',
  });

  const rows = await listAudit(entityId);

  return {
    title: `${rows.length} audit row written`,
    summary:
      'Audit rows are business records: append-only, no foreign key to tenants, and retained far longer than app logs.',
    table: {
      columns: ['Id', 'Action', 'Actor', 'Created at'],
      rows: rows.map((row) => [row.id, row.action, row.actor, row.createdAt.toISOString()]),
    },
    notes: [
      `Inserted id ${created.id} for entity ${entityId}.`,
      'This is the first code path that writes to audit.audit_log: the table existed since migration 001.',
      'No FK on tenant_id on purpose: deleting a tenant must not erase the evidence of what it did.',
      'Retention differs from app logs: days for logs, years for audit. That is why they are separate schemas.',
    ],
  };
}

export const logActions: ActionDefinition[] = [
  {
    id: 'logs.structured',
    label: 'Render a structured line',
    topicId: 'logs',
    run: logsStructured,
  },
  {
    id: 'logs.stream',
    label: 'Append to the Redis Stream',
    topicId: 'logs',
    run: logsStream,
  },
  {
    id: 'logs.correlation',
    label: 'Trace one request by id',
    topicId: 'logs',
    run: logsCorrelation,
  },
  {
    id: 'logs.audit',
    label: 'Write and read an audit row',
    topicId: 'logs',
    run: logsAudit,
  },
];

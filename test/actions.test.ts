import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { getLabAction, labActions } from '../src/modules/labs/labs.actions.js';
import type { ActionResult } from '../src/modules/labs/labs.types.js';
import { closeResources } from './helpers.js';

/** These need a listening server, so they are covered in http.test.ts. */
const SERVER_DEPENDENT = new Set([
  'middleware.error-contract',
  'middleware.auth',
  'middleware.validation',
  'middleware.ratelimit',
  'middleware.rawbody',
  'polling.etag',
  'logs.correlation',
  'webhooks.inbound',
  // These two need the BullMQ worker running as well, so they are verified
  // against the compose stack rather than in the host test process.
  'webhooks.outbound',
  'polling.lifecycle',
]);

after(closeResources);

function mustGet(id: string) {
  const action = getLabAction(id);
  assert.ok(action, `missing action ${id}`);
  return action;
}

function tableOf(result: ActionResult) {
  assert.ok(result.table, `${result.title} returned no table`);
  return result.table;
}

describe('every runnable action returns a structured result', () => {
  const runnable = labActions.filter((a) => !a.heavy && !SERVER_DEPENDENT.has(a.id));

  for (const action of runnable) {
    it(action.id, async () => {
      const result = await action.run({});
      assert.equal(typeof result.title, 'string');
      assert.ok(result.title.length > 0, 'empty title');
      assert.equal(typeof result.summary, 'string');
      assert.ok(result.summary.length > 10, 'thin summary');
    });
  }
});

describe('schemas: constraint truth table', () => {
  it('returns exactly the documented SQLSTATEs in order', async () => {
    const result = await mustGet('schemas.constraints').run({});
    const actual = tableOf(result).rows.map((row) => row[3]);

    assert.deepEqual(actual, [
      '23505', // duplicate idempotency key
      'ok', // NULL key #1
      'ok', // NULL key #2
      '23514', // invalid status
      '23503', // missing parent
      '23502', // NULL payload
      '23505', // duplicate fan-out
      '23505', // duplicate cron window
      '23514', // attempt_no = 0
    ]);
  });

  it('reports the constraint name for every violation', async () => {
    const result = await mustGet('schemas.constraints').run({});
    const violations = tableOf(result).rows.filter((row) => String(row[3]).startsWith('23'));

    assert.equal(violations.length, 7);
    for (const row of violations) {
      assert.ok(row[4], `no constraint reported for: ${row[1]}`);
    }
  });

  it('leaves no residue behind', async () => {
    const first = await mustGet('schemas.constraints').run({});
    const second = await mustGet('schemas.constraints').run({});

    assert.deepEqual(
      tableOf(first).rows.map((r) => r[3]),
      tableOf(second).rows.map((r) => r[3]),
      'the probe is not repeatable, so it leaked state',
    );
  });
});

describe('architecture: the layer rule holds in this repo', () => {
  it('reports zero violations', async () => {
    const result = await mustGet('architecture.layers').run({});
    assert.equal(result.title, 'Layer rules hold');

    const violations = tableOf(result).rows.filter((row) => String(row[4]).startsWith('VIOLATION'));
    assert.deepEqual(violations, []);
  });
});

describe('cron: the claim is atomic', () => {
  it('lets exactly one replica claim the window', async () => {
    const result = await mustGet('cron.claim-race').run({});
    const rows = tableOf(result).rows;

    const claimed = rows.filter((row) => row[1] === true);
    assert.equal(claimed.length, 1, 'expected exactly one winner');
    assert.equal(rows.filter((row) => row[1] === false).length, 1, 'expected exactly one loser');
  });

  it('is repeatable across runs', async () => {
    const a = await mustGet('cron.claim-race').run({});
    const b = await mustGet('cron.claim-race').run({});

    assert.equal(
      tableOf(a).rows.filter((r) => r[1] === true).length,
      tableOf(b).rows.filter((r) => r[1] === true).length,
    );
  });
});

describe('queues: jobId dedupe', () => {
  it('ignores the second add and keeps the first payload', async () => {
    const result = await mustGet('queues.dedupe').run({});
    const rows = tableOf(result).rows;

    assert.equal(rows[0]?.[1], rows[1]?.[1], 'job ids differ, so dedupe did not happen');
    assert.equal(rows[0]?.[2], 1, 'first add should leave exactly one waiting job');
    assert.equal(rows[1]?.[2], 1, 'second add must not increase the waiting count');
    assert.match(result.notes?.join(' ') ?? '', /Stored payload is "first"/);
  });
});

describe('webhooks: HMAC classification', () => {
  it('accepts only the genuine request', async () => {
    const result = await mustGet('webhooks.hmac').run({});
    const accepted = tableOf(result).rows.map((row) => row[1]);

    assert.deepEqual(accepted, [
      true, // genuine
      false, // tampered body
      false, // stale timestamp
      false, // wrong secret
      false, // the timestamp guard rejects 400s
    ]);
  });
});

describe('migrations: ledger agrees with disk', () => {
  it('has no drift and reports the completed rename', async () => {
    const result = await mustGet('migrations.ledger').run({});

    assert.match(result.title, /Schema is at head/);
    const notes = result.notes?.join('\n') ?? '';
    assert.match(notes, /No drift/);
    assert.match(notes, /attempt_count/);
    assert.doesNotMatch(notes, /attempts_count,/);
  });
});

describe('infra: dependencies answer', () => {
  it('reports Postgres and Redis versions', async () => {
    const result = await mustGet('infra.probe').run({});
    const rows = tableOf(result).rows;
    const byLabel = new Map(rows.map((row) => [String(row[0]), String(row[1])]));

    assert.match(byLabel.get('Postgres') ?? '', /PostgreSQL/);
    assert.match(byLabel.get('Redis version') ?? '', /^\d+\./);
  });
});

describe('capstone: operational signals', () => {
  it('reads live system state', async () => {
    const result = await mustGet('capstone.readout').run({});
    const labels = tableOf(result).rows.map((row) => String(row[0]));

    assert.ok(labels.includes('workers connected'));
    assert.ok(labels.includes('queue waiting'));
    assert.ok(labels.includes('deliveries by status'));
    assert.ok(labels.includes('pg pool total / idle / waiting'));
  });

  it('fails fast against a dead redis and maps the failure modes', async () => {
    const result = await mustGet('capstone.redis-down').run({});
    const rows = tableOf(result).rows;

    assert.match(result.title, /failed fast|unexpectedly connected/);
    assert.ok(
      rows.some((row) => String(row[2]).includes('fails OPEN')),
      'the matrix must call out fail-open behaviour',
    );
  });
});

describe('logs: structured output', () => {
  it('redacts secrets before writing and drops below-level lines', async () => {
    const result = await mustGet('logs.structured').run({});
    const rows = tableOf(result).rows;
    const text = rows.map((row) => String(row[1])).join('\n');

    assert.equal(rows.length, 2, 'debug must be filtered at level info');
    assert.match(text, /\[redacted\]/);
    assert.doesNotMatch(text, /whsec_super_secret_value/);
    assert.doesNotMatch(text, /hr_live_abc123/);
  });

  it('serialises errors with a message and stack', async () => {
    const result = await mustGet('logs.structured').run({});
    const text = tableOf(result).rows.map((row) => String(row[1])).join('\n');

    assert.match(text, /"type":"Error"/);
    assert.match(text, /upstream returned 503/);
  });
});

describe('logs: redis stream', () => {
  it('appends entries and reads them back', async () => {
    const result = await mustGet('logs.stream').run({});
    const rows = tableOf(result).rows;

    assert.ok(rows.length >= 3, `expected at least 3 entries, got ${rows.length}`);
    assert.ok(rows.some((row) => row[2] === 'lab.stream.sample'));

    const appended = Number(/^(\d+) entries/.exec(result.title)?.[1] ?? 0);
    assert.ok(appended >= 3, `expected >= 3 appended, title said ${result.title}`);

    for (const row of rows) assert.match(String(row[0]), /^\d+-\d+$/);
  });
});

describe('logs: audit trail', () => {
  it('writes a business record to audit.audit_log', async () => {
    const result = await mustGet('logs.audit').run({});
    const rows = tableOf(result).rows;

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.[1], 'endpoint.created');
    assert.equal(rows[0]?.[2], 'user:lab');
  });
});

describe('node events: emitter semantics', () => {
  it('runs listeners inline and does not await the async one', async () => {
    const result = await mustGet('events.order').run({});
    const trace = tableOf(result).rows.map((row) => String(row[1]));

    const afterEmit = trace.findIndex((line) => line.startsWith('caller: after emit'));
    const asyncEnd = trace.findIndex((line) => line.includes('async listener end'));

    assert.equal(trace[0], 'caller: before emit', 'emit must not run before the caller logs');
    assert.ok(afterEmit > 0, 'missing "after emit" marker');
    assert.ok(asyncEnd > afterEmit, 'async listener tail must land after emit returned');
    assert.match(trace[afterEmit] ?? '', /returned true/);
  });

  it("throws when 'error' has no listener", async () => {
    const result = await mustGet('events.error').run({});
    const rows = tableOf(result).rows;

    assert.equal(rows[0]?.[2], 'no', 'a normal event must not throw');
    assert.equal(rows[1]?.[2], 'yes', "'error' must throw");
    assert.match(String(rows[1]?.[3]), /nobody handled/);
    assert.equal(rows[2]?.[3], 'handler saw this one');
  });

  it('captures the max-listeners warning', async () => {
    const result = await mustGet('events.leak').run({});
    const rows = tableOf(result).rows;

    assert.equal(rows[0]?.[1], 12);
    assert.equal(rows[2]?.[1], 'MaxListenersExceededWarning');
    assert.equal(rows[3]?.[1], 0, 'removeAllListeners must clear the leak');
  });

  it('proves an async listener rejection kills the child process', async () => {
    const result = await mustGet('events.async-crash').run({});
    const rows = tableOf(result).rows;

    assert.match(String(rows[0]?.[1]), /exit code 1/);
    assert.match(String(rows[0]?.[1]), /STILL_ALIVE: no/);
    assert.equal(rows[2]?.[1], 'captured cleanly', 'captureRejections must route the error');
  });

  it('finds real EventEmitter usage in app code', async () => {
    const result = await mustGet('events.where-used').run({});
    const rows = tableOf(result).rows;

    assert.ok(rows.length > 0, 'expected at least one touchpoint');
    const files = rows.map((row) => String(row[0]));
    assert.ok(files.some((file) => file.includes('worker')), 'worker.ts should register listeners');
  });
});

describe('git: read-only inspection', () => {
  it('returns branch and status output', async () => {
    const result = await mustGet('git.graph').run({});
    const rows = tableOf(result).rows;

    assert.equal(rows.length, 4);
    assert.ok(String(rows[1]?.[1]).length > 0, 'branch listing is empty');
  });
});

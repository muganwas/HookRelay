import type { ActionDefinition, ActionResult } from './labs.types.js';
import { pool, type PoolClient } from '../../infra/db.js';
import { sleep } from './labs.helpers.js';

type Session = PoolClient;

async function initCounter(key: string, value = 0): Promise<void> {
  await pool.query(
    `insert into ops.lab_counter (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

async function dropCounter(key: string): Promise<void> {
  await pool.query(`delete from ops.lab_counter where key = $1`, [key]).catch(() => undefined);
}

async function readValue(client: Session, key: string): Promise<number> {
  const result = await client.query<{ value: number }>(
    `select value from ops.lab_counter where key = $1`,
    [key],
  );
  return result.rows[0]?.value ?? -1;
}

async function finalValue(key: string): Promise<number> {
  const result = await pool.query<{ value: number }>(
    `select value from ops.lab_counter where key = $1`,
    [key],
  );
  return result.rows[0]?.value ?? -1;
}

async function openTwo(): Promise<[Session, Session]> {
  const first = await pool.connect();
  try {
    const second = await pool.connect();
    return [first, second];
  } catch (error) {
    first.release();
    throw error;
  }
}

function sqlState(error: unknown): string {
  return (error as { code?: string }).code ?? 'unknown';
}

async function concurrencyLostUpdate(): Promise<ActionResult> {
  const key = `lost-${Date.now()}`;
  await initCounter(key, 0);
  const [a, b] = await openTwo();

  try {
    await a.query('begin');
    await b.query('begin');

    // Both read 0, both compute 0 + 1 in application code, both write 1.
    const readA = await readValue(a, key);
    const readB = await readValue(b, key);

    await a.query(`update ops.lab_counter set value = $2 where key = $1`, [key, readA + 1]);
    await a.query('commit');

    await b.query(`update ops.lab_counter set value = $2 where key = $1`, [key, readB + 1]);
    await b.query('commit');

    const final = await finalValue(key);

    return {
      title: final === 1 ? 'One increment vanished' : `Final value was ${final}`,
      summary:
        'Read-modify-write in application code lost an update. Both transactions read 0 and both wrote 1; nothing warned you.',
      table: {
        columns: ['Step', 'Session A', 'Session B', 'Stored value'],
        rows: [
          ['BEGIN', 'open', 'open', 0],
          ['SELECT value', readA, readB, 0],
          ['UPDATE value = read + 1', readA + 1, '—', readA + 1],
          ['COMMIT', 'done', '—', readA + 1],
          ['UPDATE value = read + 1', '—', readB + 1, readB + 1],
          ['COMMIT', '—', 'done', final],
          ['expected after two increments', 2, '', final],
        ],
      },
      notes: [
        'This is the lost update. No error, no warning — just one fewer increment.',
        'The default isolation level is READ COMMITTED, which guarantees you see committed rows, not that your read is still valid when you write.',
        'An atomic statement (`value = value + 1`) would not lose the update; the loss happens because the value was read into application code first.',
        'This is the bug behind "we lost a payment" incidents, and it is invisible in single-user testing.',
      ],
    };
  } finally {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    a.release();
    b.release();
    await dropCounter(key);
  }
}

async function concurrencyForUpdate(): Promise<ActionResult> {
  const key = `lock-${Date.now()}`;
  await initCounter(key, 0);
  const [a, b] = await openTwo();

  try {
    await a.query('begin');
    await b.query('begin');

    const readA = (await a.query<{ value: number }>(
      `select value from ops.lab_counter where key = $1 for update`,
      [key],
    )).rows[0]?.value ?? -1;

    let blockedForMs = 0;
    const blockedStarted = Date.now();
    const bRead = b
      .query<{ value: number }>(`select value from ops.lab_counter where key = $1 for update`, [key])
      .then((result) => {
        blockedForMs = Date.now() - blockedStarted;
        return result.rows[0]?.value ?? -1;
      });

    await sleep(250);
    const stillBlocked = blockedForMs === 0;

    await a.query(`update ops.lab_counter set value = $2 where key = $1`, [key, readA + 1]);
    await a.query('commit');

    const readB = await bRead;
    await b.query(`update ops.lab_counter set value = $2 where key = $1`, [key, readB + 1]);
    await b.query('commit');

    const final = await finalValue(key);

    return {
      title: final === 2 ? 'Both increments survived' : `Final value was ${final}`,
      summary:
        'SELECT ... FOR UPDATE took a row lock. The second reader waited, then read the committed value instead of a stale one.',
      table: {
        columns: ['Observation', 'Value'],
        rows: [
          ['A read (locked)', readA],
          ['B read (after waiting)', readB],
          ['B was still blocked after 250 ms', stillBlocked],
          ['B waited (ms)', blockedForMs],
          ['final value', final],
          ['expected', 2],
        ],
      },
      notes: [
        'Locking turns a silent data bug into latency. That is usually the right trade for money.',
        'The lock is held until COMMIT or ROLLBACK. A transaction that waits on user input holds it for seconds — keep transactions short.',
        'FOR UPDATE on a row that does not exist locks nothing. Use a unique index and upsert, or lock a parent row.',
        'Alternatives: atomic SQL (`value = value + 1`), optimistic locking with a version column, or SERIALIZABLE with retries.',
      ],
    };
  } finally {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    a.release();
    b.release();
    await dropCounter(key);
  }
}

async function concurrencyDeadlock(): Promise<ActionResult> {
  const keyA = `dead-a-${Date.now()}`;
  const keyB = `dead-b-${Date.now()}`;
  await initCounter(keyA, 0);
  await initCounter(keyB, 0);
  const [a, b] = await openTwo();

  try {
    await a.query('begin');
    await b.query('begin');

    // Opposite lock order: A takes A then B, B takes B then A.
    await a.query(`update ops.lab_counter set value = value + 1 where key = $1`, [keyA]);
    await b.query(`update ops.lab_counter set value = value + 1 where key = $1`, [keyB]);

    const aSecond = a
      .query(`update ops.lab_counter set value = value + 1 where key = $1`, [keyB])
      .then(() => 'committed' as const)
      .catch((error: unknown) => sqlState(error));

    await sleep(200);

    const bSecond = await b
      .query(`update ops.lab_counter set value = value + 1 where key = $1`, [keyA])
      .then(() => 'committed' as const)
      .catch((error: unknown) => sqlState(error));

    const aResult = await aSecond;
    const victim = [aResult, bSecond].filter((r) => r === '40P01').length;

    return {
      title: victim > 0 ? 'Postgres detected the deadlock and aborted one transaction' : 'No deadlock was detected',
      summary:
        'Two transactions took the same two rows in opposite order. Postgres waited about a second, then killed one with 40P01.',
      table: {
        columns: ['Session', 'First lock', 'Second lock', 'Outcome'],
        rows: [
          ['A', keyA, keyB, aResult],
          ['B', keyB, keyA, bSecond],
        ],
      },
      notes: [
        '40P01 is deadlock_detected. It is a normal, expected error — your code must retry.',
        'deadlock_timeout defaults to 1s; after that Postgres checks for a cycle and aborts one side.',
        'The fix is lock ordering: every transaction takes rows in a deterministic order (e.g. ascending id).',
        'Deadlocks are a design smell, not a database bug. Retrying without fixing the order just moves the cost.',
      ],
    };
  } finally {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    a.release();
    b.release();
    await dropCounter(keyA);
    await dropCounter(keyB);
  }
}

async function concurrencySerializable(): Promise<ActionResult> {
  const key = `serial-${Date.now()}`;
  await initCounter(key, 0);
  const [a, b] = await openTwo();

  try {
    await a.query('begin isolation level serializable');
    await b.query('begin isolation level serializable');

    const readA = await readValue(a, key);
    const readB = await readValue(b, key);

    await a.query(`update ops.lab_counter set value = $2 where key = $1`, [key, readA + 1]);
    await a.query('commit');

    const firstFailure = await b
      .query(`update ops.lab_counter set value = $2 where key = $1`, [key, readB + 1])
      .then(() => 'committed' as const)
      .catch((error: unknown) => sqlState(error));

    await b.query('rollback').catch(() => undefined);

    // Retry the whole transaction from scratch.
    await b.query('begin isolation level serializable');
    const retryRead = await readValue(b, key);
    await b.query(`update ops.lab_counter set value = $2 where key = $1`, [key, retryRead + 1]);
    await b.query('commit');

    const final = await finalValue(key);

    return {
      title: final === 2 ? 'Serializable forced a retry, and the retry succeeded' : `Final value was ${final}`,
      summary:
        'SERIALIZABLE refused to let B update a row it had read before A changed it, returning 40001. The retry read the new value.',
      table: {
        columns: ['Step', 'Value'],
        rows: [
          ['A read', readA],
          ['B read (same snapshot)', readB],
          ['B first attempt', firstFailure],
          ['B retry read', retryRead],
          ['final value', final],
          ['expected', 2],
        ],
      },
      notes: [
        '40001 is serialization_failure. Serialisable isolation is optimistic: it lets you try, then aborts conflicts.',
        'The retry loop is not optional. Without it, SERIALIZABLE turns a data bug into an error the user sees.',
        'Retry with backoff and a bounded number of attempts; a hot row can fail repeatedly under load.',
        'This is the isolation level that makes reasoning easy, at the cost of throughput and a retry path in every writer.',
      ],
    };
  } finally {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    a.release();
    b.release();
    await dropCounter(key);
  }
}

async function concurrencyIsolation(): Promise<ActionResult> {
  const key = `iso-${Date.now()}`;
  const [a, b] = await openTwo();

  async function scenario(level: string): Promise<{ first: number; second: number }> {
    await initCounter(key, 0);

    await a.query(`begin isolation level ${level}`);
    const first = await readValue(a, key);

    await b.query(`update ops.lab_counter set value = 5 where key = $1`, [key]);

    const second = await readValue(a, key);
    await a.query('commit');

    return { first, second };
  }

  try {
    const readCommitted = await scenario('read committed');
    const repeatableRead = await scenario('repeatable read');
    const final = await finalValue(key);

    return {
      title: 'Same two reads, different answers per isolation level',
      summary:
        'The only difference is the isolation level on the reader. READ COMMITTED sees the other transaction commit; REPEATABLE READ keeps its snapshot.',
      table: {
        columns: ['Level', 'First read', 'Second read (after B committed 5)', 'Sees the change?'],
        rows: [
          ['READ COMMITTED', readCommitted.first, readCommitted.second, readCommitted.first !== readCommitted.second],
          ['REPEATABLE READ', repeatableRead.first, repeatableRead.second, repeatableRead.first !== repeatableRead.second],
          ['final stored value', final, '', ''],
        ],
      },
      notes: [
        'READ COMMITTED: every statement gets a fresh snapshot. Two reads in one transaction can disagree.',
        'REPEATABLE READ: one snapshot for the whole transaction, so re-reads are stable. Postgres implements it without read locks.',
        'Postgres has no dirty reads; the lowest level is READ COMMITTED, unlike MySQL where REPEATABLE READ is the default.',
        'Defaulting to REPEATABLE READ for reports avoids "the totals do not add up" bugs; keep writes at READ COMMITTED unless you need more.',
      ],
    };
  } finally {
    await a.query('rollback').catch(() => undefined);
    a.release();
    b.release();
    await dropCounter(key);
  }
}

export const concurrencyActions: ActionDefinition[] = [
  {
    id: 'concurrency.lost-update',
    label: 'Lose an update',
    topicId: 'concurrency',
    run: concurrencyLostUpdate,
  },
  {
    id: 'concurrency.for-update',
    label: 'Lock the row with FOR UPDATE',
    topicId: 'concurrency',
    run: concurrencyForUpdate,
  },
  {
    id: 'concurrency.deadlock',
    label: 'Trigger a deadlock',
    topicId: 'concurrency',
    run: concurrencyDeadlock,
  },
  {
    id: 'concurrency.serializable',
    label: 'Force a serialization failure',
    topicId: 'concurrency',
    run: concurrencySerializable,
  },
  {
    id: 'concurrency.isolation',
    label: 'Compare isolation levels',
    topicId: 'concurrency',
    run: concurrencyIsolation,
  },
];

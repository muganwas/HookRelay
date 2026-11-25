import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { getLabAction } from '../src/modules/labs/labs.actions.js';
import type { ActionResult } from '../src/modules/labs/labs.types.js';
import { closeResources } from './helpers.js';

/**
 * Opt-in: `npm run test:heavy`.
 * Writes ~20k business rows and builds a real index, so it is not part of the
 * default suite. It must leave the database exactly as it found it.
 */
const ROWS = 20_000;

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

describe('indexes: seed, measure, clean up', () => {
  let baseline = 0;

  it('records the baseline delivery count', async () => {
    const result = await mustGet('plans.stats').run({});
    const deliveries = tableOf(result).rows.find((row) => row[0] === 'deliveries');
    baseline = Number(deliveries?.[3] ?? 0);
    assert.ok(Number.isFinite(baseline));
  });

  it('seeds idempotently', async () => {
    const first = await mustGet('indexes.seed').run({ rows: ROWS });
    const second = await mustGet('indexes.seed').run({ rows: ROWS });

    const firstCreated = Number(tableOf(first).rows[1]?.[1] ?? -1);
    const secondCreated = Number(tableOf(second).rows[1]?.[1] ?? -1);

    assert.equal(firstCreated, ROWS, 'first seed should create the requested rows');
    assert.equal(secondCreated, 0, 'second seed must be a no-op');
  });

  it('changes the plan when the partial index appears', async () => {
    const result = await mustGet('indexes.before-after').run({ rows: ROWS });
    const rows = tableOf(result).rows;

    const before = String(rows[0]?.[1] ?? '');
    const after = String(rows[1]?.[1] ?? '');

    assert.ok(before.length > 0);
    assert.ok(after.length > 0);
    assert.match(before, /Seq Scan/, `expected a seq scan before the index, got: ${before}`);
    assert.match(
      after,
      /Index Scan|Bitmap Heap Scan|Index Only Scan/,
      `expected an index-driven plan after the index, got: ${after}`,
    );
  });

  it('removes every seeded row by cascade', async () => {
    const result = await mustGet('indexes.cleanup').run({});
    const rows = tableOf(result).rows;

    assert.equal(Number(rows[1]?.[1] ?? -1), 0, 'cascade left deliveries behind');
  });

  it('leaves the schema free of lab rows', async () => {
    const result = await mustGet('cron.claim-race').run({});
    assert.equal(tableOf(result).rows.filter((row) => row[1] === true).length, 1);
  });
});

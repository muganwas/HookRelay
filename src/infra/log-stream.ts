import { redis } from './redis.js';

export const LOG_STREAM = 'logs:events';
export const LOG_STREAM_MAXLEN = 10_000;

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type StreamEntry = { id: string; fields: Record<string, string> };

function flatten(fields: LogFields): string[] {
  const flat: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    flat.push(key, String(value));
  }
  return flat;
}

/**
 * Streams cap themselves with MAXLEN ~ N so a log sink cannot grow unbounded.
 * The `~` makes Redis trim at whole macro-nodes, which is cheaper than exact.
 */
export async function appendLog(fields: LogFields): Promise<string> {
  const id = await redis.xadd(LOG_STREAM, 'MAXLEN', '~', String(LOG_STREAM_MAXLEN), '*', ...flatten(fields));
  if (!id) throw new Error('XADD returned no entry id');
  return id;
}

function toEntry(row: [string, string[]]): StreamEntry {
  const fields: Record<string, string> = {};
  for (let index = 0; index < row[1].length; index += 2) {
    const key = row[1][index];
    const value = row[1][index + 1];
    if (key !== undefined && value !== undefined) fields[key] = value;
  }
  return { id: row[0], fields };
}

export async function recentLogs(count = 20): Promise<StreamEntry[]> {
  const rows = await redis.xrevrange(LOG_STREAM, '+', '-', 'COUNT', count);
  return rows.map(toEntry);
}

export async function streamLength(): Promise<number> {
  return redis.xlen(LOG_STREAM);
}

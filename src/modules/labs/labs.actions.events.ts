import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ActionDefinition, ActionResult } from './labs.types.js';

const PROJECT_ROOT = process.cwd();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runNode(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['-e', script],
      { timeout: 10_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      },
    );
  });
}

async function eventsOrder(): Promise<ActionResult> {
  const emitter = new EventEmitter();
  const trace: string[] = [];

  emitter.on('demo', () => {
    trace.push('A · sync listener');
  });
  emitter.on('demo', async () => {
    trace.push('B · async listener start');
    await sleep(15);
    trace.push('B · async listener end');
  });
  emitter.once('demo', () => {
    trace.push('C · once listener');
  });

  trace.push('caller: before emit');
  const first = emitter.emit('demo');
  trace.push(`caller: after emit (returned ${first})`);

  await sleep(50);

  const second = emitter.emit('demo');
  trace.push(`caller: second emit (returned ${second})`);

  await sleep(50);

  const remaining = emitter.listenerCount('demo');

  return {
    title: 'emit() is synchronous: the async listener is not',
    summary:
      'Every listener ran inline before emit returned, except the async one, whose tail lands after the caller moved on.',
    table: {
      columns: ['#', 'Trace, in real order'],
      rows: trace.map((line, index) => [index + 1, line]),
    },
    notes: [
      `emit returned ${first}: true means at least one listener ran, not that it finished.`,
      'B prints "start" before the caller continues and "end" after: emit never awaited it.',
      `C ran once only: once() removed itself, so the second emit still had ${remaining} listeners.`,
      'If order matters for correctness, this is the wrong primitive. Use a queue with a single consumer.',
    ],
  };
}

async function eventsError(): Promise<ActionResult> {
  const silent = new EventEmitter();
  const silentReturn = silent.emit('nobody-listening');

  const throwing = new EventEmitter();
  let thrown: string | null = null;
  try {
    throwing.emit('error', new Error('nobody handled this error event'));
  } catch (err) {
    thrown = (err as Error).message;
  }

  const handled = new EventEmitter();
  let captured: string | null = null;
  handled.on('error', (err: Error) => {
    captured = err.message;
  });
  const handledReturn = handled.emit('error', new Error('handler saw this one'));

  return {
    title: "'error' is the one event that throws when nobody listens",
    summary:
      'A normal event with no listener is silently dropped. An error event with no listener throws synchronously out of emit.',
    table: {
      columns: ['Case', 'emit returned', 'Threw?', 'Handler saw'],
      rows: [
        ['event with no listener', silentReturn, 'no', 'n/a'],
        ["'error' with no listener", 'did not return', 'yes', thrown ?? 'n/a'],
        ["'error' with a listener", handledReturn, 'no', captured ?? 'n/a'],
      ],
    },
    notes: [
      "This is why every library documents `emitter.on('error')` as required: an unhandled error event crashes the caller's stack.",
      'Every other event is fire-and-forget: `false` from emit simply means nothing was listening.',
      'Node also has `EventEmitter.errorMonitor` for observing errors without consuming them.',
    ],
  };
}

async function eventsLeak(): Promise<ActionResult> {
  const emitter = new EventEmitter();
  const warnings: string[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning.name);
  };

  process.on('warning', onWarning);
  for (let i = 0; i < 12; i += 1) emitter.on('tick', () => undefined);
  await sleep(40);
  process.off('warning', onWarning);

  const count = emitter.listenerCount('tick');
  const max = emitter.getMaxListeners();
  const captured = warnings.find((name) => name === 'MaxListenersExceededWarning') ?? '(none captured)';

  emitter.removeAllListeners('tick');

  return {
    title: `${count} listeners on one event, default max ${max}`,
    summary:
      'Node warns once you exceed 11 listeners. In a server this normally means a listener added per request and never removed.',
    table: {
      columns: ['Step', 'Value'],
      rows: [
        ['listeners added', 12],
        ['default max', max],
        ['warning captured', captured],
        ['listeners after removeAllListeners', emitter.listenerCount('tick')],
      ],
    },
    notes: [
      'The warning is emitted asynchronously, which is why this demo waits before reading it.',
      'The 11 default exists to catch leaks early; raising it with setMaxListeners only hides the symptom.',
      'The fix is `off()` on the same function reference, or scoping the emitter to the request instead of the process.',
    ],
  };
}

const CRASH_SCRIPT = `
const { EventEmitter } = require('node:events');
const emitter = new EventEmitter();

emitter.on('job', async () => {
  throw new Error('listener exploded');
});

emitter.emit('job');

setTimeout(() => console.log('STILL_ALIVE'), 40);
`;

async function eventsAsyncCrash(): Promise<ActionResult> {
  const child = await runNode(CRASH_SCRIPT);

  const rejectionKey = Symbol.for('nodejs.rejection');
  const safe = new EventEmitter({ captureRejections: true });
  const captured: string[] = [];

  (safe as unknown as Record<symbol, (err: unknown) => void>)[rejectionKey] = (err) => {
    captured.push(err instanceof Error ? err.message : String(err));
  };

  safe.on('job', async () => {
    throw new Error('captured cleanly');
  });
  safe.emit('job');
  await sleep(40);

  const survived = child.stdout.includes('STILL_ALIVE');
  const stderrLines = child.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const stderrSummary =
    stderrLines
      .filter((line) => /error|thrown|ERR_/i.test(line))
      .slice(0, 2)
      .join(' | ') || stderrLines.at(-1) || '(empty)';

  return {
    title: survived
      ? 'The child survived (unexpected)'
      : `The child process died: exit code ${child.code}`,
    summary:
      'An async listener that throws is not caught by emit. It becomes an unhandled rejection, and Node 15+ terminates the process.',
    table: {
      columns: ['Scenario', 'Outcome'],
      rows: [
        ['child: async listener throws', `exit code ${child.code}; printed STILL_ALIVE: ${survived ? 'yes' : 'no'}`],
        ['child stderr (error line)', stderrSummary.slice(0, 240)],
        ['captureRejections + rejection handler', captured.join(', ') || '(nothing captured)'],
      ],
    },
    notes: [
      'The crashing variant runs in a separate child process, so it cannot take this server down.',
      'This app has an unhandledRejection handler in api.ts, so it would shut down gracefully instead of dying mid-request.',
      'captureRejections routes the rejection to Symbol.for("nodejs.rejection") on that emitter.',
      'Node also exposes `events.on(emitter, name)` for an async-iterator form that stops at the first rejection.',
    ],
    raw: { exitCode: child.code, stdout: child.stdout, stderr: child.stderr.slice(0, 1200) },
  };
}

async function eventsWhereUsed(): Promise<ActionResult> {
  const candidates = [
    { root: path.join(PROJECT_ROOT, 'src'), label: 'src' },
    { root: path.join(PROJECT_ROOT, 'dist'), label: 'dist' },
  ];
  const chosen = candidates.find((candidate) => existsSync(candidate.root));

  if (!chosen) {
    return {
      title: 'No source tree found',
      summary: `Neither src/ nor dist/ exists under ${PROJECT_ROOT}.`,
      notes: ['Run this from the project root, or build the project first.'],
    };
  }

  const entries = await readdir(chosen.root, { recursive: true, withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js')),
  );

  const pattern = /\.(on|once|off|emit|addListener|removeListener)\(/;
  const hits: Array<[string, number, string]> = [];

  for (const entry of files) {
    const parent = (entry as { parentPath?: string }).parentPath ?? chosen.root;
    const full = path.join(parent, entry.name);
    const rel = path.relative(chosen.root, full).split(path.sep).join('/');

    // The labs module is demo code, so it would only find itself.
    if (rel.startsWith('modules/labs/')) continue;

    const source = await readFile(full, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (pattern.test(line)) hits.push([rel, index + 1, line.trim().slice(0, 110)]);
    });
  }

  return {
    title: `${hits.length} EventEmitter touchpoints in app code`,
    summary:
      'This is not a niche API: the same primitive carries HTTP requests, signals, the worker lifecycle and the DB pool.',
    table: {
      columns: ['File', 'Line', 'Code'],
      rows: hits.slice(0, 30).map(([file, line, text]) => [file, line, text]),
    },
    notes: [
      'worker.ts uses `.on("completed" | "failed" | "error")`: BullMQ classes extend EventEmitter.',
      'api.ts uses `process.on("SIGINT" | "SIGTERM" | "unhandledRejection")`.',
      'http.Server emits `listening`/`request`/`close`; streams emit `data`/`end`; pg.Pool and ioredis emit `error`.',
      'Express is built on this too: `req.on("data")`, `res.on("finish")`.',
    ],
  };
}

export const eventActions: ActionDefinition[] = [
  { id: 'events.order', label: 'Prove emit is synchronous', topicId: 'node-events', run: eventsOrder },
  {
    id: 'events.error',
    label: "Emit 'error' with and without a listener",
    topicId: 'node-events',
    run: eventsError,
  },
  { id: 'events.leak', label: 'Trigger the leak warning', topicId: 'node-events', run: eventsLeak },
  {
    id: 'events.async-crash',
    label: 'Crash a child process',
    topicId: 'node-events',
    run: eventsAsyncCrash,
  },
  {
    id: 'events.where-used',
    label: 'Find EventEmitter in this repo',
    topicId: 'node-events',
    run: eventsWhereUsed,
  },
];

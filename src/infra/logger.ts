import pino from 'pino';
import { config } from '../config.js';

/** Applied inside pino, so a forgotten field in a route cannot leak a secret. */
export const LOG_REDACT_PATHS = [
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'password',
  '*.password',
  'headers.authorization',
];

export function loggerOptions(level: string = config.LOG_LEVEL): pino.LoggerOptions {
  return {
    level,
    base: { service: 'hookrelay' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
  };
}

export const logger = pino(loggerOptions());

/**
 * Builds a logger that keeps its output in memory so a lab demo can show the
 * exact bytes, including the redaction. Uses the same options as the real one.
 */
export function createCapturingLogger(level = 'info'): {
  logger: pino.Logger;
  lines: string[];
} {
  const lines: string[] = [];
  const instance = pino(loggerOptions(level), {
    write(chunk: string): void {
      lines.push(chunk.trimEnd());
    },
  });
  return { logger: instance, lines };
}

export type { Logger } from 'pino';

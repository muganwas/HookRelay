import { existsSync } from 'node:fs';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // How the worker reaches this API (webhooks are delivered back to it in the labs).
  SELF_BASE_URL: z.url().optional(),
  INBOUND_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Dedicated cache. Falls back to the main Redis on db 1 when unset.
  CACHE_URL: z.url().optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;

/** Used for self-referential delivery targets (worker -> API). */
export const selfBaseUrl = config.SELF_BASE_URL ?? `http://127.0.0.1:${config.PORT}`;

/** Shared secret the labs use for the inbound receiver. */
export const inboundWebhookSecret = config.INBOUND_WEBHOOK_SECRET ?? 'whsec_lab_inbound_demo_secret';
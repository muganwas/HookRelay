import express from 'express';
import { config } from './config.js';
import { pingDb } from './db.js';
import { pingRedis } from './redis.js';

const app = express();
app.use(express.json());

app.get('/v1/health', async (_req, res) => {
  const checks = { db: 'ok', redis: 'ok' };
  let healthy = true;

  try { await pingDb(); } catch { checks.db = 'fail'; healthy = false; }
  try { await pingRedis(); } catch { checks.redis = 'fail'; healthy = false; }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

const server = app.listen(config.PORT, () => {
  console.log(`hookrelay listening on http://localhost:${config.PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
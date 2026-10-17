import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './infra/db.js';
import { redis } from './infra/redis.js';

const server = createApp().listen(config.PORT, () => {
  console.log(`hookrelay listening on http://localhost:${config.PORT}`);
});

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${reason} received, draining…`);

  const forceExit = setTimeout(() => {
    console.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([pool.end(), redis.quit()]);

  clearTimeout(forceExit);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
  void shutdown('unhandledRejection');
});
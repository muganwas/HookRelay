export type HealthDeps = {
  pingDb: () => Promise<void>;
  pingRedis: () => Promise<void>;
};

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: { db: 'ok' | 'fail'; redis: 'ok' | 'fail' };
  uptimeSeconds: number;
};

export function createHealthService(deps: HealthDeps) {
  return {
    async check(): Promise<HealthReport> {
      const [db, redis] = await Promise.allSettled([deps.pingDb(), deps.pingRedis()]);

      const checks = {
        db: db.status === 'fulfilled' ? 'ok' : 'fail',
        redis: redis.status === 'fulfilled' ? 'ok' : 'fail',
      } as const;

      const healthy = checks.db === 'ok' && checks.redis === 'ok';

      return {
        status: healthy ? 'ok' : 'degraded',
        checks,
        uptimeSeconds: Math.round(process.uptime()),
      };
    },
  };
}

export type HealthService = ReturnType<typeof createHealthService>;
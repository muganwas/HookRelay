import { Redis } from 'ioredis';
import { config } from '../config.js';

export function createRedisConnection(): Redis {
  return new Redis(config.REDIS_URL, {
    // BullMQ blocks on list pops; a client-side retry cap would abort that wait.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
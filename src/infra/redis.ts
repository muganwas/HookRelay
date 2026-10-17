import { Redis } from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });

export async function pingRedis(): Promise<void> {
  const reply = await redis.ping();
  if (reply !== 'PONG') throw new Error(`unexpected redis reply: ${reply}`);
}
import Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../lib/logger';

export function createRedisClient(role: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
      return Math.min(times * 200, 3000);
    },
    connectionName: `flashsale-${role}`,
  });

  client.on('error', (error) => {
    logger.warn('Redis connection error', { role, error: error.message });
  });
  client.on('ready', () => logger.info('Redis ready', { role }));

  return client;
}

export const redis = createRedisClient('api');

export async function closeRedis(): Promise<void> {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

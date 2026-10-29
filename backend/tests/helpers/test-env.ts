/**
 * Environment used by integration tests and the mandatory concurrency harness.
 *
 * The suite never touches the development database, Redis DB or queue names.
 * Override the URLs with TEST_DATABASE_URL / TEST_REDIS_URL / TEST_RABBITMQ_URL
 * when running in CI or against containers on other ports.
 */
export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    'postgresql://flashsale:flashsale_secret@localhost:5432/flashsale_test?schema=public',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15',
  RABBITMQ_URL:
    process.env.TEST_RABBITMQ_URL ?? 'amqp://flashsale:flashsale_secret@localhost:5672',
  QUEUE_PREFIX: 'flashsale_test',
  REDIS_KEY_PREFIX: 'flashsale_test',
  INITIAL_STOCK: '500',
  RATE_LIMIT_DISABLED: 'true',
  RESERVATION_TTL_SECONDS: '600',
  REDIS_ORPHAN_GRACE_SECONDS: '120',
  WORKER_PREFETCH: '50',
  WORKER_PROCESSING_DELAY_MS: '0',
  WORKER_RETRY_BASE_MS: '100',
  OUTBOX_POLL_INTERVAL_MS: '100',
  OUTBOX_BATCH_SIZE: '100',
  RECOVERY_INTERVAL_MS: '1000',
  CORS_ORIGIN: '*',
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
} as const;

export function configureTestEnv(): void {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    process.env[key] = value;
  }
}

import 'dotenv/config';
import { z } from 'zod';

const boolFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z
    .string()
    .default('postgresql://flashsale:flashsale_secret@localhost:5432/flashsale_local?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379/2'),
  RABBITMQ_URL: z.string().default('amqp://flashsale:flashsale_secret@localhost:5672'),
  RABBITMQ_MANAGEMENT_URL: z.string().default('http://localhost:15672'),
  RABBITMQ_MANAGEMENT_USER: z.string().optional(),
  RABBITMQ_MANAGEMENT_PASSWORD: z.string().optional(),

  QUEUE_PREFIX: z.string().default('flashsale'),
  REDIS_KEY_PREFIX: z.string().default('flashsale'),
  INITIAL_STOCK: z.coerce.number().int().positive().default(500),

  CORS_ORIGIN: z.string().default('http://localhost:5173,http://localhost:8080'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(2000),
  CHECKOUT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1500),
  RATE_LIMIT_DISABLED: boolFromEnv,

  REQUEST_BODY_LIMIT: z.string().default('64kb'),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REDIS_ORPHAN_GRACE_SECONDS: z.coerce.number().int().positive().default(120),

  WORKER_PREFETCH: z.coerce.number().int().positive().default(20),
  WORKER_PROCESSING_DELAY_MS: z.coerce.number().int().min(0).default(350),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  WORKER_RETRY_BASE_MS: z.coerce.number().int().positive().default(2000),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(12),
  OUTBOX_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60_000),

  RECOVERY_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  RECENT_ORDER_LIMIT: z.coerce.number().int().positive().default(12),
});

export type AppConfig = z.infer<typeof envSchema>;

function parseAmqpCredentials(amqpUrl: string): { user: string; password: string } {
  try {
    const parsed = new URL(amqpUrl);
    return {
      user: decodeURIComponent(parsed.username || 'guest'),
      password: decodeURIComponent(parsed.password || 'guest'),
    };
  } catch {
    return { user: 'guest', password: 'guest' };
  }
}

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const config = parsed.data;
  const amqpCreds = parseAmqpCredentials(config.RABBITMQ_URL);

  return {
    ...config,
    RABBITMQ_MANAGEMENT_USER: config.RABBITMQ_MANAGEMENT_USER ?? amqpCreds.user,
    RABBITMQ_MANAGEMENT_PASSWORD:
      config.RABBITMQ_MANAGEMENT_PASSWORD ?? amqpCreds.password,
  };
}

export const config = loadConfig();

export const queueNames = {
  exchange: `${config.QUEUE_PREFIX}.orders`,
  queue: `${config.QUEUE_PREFIX}.orders.queue`,
  retryQueue: `${config.QUEUE_PREFIX}.orders.retry`,
  deadLetterExchange: `${config.QUEUE_PREFIX}.orders.dlx`,
  deadLetterQueue: `${config.QUEUE_PREFIX}.orders.dlq`,
  routingKey: 'order.reserved',
};

export const redisKeys = {
  stock: `${config.REDIS_KEY_PREFIX}:stock`,
  reservations: `${config.REDIS_KEY_PREFIX}:reservations`,
  idempotencyPrefix: `${config.REDIS_KEY_PREFIX}:idempotency:`,
  statsPrefix: `${config.REDIS_KEY_PREFIX}:stats:`,
  events: `${config.REDIS_KEY_PREFIX}:events`,
};

export const FLASH_SALE_SKU = 'FLASH-PHONE-01';
export const FLASH_SALE_PRODUCT_ID = 'flash-sale-phone';

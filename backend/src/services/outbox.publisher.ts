import { prisma } from '../db/prisma';
import { config } from '../config';
import { publishOrderReserved } from '../queue/rabbitmq';
import { recordEvent } from '../monitoring/monitor.service';
import { logger, safeErrorMessage } from '../lib/logger';

type PublishFn = (payload: unknown, outboxEventId: string) => Promise<void>;

export class OutboxPublisher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly publish: PublishFn = publishOrderReserved,
    private readonly pollIntervalMs = config.OUTBOX_POLL_INTERVAL_MS,
    private readonly batchSize = config.OUTBOX_BATCH_SIZE,
  ) {}

  async recoverStaleClaims(): Promise<number> {
    const staleBefore = new Date(Date.now() - 60_000);
    const result = await prisma.outboxEvent.updateMany({
      where: { status: 'PUBLISHING', lockedAt: { lt: staleBefore } },
      data: { status: 'PENDING', lockedAt: null },
    });
    if (result.count > 0) {
      logger.warn('Recovered stale outbox claims', { count: result.count });
      await recordEvent({
        type: 'RECOVERY_PASS',
        level: 'warn',
        message: 'Recovered outbox events stuck in PUBLISHING after a publisher restart',
        data: { count: result.count },
      });
    }
    return result.count;
  }

  private async claimBatch(): Promise<string[]> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "outbox_events"
        WHERE "status" = 'PENDING' AND "nextAttemptAt" <= NOW()
        ORDER BY "createdAt" ASC
        LIMIT ${this.batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids }, status: 'PENDING' },
        data: { status: 'PUBLISHING', lockedAt: new Date() },
      });
      return ids;
    });
  }

  async tick(): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;
    const ids = await this.claimBatch();

    for (const id of ids) {
      const event = await prisma.outboxEvent.findUnique({ where: { id } });
      if (!event || event.status !== 'PUBLISHING') continue;

      const attempts = event.attempts + 1;
      try {
        await this.publish(event.payload, event.id);
        await prisma.outboxEvent.update({
          where: { id },
          data: {
            status: 'PUBLISHED',
            attempts,
            publishedAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
        published += 1;
      } catch (error) {
        const message = safeErrorMessage(error);
        const exhausted = attempts >= config.OUTBOX_MAX_ATTEMPTS;
        const backoff = Math.min(
          config.OUTBOX_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1),
          config.OUTBOX_MAX_BACKOFF_MS,
        );
        await prisma.outboxEvent.update({
          where: { id },
          data: {
            status: exhausted ? 'FAILED' : 'PENDING',
            attempts,
            lockedAt: null,
            lastError: message,
            nextAttemptAt: new Date(Date.now() + backoff),
          },
        });
        failed += 1;
        logger.warn('Outbox publish failed', {
          outboxId: id,
          orderId: event.orderId,
          attempts,
          exhausted,
          error: message,
        });
        await recordEvent({
          type: exhausted ? 'OUTBOX_FAILED' : 'OUTBOX_RETRY',
          level: exhausted ? 'error' : 'warn',
          message: exhausted
            ? 'Outbox event exhausted publish retries'
            : 'Outbox publish failed; retry scheduled',
          orderId: event.orderId,
          data: { attempts, backoffMs: exhausted ? 0 : backoff, error: message },
        });
      }
    }

    if (published > 0) {
      await recordEvent({
        type: 'OUTBOX_PUBLISHED',
        level: 'info',
        message: `Published ${published} durable order event${published === 1 ? '' : 's'} to RabbitMQ`,
        data: { count: published },
      });
      logger.info('Outbox batch published', { published });
    }

    return { published, failed };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    await this.recoverStaleClaims();
    logger.info('Outbox publisher started', {
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize,
    });
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (error) {
      logger.error('Outbox publisher tick failed', { error: safeErrorMessage(error) });
      await recordEvent({
        type: 'SYSTEM_WARNING',
        level: 'error',
        message: 'Outbox publisher tick failed',
        data: { error: safeErrorMessage(error) },
      });
    } finally {
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.loop(), this.pollIntervalMs);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }
}

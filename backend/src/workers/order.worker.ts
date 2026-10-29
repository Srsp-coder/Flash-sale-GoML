import { ConsumeMessage } from 'amqplib';
import { config } from '../config';
import {
  createConsumerChannel,
  parseOrderMessage,
  publishRetry,
  publishToDeadLetter,
} from '../queue/rabbitmq';
import {
  confirmOrder,
  failPendingOrder,
  isTransientDatabaseError,
  markProcessing,
} from '../services/order-processing.service';
import { compensateReservation } from '../inventory/redis-reservation';
import { recordEvent } from '../monitoring/monitor.service';
import { logger, safeErrorMessage } from '../lib/logger';

class RetryableError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class OrderWorker {
  private channel: Awaited<ReturnType<typeof createConsumerChannel>>['channel'] | null = null;
  private connection: Awaited<ReturnType<typeof createConsumerChannel>>['connection'] | null = null;
  private consumerTag: string | null = null;
  private stopping = false;
  private active = 0;
  private processed = 0;
  private failedAttempts = 0;

  constructor(
    private readonly processingDelayMs = config.WORKER_PROCESSING_DELAY_MS,
    private readonly maxAttempts = config.WORKER_MAX_ATTEMPTS,
  ) {}

  async start(): Promise<void> {
    const { channel, connection } = await createConsumerChannel('worker');
    this.channel = channel;
    this.connection = connection;

    channel.on('error', (error: Error) => {
      logger.error('Worker channel error', { error: error.message });
    });
    connection.on('error', (error: Error) => {
      logger.error('Worker connection error', { error: error.message });
    });
    connection.on('close', () => {
      if (!this.stopping) {
        logger.warn('Worker RabbitMQ connection closed; exiting for restart');
        process.exitCode = 1;
      }
    });

    const consumed = await channel.consume(
      `${config.QUEUE_PREFIX}.orders.queue`,
      (message) => {
        if (!message) return;
        this.active += 1;
        void this.handleMessage(message)
          .catch((error) => {
            logger.error('Unhandled worker message failure', { error: safeErrorMessage(error) });
          })
          .finally(() => {
            this.active -= 1;
          });
      },
      { noAck: false },
    );
    this.consumerTag = consumed.consumerTag;
    logger.info('Order worker consuming', {
      queue: `${config.QUEUE_PREFIX}.orders.queue`,
      prefetch: config.WORKER_PREFETCH,
      delayMs: this.processingDelayMs,
    });
  }

  private ack(message: ConsumeMessage) {
    this.channel?.ack(message);
  }

  private async handleMessage(message: ConsumeMessage): Promise<void> {
    let parsed;
    try {
      parsed = parseOrderMessage(message);
    } catch (error) {
      logger.warn('Malformed queue message', { error: safeErrorMessage(error) });
      await this.deadLetter(message, { raw: message.content.toString('utf8').slice(0, 500) }, 'MALFORMED_MESSAGE');
      return;
    }

    try {
      await this.processOrder(parsed.orderId, parsed.attempt, parsed.outboxEventId);
      this.processed += 1;
      this.ack(message);
    } catch (error) {
      this.failedAttempts += 1;
      const nextAttempt = parsed.attempt + 1;
      const messageText = safeErrorMessage(error);

      if (nextAttempt >= this.maxAttempts) {
        await this.exhaustOrFail(parsed.orderId, parsed.outboxEventId, messageText, nextAttempt);
        await this.deadLetter(
          message,
          { orderId: parsed.orderId, reason: messageText, attempts: nextAttempt },
          messageText,
        );
        return;
      }

      const delay = Math.min(
        config.WORKER_RETRY_BASE_MS * 2 ** parsed.attempt,
        30_000,
      );
      logger.warn('Scheduling worker retry', {
        orderId: parsed.orderId,
        attempt: nextAttempt,
        delay,
        error: messageText,
      });
      await recordEvent({
        type: 'WORKER_ERROR',
        level: 'warn',
        message: 'Order processing failed; message scheduled for retry',
        orderId: parsed.orderId,
        data: { attempt: nextAttempt, delayMs: delay, error: messageText },
      });

      try {
        await publishRetry(
          { orderId: parsed.orderId, eventId: parsed.outboxEventId },
          parsed.outboxEventId,
          nextAttempt,
          delay,
        );
        this.ack(message);
      } catch (publishError) {
        logger.error('Retry publish failed; returning message to queue', {
          orderId: parsed.orderId,
          error: safeErrorMessage(publishError),
        });
        this.channel?.nack(message, false, true);
      }
    }
  }

  private async processOrder(orderId: string, attempt: number, outboxEventId: string): Promise<void> {
    const marked = await markProcessing(orderId);

    if (marked) {
      await recordEvent({
        type: 'ORDER_PROCESSING',
        level: 'info',
        message: 'Worker started order processing',
        orderId,
        data: { attempt },
      });
      if (this.processingDelayMs > 0) await sleep(this.processingDelayMs);
    }

    const result = await confirmOrder(orderId);

    switch (result.outcome) {
      case 'confirmed':
        await recordEvent({
          type: 'ORDER_CONFIRMED',
          level: 'info',
          message: 'Order confirmed; reservation moved to sold ledger',
          orderId,
          data: { outboxEventId },
        });
        logger.info('Order confirmed', { orderId });
        return;
      case 'duplicate':
        await recordEvent({
          type: 'DUPLICATE_DELIVERY',
          level: 'info',
          message: `Duplicate queue delivery ignored; order is already ${result.orderStatus}`,
          orderId,
          data: { outboxEventId },
        });
        return;
      case 'expired':
        await this.releaseOrder(orderId, 'RESERVATION_EXPIRED', 'EXPIRED');
        return;
      case 'not_found':
        throw new RetryableError('Order not found in PostgreSQL');
      case 'ledger_conflict':
        await this.releaseOrder(orderId, result.reason, 'RELEASED');
        return;
    }
  }

  private async releaseOrder(
    orderId: string,
    reason: string,
    status: 'RELEASED' | 'EXPIRED',
  ): Promise<void> {
    const failResult = await failPendingOrder(orderId, reason, status);
    if (failResult.outcome === 'failed') {
      await this.tryCompensate(orderId, failResult.idempotencyKey);
      await recordEvent({
        type: 'ORDER_FAILED',
        level: 'error',
        message: 'Order failed and its reservation was released',
        orderId,
        data: { reason },
      });
    }
  }

  private async tryCompensate(orderId: string, idempotencyKey: string): Promise<void> {
    try {
      const result = await compensateReservation({ orderId, idempotencyKey });
      await recordEvent({
        type: 'RESERVATION_COMPENSATED',
        level: 'warn',
        message: 'Failed order released its Redis admission unit',
        orderId,
        data: { result: result.status, stock: result.stock },
      });
    } catch (error) {
      await recordEvent({
        type: 'SYSTEM_WARNING',
        level: 'error',
        message: 'Redis compensation failed; recovery will retry',
        orderId,
        data: { error: safeErrorMessage(error) },
      });
    }
  }

  private async exhaustOrFail(
    orderId: string,
    outboxEventId: string,
    reason: string,
    attempt: number,
  ): Promise<void> {
    try {
      const failResult = await failPendingOrder(
        orderId,
        `PROCESSING_FAILED: ${reason}`,
        'RELEASED',
      );
      if (failResult.outcome === 'failed') {
        await this.tryCompensate(orderId, failResult.idempotencyKey);
        await recordEvent({
          type: 'ORDER_FAILED',
          level: 'error',
          message: 'Order moved to FAILED after processing could not complete',
          orderId,
          data: { reason, attempt },
        });
      }
    } catch (error) {
      logger.error('Could not mark order failed', {
        orderId,
        error: safeErrorMessage(error),
      });
    }
  }

  private async deadLetter(
    message: ConsumeMessage,
    payload: unknown,
    reason: string,
  ): Promise<void> {
    try {
      await publishToDeadLetter(payload, `${Date.now()}-${Math.random()}`, reason);
      this.ack(message);
      await recordEvent({
        type: 'WORKER_ERROR',
        level: 'error',
        message: 'Message routed to the dead-letter queue',
        data: { reason: reason.slice(0, 200) },
      });
    } catch (error) {
      logger.error('Dead-letter publish failed; requeueing', { error: safeErrorMessage(error) });
      this.channel?.nack(message, false, true);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.channel && this.consumerTag) {
      try {
        await this.channel.cancel(this.consumerTag);
      } catch {
        // ignore
      }
    }
    const deadline = Date.now() + 10_000;
    while (this.active > 0 && Date.now() < deadline) {
      await sleep(100);
    }
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // ignore
    }
    this.channel = null;
    this.connection = null;
    logger.info('Order worker stopped', {
      processed: this.processed,
      failedAttempts: this.failedAttempts,
    });
  }
}

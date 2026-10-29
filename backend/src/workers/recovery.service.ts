import { prisma } from '../db/prisma';
import { config } from '../config';
import {
  compensateReservation,
  getReservationRecords,
  seedStockIfMissing,
} from '../inventory/redis-reservation';
import { getFlashSaleProduct } from '../inventory/inventory.service';
import { failPendingOrder } from '../services/order-processing.service';
import { recordEvent } from '../monitoring/monitor.service';
import { logger, safeErrorMessage } from '../lib/logger';

interface RecoveryReport {
  expiredOrders: number;
  compensatedReservations: number;
  orphanReservations: number;
  replayedOutboxEvents: number;
  admissionSeeded: boolean;
}

export class RecoveryService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly intervalMs = config.RECOVERY_INTERVAL_MS,
    private readonly orphanGraceMs = config.REDIS_ORPHAN_GRACE_SECONDS * 1000,
  ) {}

  /**
   * Repairs gaps that the Redis -> PostgreSQL hand-off cannot make atomic:
   *  - active reservations whose TTL elapsed
   *  - released reservations whose Redis compensation failed
   *  - Redis admission records with no PostgreSQL row (API crash window)
   *  - published outbox rows whose orders are still pending (lost message repair)
   */
  async runOnce(): Promise<RecoveryReport> {
    if (this.running) {
      return {
        expiredOrders: 0,
        compensatedReservations: 0,
        orphanReservations: 0,
        replayedOutboxEvents: 0,
        admissionSeeded: false,
      };
    }
    this.running = true;
    const report: RecoveryReport = {
      expiredOrders: 0,
      compensatedReservations: 0,
      orphanReservations: 0,
      replayedOutboxEvents: 0,
      admissionSeeded: false,
    };

    try {
      // Make sure a flush of Redis does not leave the admission counter absent.
      // SETNX semantics are safe if another process already seeded it.
      const product = await getFlashSaleProduct();
      if (product) {
        const durableAvailable = Math.max(
          0,
          product.initialStock - product.reservedStock - product.soldStock,
        );
        const seeded = await seedStockIfMissing(durableAvailable);
        report.admissionSeeded = seeded.seeded;
        if (seeded.seeded) {
          logger.warn('Recovery seeded missing Redis admission counter', {
            available: durableAvailable,
          });
          await recordEvent({
            type: 'RECOVERY_PASS',
            level: 'warn',
            message: 'Redis admission counter was missing; seeded from PostgreSQL ledger',
            data: { available: durableAvailable },
          });
        }
      }

      report.expiredOrders = await this.releaseExpiredOrders();
      report.compensatedReservations = await this.retryFailedCompensations();
      report.orphanReservations = await this.releaseOrphanRedisReservations();
      report.replayedOutboxEvents = await this.replayLostOutboxMessages();

      const acted =
        report.expiredOrders +
        report.compensatedReservations +
        report.orphanReservations +
        report.replayedOutboxEvents;
      if (acted > 0) {
        await recordEvent({
          type: 'RECOVERY_PASS',
          level: 'info',
          message: 'Recovery pass repaired inconsistent state',
          data: {
            expiredOrders: report.expiredOrders,
            compensatedReservations: report.compensatedReservations,
            orphanReservations: report.orphanReservations,
            replayedOutboxEvents: report.replayedOutboxEvents,
          },
        });
        logger.info('Recovery pass repaired state', { ...report });
      }
    } catch (error) {
      logger.error('Recovery pass failed', { error: safeErrorMessage(error) });
      await recordEvent({
        type: 'SYSTEM_WARNING',
        level: 'error',
        message: 'Recovery pass failed',
        data: { error: safeErrorMessage(error) },
      });
    } finally {
      this.running = false;
    }

    return report;
  }

  private async releaseExpiredOrders(): Promise<number> {
    const expired = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        reservation: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      },
      select: { id: true },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });

    let released = 0;
    for (const { id } of expired) {
      const result = await failPendingOrder(id, 'RESERVATION_EXPIRED', 'EXPIRED');
      if (result.outcome !== 'failed') continue;
      released += 1;
      try {
        const compensation = await compensateReservation({
          orderId: id,
          idempotencyKey: result.idempotencyKey,
        });
        await recordEvent({
          type: 'ORDER_FAILED',
          level: 'warn',
          message: 'Expired reservation released back to admission inventory',
          orderId: id,
          data: { compensation: compensation.status, stock: compensation.stock },
        });
      } catch (error) {
        await recordEvent({
          type: 'SYSTEM_WARNING',
          level: 'error',
          message: 'Expired order released in PostgreSQL; Redis compensation will retry',
          orderId: id,
          data: { error: safeErrorMessage(error) },
        });
      }
    }
    return released;
  }

  private async retryFailedCompensations(): Promise<number> {
    const recentFailures = await prisma.order.findMany({
      where: {
        status: 'FAILED',
        reservation: { status: { in: ['RELEASED', 'EXPIRED'] } },
        updatedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { id: true, idempotencyKey: true },
      take: 100,
      orderBy: { updatedAt: 'desc' },
    });

    let count = 0;
    for (const order of recentFailures) {
      try {
        const result = await compensateReservation({
          orderId: order.id,
          idempotencyKey: order.idempotencyKey,
        });
        // NOT_FOUND is the normal steady state after a successful release.
        if (result.status === 'COMPENSATED') count += 1;
      } catch {
        // Redis still unavailable; next pass retries.
      }
    }
    return count;
  }

  private async releaseOrphanRedisReservations(): Promise<number> {
    const cutoff = Date.now() - this.orphanGraceMs;
    const records = await getReservationRecords();
    const candidates = records.filter((record) => {
      const createdAt = Date.parse(record.createdAt);
      return Number.isFinite(createdAt) && createdAt < cutoff;
    });
    if (candidates.length === 0) return 0;

    const ids = candidates.map((record) => record.orderId);
    const existing = await prisma.reservation.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((row) => row.id));

    let released = 0;
    for (const record of candidates) {
      if (existingIds.has(record.orderId)) continue;
      try {
        const result = await compensateReservation({
          orderId: record.orderId,
          idempotencyKey: record.idempotencyKey,
        });
        if (result.status === 'COMPENSATED') {
          released += 1;
          await recordEvent({
            type: 'ORPHAN_RESERVATION_RELEASED',
            level: 'warn',
            message: 'Released Redis reservation with no durable PostgreSQL order',
            orderId: record.orderId,
            data: { stock: result.stock },
          });
        }
      } catch (error) {
        logger.warn('Orphan reservation compensation failed', {
          orderId: record.orderId,
          error: safeErrorMessage(error),
        });
      }
    }
    return released;
  }

  /**
   * A durable RabbitMQ message should survive broker restarts. If an outbox row
   * was published but its order is still pending after a generous window, put it
   * back in the outbox. Duplicate processing is safe, so this repair cannot
   * double-confirm an order.
   */
  private async replayLostOutboxMessages(): Promise<number> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    const stuck = await prisma.order.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: cutoff },
        outboxEvents: { some: { status: 'PUBLISHED' } },
      },
      select: { id: true },
      take: 50,
    });

    let replayed = 0;
    for (const order of stuck) {
      const updated = await prisma.outboxEvent.updateMany({
        where: { orderId: order.id, status: 'PUBLISHED' },
        data: {
          status: 'PENDING',
          nextAttemptAt: new Date(),
          lastError: 'Requeued by recovery: published but order still pending',
        },
      });
      if (updated.count > 0) {
        replayed += updated.count;
        await recordEvent({
          type: 'RECOVERY_PASS',
          level: 'warn',
          message: 'Requeued published outbox event for a still-pending order',
          orderId: order.id,
        });
      }
    }
    return replayed;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.runOnce();
    logger.info('Recovery service started', { intervalMs: this.intervalMs });
    const loop = async () => {
      if (this.stopped) return;
      await this.runOnce();
      this.timer = setTimeout(() => void loop(), this.intervalMs);
    };
    this.timer = setTimeout(() => void loop(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

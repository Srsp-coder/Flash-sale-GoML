import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/db/redis';
import {
  FLASH_SALE_PRODUCT_ID,
  FLASH_SALE_SKU,
  redisKeys,
} from '../src/config';
import { processCheckout } from '../src/services/checkout.service';
import { reserveUnit } from '../src/inventory/redis-reservation';
import { RecoveryService } from '../src/workers/recovery.service';
import { closeTestConnections, resetTestState } from './helpers/database';

const payload = {
  productId: FLASH_SALE_PRODUCT_ID,
  customerName: 'Ira Menon',
  customerEmail: 'ira@example.com',
  shippingAddress: '8 Church Street, Bengaluru 560001',
};

async function createOrder(key: string) {
  return processCheckout(payload, key);
}

beforeEach(async () => {
  await resetTestState(500);
});

afterAll(async () => {
  await closeTestConnections();
});

describe('Recovery and compensation', () => {
  it('releases an expired reservation back to admission inventory', async () => {
    const created = await createOrder('recovery-expiry-0001');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });
    await prisma.reservation.update({
      where: { id: order.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const report = await new RecoveryService(1_000, 60_000).runOnce();
    expect(report.expiredOrders).toBe(1);

    const failed = await prisma.order.findUniqueOrThrow({
      where: { id: created.orderId },
      include: { reservation: true },
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.failureReason).toContain('EXPIRED');
    expect(failed.reservation.status).toBe('EXPIRED');

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 0, soldStock: 0 });
    expect(await redis.get(redisKeys.stock)).toBe('500');

    const snapshot = await prisma.$transaction(async (tx) => {
      const activeRows = await tx.reservation.count({
        where: { productId: product.id, status: 'ACTIVE' },
      });
      const confirmedRows = await tx.order.count({
        where: { productId: product.id, status: 'CONFIRMED' },
      });
      return { activeRows, confirmedRows };
    });
    expect(snapshot).toEqual({ activeRows: 0, confirmedRows: 0 });
  });

  it('releases a Redis admission record with no durable PostgreSQL row', async () => {
    const params = {
      orderId: randomUUID(),
      idempotencyKey: 'recovery-orphan-0001',
      payloadHash: 'orphan-hash',
    };
    const admitted = await reserveUnit(params);
    expect(admitted.status).toBe('SUCCESS_NEW');
    expect(await redis.get(redisKeys.stock)).toBe('499');

    // A negative grace window makes the freshly-created record immediately
    // eligible, which simulates the API-crash window without waiting.
    const report = await new RecoveryService(1_000, -1_000).runOnce();
    expect(report.orphanReservations).toBe(1);
    expect(await redis.get(redisKeys.stock)).toBe('500');
  });

  it('reseeds a flushed Redis admission counter from the durable ledger', async () => {
    await redis.del(redisKeys.stock);

    const report = await new RecoveryService(1_000, 60_000).runOnce();
    expect(report.admissionSeeded).toBe(true);
    expect(await redis.get(redisKeys.stock)).toBe('500');
  });

  it('replays a published outbox event whose order is still pending', async () => {
    const created = await createOrder('recovery-outbox-0001');
    await prisma.outboxEvent.updateMany({
      where: { orderId: created.orderId },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await prisma.order.update({
      where: { id: created.orderId },
      data: { createdAt: new Date(Date.now() - 11 * 60 * 1000) },
    });

    const report = await new RecoveryService(1_000, 60_000).runOnce();
    expect(report.replayedOutboxEvents).toBe(1);

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { orderId: created.orderId },
    });
    expect(event.status).toBe('PENDING');
    expect(event.lastError).toContain('published but order still pending');
    expect(event.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('leaves a healthy ledger untouched', async () => {
    const created = await createOrder('recovery-healthy-0001');
    const report = await new RecoveryService(1_000, 60_000).runOnce();

    expect(report).toMatchObject({
      expiredOrders: 0,
      compensatedReservations: 0,
      orphanReservations: 0,
      replayedOutboxEvents: 0,
      admissionSeeded: false,
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });
    expect(order.status).toBe('PENDING');
    expect(await redis.get(redisKeys.stock)).toBe('499');
  });
});

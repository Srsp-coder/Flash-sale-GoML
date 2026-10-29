import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { OutboxPublisher } from '../src/services/outbox.publisher';
import { processCheckout } from '../src/services/checkout.service';
import { confirmOrder } from '../src/services/order-processing.service';
import { FLASH_SALE_PRODUCT_ID, FLASH_SALE_SKU } from '../src/config';
import { closeTestConnections, resetTestState } from './helpers/database';

const payload = {
  productId: FLASH_SALE_PRODUCT_ID,
  customerName: 'Neel Sharma',
  customerEmail: 'neel@example.com',
  shippingAddress: '22 MG Road, Bengaluru 560001',
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

describe('Transactional outbox', () => {
  it('publishes a committed event exactly once and records the attempt', async () => {
    const created = await createOrder('outbox-key-0001');
    const published: Array<{ payload: unknown; id: string }> = [];

    const publisher = new OutboxPublisher(async (eventPayload, id) => {
      published.push({ payload: eventPayload, id });
    });
    const result = await publisher.tick();

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({ orderId: created.orderId, quantity: 1 });

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { orderId: created.orderId },
    });
    expect(event.status).toBe('PUBLISHED');
    expect(event.attempts).toBe(1);
    expect(event.publishedAt).not.toBeNull();
    expect(event.lockedAt).toBeNull();
    expect(event.lastError).toBeNull();

    // A second tick finds nothing claimable and must not republish.
    expect(await publisher.tick()).toEqual({ published: 0, failed: 0 });
    expect(published).toHaveLength(1);
  });

  it('keeps the event durable and backs off when publishing fails', async () => {
    const created = await createOrder('outbox-key-0002');
    let attempts = 0;
    const publisher = new OutboxPublisher(async () => {
      attempts += 1;
      throw new Error('broker unavailable');
    });

    expect(await publisher.tick()).toEqual({ published: 0, failed: 1 });
    expect(attempts).toBe(1);

    let event = await prisma.outboxEvent.findFirstOrThrow({
      where: { orderId: created.orderId },
    });
    expect(event.status).toBe('PENDING');
    expect(event.attempts).toBe(1);
    expect(event.lastError).toContain('broker unavailable');
    expect(event.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { nextAttemptAt: new Date(Date.now() - 1) },
    });

    const successPublisher = new OutboxPublisher(async () => undefined);
    expect(await successPublisher.tick()).toEqual({ published: 1, failed: 0 });
    event = await prisma.outboxEvent.findFirstOrThrow({ where: { id: event.id } });
    expect(event.status).toBe('PUBLISHED');
    expect(event.attempts).toBe(2);
  });

  it('does not let two publishers claim the same event', async () => {
    await createOrder('outbox-key-0003');
    let publishCalls = 0;

    const slow = new OutboxPublisher(async () => {
      publishCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const fast = new OutboxPublisher(async () => {
      publishCalls += 1;
    });

    const [first, second] = await Promise.all([slow.tick(), fast.tick()]);
    expect(first.published + second.published).toBe(1);
    expect(publishCalls).toBe(1);
  });
});

describe('Idempotent order processing', () => {
  it('moves a unit from reserved to sold exactly once', async () => {
    const created = await createOrder('processing-key-0001');

    const first = await confirmOrder(created.orderId);
    const second = await confirmOrder(created.orderId);

    expect(first).toMatchObject({ outcome: 'confirmed', orderStatus: 'CONFIRMED' });
    expect(second).toMatchObject({ outcome: 'duplicate', orderStatus: 'CONFIRMED' });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: created.orderId },
      include: { reservation: true },
    });
    expect(order.status).toBe('CONFIRMED');
    expect(order.reservation.status).toBe('CONFIRMED');

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 0, soldStock: 1 });

    const concurrent = await Promise.all([
      confirmOrder(created.orderId),
      confirmOrder(created.orderId),
      confirmOrder(created.orderId),
    ]);
    expect(concurrent.every((result) => result.outcome === 'duplicate')).toBe(true);
    const unchanged = await prisma.product.findUniqueOrThrow({ where: { sku: FLASH_SALE_SKU } });
    expect(unchanged).toMatchObject({ reservedStock: 0, soldStock: 1 });
  });

  it('rejects confirmation after the reservation expired', async () => {
    const created = await createOrder('processing-key-0002');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });

    await prisma.reservation.update({
      where: { id: order.reservationId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const result = await confirmOrder(created.orderId);
    expect(result).toEqual({ outcome: 'expired', orderId: created.orderId });

    const product = await prisma.product.findUniqueOrThrow({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 1, soldStock: 0 });
  });
});

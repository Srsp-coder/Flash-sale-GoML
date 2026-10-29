import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app';
import { prisma } from '../src/db/prisma';
import { redis } from '../src/db/redis';
import { FLASH_SALE_PRODUCT_ID, FLASH_SALE_SKU, redisKeys } from '../src/config';
import { closeTestConnections, resetTestState } from './helpers/database';

const checkoutPayload = {
  productId: FLASH_SALE_PRODUCT_ID,
  customerName: 'Asha Rao',
  customerEmail: 'asha@example.com',
  shippingAddress: '14 Indiranagar 100 Feet Road, Bengaluru 560038',
};

function postCheckout(key: string, payload: Record<string, unknown> = checkoutPayload) {
  return request(app)
    .post('/api/checkout')
    .set('Idempotency-Key', key)
    .set('Content-Type', 'application/json')
    .send(payload);
}

beforeEach(async () => {
  await resetTestState(500);
});

afterAll(async () => {
  await closeTestConnections();
});

describe('FlashSale checkout API', () => {
  it('reports health and the seeded product without exposing internals', async () => {
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body).toMatchObject({ status: 'ok', service: 'flashsale-api' });

    const product = await request(app).get('/api/products/flash-sale').expect(200);
    expect(product.body.product).toMatchObject({
      sku: FLASH_SALE_SKU,
      priceInr: 49_999,
    });
    expect(product.body.inventory).toMatchObject({
      initialStock: 500,
      availableStock: 500,
      activeReservations: 0,
      confirmedOrders: 0,
      admissionStock: 500,
      invariantHolds: true,
    });
    expect(product.body.sale).toMatchObject({ status: 'LIVE', totalUnits: 500 });
    expect(product.body.product).not.toHaveProperty('reservedStock');
    expect(product.body.product).not.toHaveProperty('soldStock');
  });

  it('requires an Idempotency-Key and validates it', async () => {
    const missing = await request(app).post('/api/checkout').send(checkoutPayload).expect(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await postCheckout('short').expect(400);
    expect(invalid.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');

    const invalidChars = await postCheckout('not valid key with spaces').expect(400);
    expect(invalidChars.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('rejects malformed checkout payloads with field details', async () => {
    const response = await postCheckout('validation-key-0001', {
      ...checkoutPayload,
      customerEmail: 'not-an-email',
      unexpected: true,
    }).expect(400);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.fields.length).toBeGreaterThan(0);
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await request(app)
      .post('/api/checkout')
      .set('Idempotency-Key', 'invalid-json-key-01')
      .set('Content-Type', 'application/json')
      .send('{"productId":')
      .expect(400);

    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('returns 202 only after the reservation, order and outbox row are committed', async () => {
    const response = await postCheckout('durable-key-0001').expect(202);
    expect(response.body).toMatchObject({
      status: 'PENDING',
      replayed: false,
      remainingStock: 499,
    });
    expect(response.body.orderId).toMatch(/^[0-9a-f-]{36}$/);

    const order = await prisma.order.findUnique({
      where: { id: response.body.orderId },
      include: { reservation: true, outboxEvents: true },
    });
    expect(order).not.toBeNull();
    expect(order?.status).toBe('PENDING');
    expect(order?.idempotencyKey).toBe('durable-key-0001');
    expect(order?.reservation.status).toBe('ACTIVE');
    expect(order?.reservation.idempotencyKey).toBe('durable-key-0001');
    expect(order?.outboxEvents).toHaveLength(1);
    expect(order?.outboxEvents[0]).toMatchObject({
      eventType: 'ORDER_RESERVED',
      status: 'PENDING',
    });

    const product = await prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 1, soldStock: 0 });
    expect(await redis.get(redisKeys.stock)).toBe('499');

    const snapshot = await request(app).get('/api/products/flash-sale').expect(200);
    expect(snapshot.body.inventory).toMatchObject({
      availableStock: 499,
      activeReservations: 1,
      confirmedOrders: 0,
      admissionStock: 499,
      invariantHolds: true,
    });
  });

  it('replays the same key without decrementing inventory twice', async () => {
    const first = await postCheckout('replay-key-0001').expect(202);
    const second = await postCheckout('replay-key-0001').expect(202);

    expect(second.body.orderId).toBe(first.body.orderId);
    expect(second.body.replayed).toBe(true);
    expect(second.body.status).toBe('PENDING');
    expect(second.body.remainingStock).toBeNull();

    const product = await prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 1, soldStock: 0 });
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.reservation.count()).toBe(1);
    expect(await redis.get(redisKeys.stock)).toBe('499');
  });

  it('rejects a reused Idempotency-Key with a different payload', async () => {
    await postCheckout('mismatch-key-0001').expect(202);

    const mismatch = await postCheckout('mismatch-key-0001', {
      ...checkoutPayload,
      customerName: 'Different Person',
    }).expect(409);

    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect(await prisma.order.count()).toBe(1);
    expect(await redis.get(redisKeys.stock)).toBe('499');
    const product = await prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ reservedStock: 1, soldStock: 0 });
  });

  it('returns 409 SOLD_OUT when admission stock is exhausted', async () => {
    await redis.set(redisKeys.stock, '0');

    const response = await postCheckout('sold-out-key-0001').expect(409);
    expect(response.body.error.code).toBe('SOLD_OUT');
    expect(await prisma.order.count()).toBe(0);
    expect(await redis.get(redisKeys.stock)).toBe('0');
  });

  it('honours the durable ledger guard even if Redis over-admits', async () => {
    await prisma.product.update({
      where: { sku: FLASH_SALE_SKU },
      data: { initialStock: 0 },
    });
    await redis.set(redisKeys.stock, '1');

    const response = await postCheckout('durable-guard-key-01').expect(409);
    expect(response.body.error.code).toBe('SOLD_OUT');

    const product = await prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
    expect(product).toMatchObject({ initialStock: 0, reservedStock: 0, soldStock: 0 });
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.reservation.count()).toBe(0);
    // Compensation returns the unit that Redis admitted but PostgreSQL refused.
    expect(await redis.get(redisKeys.stock)).toBe('1');
  });

  it('tracks a durable order while masking personal data', async () => {
    const created = await postCheckout('tracking-key-0001').expect(202);

    const tracking = await request(app)
      .get(`/api/orders/${created.body.orderId}`)
      .expect(200);

    expect(tracking.body.terminal).toBe(false);
    expect(tracking.body.order).toMatchObject({
      id: created.body.orderId,
      status: 'PENDING',
      quantity: 1,
      reservationStatus: 'ACTIVE',
      customer: { name: 'A*** R**', email: 'a***@example.com' },
    });
    expect(tracking.body.order.customerName).toBeUndefined();
    expect(tracking.body.order.shippingAddress).toBeUndefined();
    expect(tracking.body.order.timeline).toHaveLength(3);
  });

  it('returns structured 400/404 errors for order tracking', async () => {
    const invalid = await request(app).get('/api/orders/not-a-uuid').expect(400);
    expect(invalid.body.error.code).toBe('INVALID_ORDER_ID');

    const missing = await request(app)
      .get('/api/orders/99999999-9999-4999-8999-999999999999')
      .expect(404);
    expect(missing.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('exposes a monitor overview whose invariant holds after a checkout', async () => {
    await postCheckout('monitor-key-0001').expect(202);

    const overview = await request(app).get('/api/monitor/overview').expect(200);
    expect(overview.body.inventory).toMatchObject({
      initialStock: 500,
      availableStock: 499,
      activeReservations: 1,
      confirmedOrders: 0,
      invariant: { holds: true },
    });
    expect(overview.body.checkout).toMatchObject({
      attempts: 1,
      accepted: 1,
    });
    expect(overview.body.asyncProcessing.outbox.pending).toBe(1);
    expect(overview.body.orders.pending).toBe(1);
  });
});

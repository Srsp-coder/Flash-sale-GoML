import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  compensateReservation,
  getAdmissionStock,
  getReservationRecords,
  reserveUnit,
} from '../src/inventory/redis-reservation';
import { closeTestConnections, resetTestState } from './helpers/database';

beforeEach(async () => {
  await resetTestState(500);
});

afterAll(async () => {
  await closeTestConnections();
});

describe('Redis admission gate', () => {
  it('atomically admits exactly 500 of 600 concurrent unique requests', async () => {
    const requests = Array.from({ length: 600 }, (_, index) => ({
      orderId: randomUUID(),
      idempotencyKey: `admission-key-${String(index).padStart(4, '0')}`,
      payloadHash: `hash-${index}`,
    }));

    const results = await Promise.all(requests.map((request) => reserveUnit(request)));
    const accepted = results.filter((result) => result.status === 'SUCCESS_NEW');
    const soldOut = results.filter((result) => result.status === 'ERR_SOLD_OUT');

    expect(accepted).toHaveLength(500);
    expect(soldOut).toHaveLength(100);
    expect(await getAdmissionStock()).toBe(0);

    const lastAccepted = accepted[accepted.length - 1];
    expect(lastAccepted && 'remainingStock' in lastAccepted ? lastAccepted.remainingStock : null).toBe(0);

    const records = await getReservationRecords();
    expect(records).toHaveLength(500);
    expect(new Set(records.map((record) => record.orderId)).size).toBe(500);

    const compensations = await Promise.all(
      requests.map((request) =>
        compensateReservation({ orderId: request.orderId, idempotencyKey: request.idempotencyKey }),
      ),
    );
    // Only the 500 admitted orders own a Redis record; the 100 sold-out attempts
    // must not be able to increment the counter.
    expect(compensations.filter((result) => result.status === 'COMPENSATED')).toHaveLength(500);
    expect(compensations.filter((result) => result.status === 'NOT_FOUND')).toHaveLength(100);
    expect(await getAdmissionStock()).toBe(500);
    expect(await getReservationRecords()).toHaveLength(0);
  });

  it('resolves concurrent duplicate Idempotency-Keys to one admission', async () => {
    const orderId = randomUUID();
    const shared = {
      orderId,
      idempotencyKey: 'same-key-concurrent-01',
      payloadHash: 'same-payload-hash',
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveUnit({ ...shared, orderId: randomUUID() })),
    );

    const created = results.filter((result) => result.status === 'SUCCESS_NEW');
    const replays = results.filter((result) => result.status === 'SUCCESS_IDEMPOTENT');
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(replays.map((result) => (result as { orderId: string }).orderId)).size).toBe(1);

    const winningOrderId = (created[0] as { orderId: string }).orderId;
    for (const replay of replays) {
      expect((replay as { orderId: string }).orderId).toBe(winningOrderId);
    }
    expect(await getAdmissionStock()).toBe(499);
  });

  it('rejects a reused key with a different payload without consuming a unit', async () => {
    const params = {
      orderId: randomUUID(),
      idempotencyKey: 'payload-mismatch-key-01',
      payloadHash: 'hash-a',
    };
    await reserveUnit(params);

    const mismatch = await reserveUnit({
      orderId: randomUUID(),
      idempotencyKey: params.idempotencyKey,
      payloadHash: 'hash-b',
    });

    expect(mismatch.status).toBe('ERR_IDEMPOTENCY_MISMATCH');
    expect((mismatch as { existingOrderId: string }).existingOrderId).toBe(params.orderId);
    expect(await getAdmissionStock()).toBe(499);
  });

  it('makes compensation idempotent', async () => {
    const params = {
      orderId: randomUUID(),
      idempotencyKey: 'compensation-key-01',
      payloadHash: 'hash-c',
    };
    await reserveUnit(params);
    expect(await getAdmissionStock()).toBe(499);

    const first = await compensateReservation({
      orderId: params.orderId,
      idempotencyKey: params.idempotencyKey,
    });
    const second = await compensateReservation({
      orderId: params.orderId,
      idempotencyKey: params.idempotencyKey,
    });

    expect(first).toEqual({ status: 'COMPENSATED', stock: 500 });
    expect(second).toEqual({ status: 'NOT_FOUND', stock: 500 });
  });

  it('refuses admission when the counter has not been initialized', async () => {
    const { redis } = await import('../src/db/redis');
    const { redisKeys } = await import('../src/config');
    await redis.del(redisKeys.stock);

    const result = await reserveUnit({
      orderId: randomUUID(),
      idempotencyKey: 'uninitialized-key-01',
      payloadHash: 'hash-d',
    });
    expect(result.status).toBe('ERR_NOT_INITIALIZED');
  });
});

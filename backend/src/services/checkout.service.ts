import { createHash, randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { config, FLASH_SALE_PRODUCT_ID } from '../config';
import { AppError } from '../lib/errors';
import { logger, safeErrorMessage } from '../lib/logger';
import {
  compensateReservation,
  reserveUnit,
  ReserveResult,
} from '../inventory/redis-reservation';
import { getFlashSaleProduct } from '../inventory/inventory.service';
import { incrementStat, recordEvent } from '../monitoring/monitor.service';

export interface CheckoutPayload {
  productId: string;
  customerName: string;
  customerEmail: string;
  shippingAddress: string;
}

export interface CheckoutResponse {
  orderId: string;
  status: string;
  trackingUrl: string;
  acceptedAt: string;
  remainingStock: number | null;
  replayed: boolean;
  message: string;
}

export function computePayloadHash(payload: CheckoutPayload): string {
  const normalized = JSON.stringify({
    productId: payload.productId.trim(),
    customerName: payload.customerName.trim().toLowerCase(),
    customerEmail: payload.customerEmail.trim().toLowerCase(),
    shippingAddress: payload.shippingAddress.trim().replace(/\s+/g, ' ').toLowerCase(),
  });
  return createHash('sha256').update(normalized).digest('hex');
}

function replayResponse(
  order: { id: string; status: string; createdAt: Date },
  message = 'Existing checkout returned for this Idempotency-Key',
): CheckoutResponse {
  return {
    orderId: order.id,
    status: order.status,
    trackingUrl: `/orders/${order.id}`,
    acceptedAt: order.createdAt.toISOString(),
    remainingStock: null,
    replayed: true,
    message,
  };
}

async function findOrderByIdempotencyKey(idempotencyKey: string) {
  return prisma.order.findUnique({ where: { idempotencyKey } });
}

async function waitForOrder(orderId: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order) return order;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return null;
}

async function compensateSafely(orderId: string, idempotencyKey: string, reason: string) {
  try {
    const result = await compensateReservation({ orderId, idempotencyKey });
    await recordEvent({
      type: 'RESERVATION_COMPENSATED',
      level: 'warn',
      message: 'Redis reservation released after checkout persistence failure',
      orderId,
      data: { reason, result: result.status, stock: result.stock },
    });
  } catch (error) {
    // Do not fail the original request again. The recovery sweeper retries
    // compensation for released reservations and orphaned Redis records.
    logger.error('Redis compensation failed', { orderId, reason, error: safeErrorMessage(error) });
    await recordEvent({
      type: 'SYSTEM_WARNING',
      level: 'error',
      message: 'Redis compensation failed and will be retried by recovery',
      orderId,
      data: { reason, error: safeErrorMessage(error) },
    });
  }
}

class DurableSoldOutError extends Error {}

/**
 * Checkout consistency boundary:
 *   1. Redis atomically admits one unit (fast, not durable).
 *   2. PostgreSQL transaction writes reservation + order + outbox and increments
 *      the durable reserved ledger under a row-level capacity guard.
 *   3. Only after commit does the API return 202.
 *
 * These are not one distributed transaction. If step 2 fails, step 1 is
 * compensated; if the process dies between them, the recovery sweeper releases
 * the orphaned Redis reservation after a grace period.
 */
export async function processCheckout(
  payload: CheckoutPayload,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  const startedAt = Date.now();
  await incrementStat('attempts');

  const product = await getFlashSaleProduct();
  if (!product) {
    await incrementStat('failed');
    throw new AppError(503, 'PRODUCT_NOT_READY', 'Flash sale is not configured yet');
  }

  if (payload.productId !== product.id && payload.productId !== product.sku) {
    await incrementStat('rejected');
    throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Requested product is not part of this flash sale');
  }

  const payloadHash = computePayloadHash({ ...payload, productId: product.id });

  // Durable idempotency check first: protects against replayed requests after a
  // Redis restart and gives a fast answer for already-finished checkouts.
  const existing = await findOrderByIdempotencyKey(idempotencyKey);
  if (existing) {
    if (existing.payloadHash !== payloadHash) {
      await incrementStat('rejected');
      throw new AppError(
        409,
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used with a different checkout payload',
      );
    }
    await incrementStat('idempotent');
    await recordEvent({
      type: 'CHECKOUT_IDEMPOTENT',
      level: 'info',
      message: 'Duplicate checkout request returned the existing order',
      orderId: existing.id,
      data: { latencyMs: Date.now() - startedAt },
    });
    return replayResponse(existing);
  }

  const orderId = randomUUID();
  let reservation: ReserveResult;
  try {
    reservation = await reserveUnit({ orderId, idempotencyKey, payloadHash });
  } catch (error) {
    await incrementStat('failed');
    logger.error('Redis admission failed', { error: safeErrorMessage(error) });
    throw new AppError(
      503,
      'INVENTORY_UNAVAILABLE',
      'Inventory coordination is temporarily unavailable. No order was created.',
    );
  }

  if (reservation.status === 'ERR_NOT_INITIALIZED') {
    await incrementStat('failed');
    throw new AppError(
      503,
      'INVENTORY_NOT_READY',
      'Inventory coordination is being initialized. Please retry shortly.',
    );
  }

  if (reservation.status === 'ERR_SOLD_OUT') {
    await incrementStat('soldOut');
    await recordEvent({
      type: 'CHECKOUT_SOLD_OUT',
      level: 'warn',
      message: 'Checkout rejected because all units were admitted',
      data: { latencyMs: Date.now() - startedAt },
    });
    throw new AppError(409, 'SOLD_OUT', 'All 500 flash-sale units have been claimed');
  }

  if (reservation.status === 'ERR_IDEMPOTENCY_MISMATCH') {
    await incrementStat('rejected');
    throw new AppError(
      409,
      'IDEMPOTENCY_MISMATCH',
      'This Idempotency-Key was already used with a different checkout payload',
    );
  }

  if (reservation.status === 'SUCCESS_IDEMPOTENT') {
    const order = await waitForOrder(reservation.orderId);
    if (!order) {
      await incrementStat('failed');
      throw new AppError(
        503,
        'REQUEST_IN_PROGRESS',
        'The original request for this Idempotency-Key is still being persisted. Retry shortly.',
        { retryAfterSeconds: 1 },
      );
    }
    if (order.payloadHash !== payloadHash) {
      await incrementStat('rejected');
      throw new AppError(
        409,
        'IDEMPOTENCY_MISMATCH',
        'This Idempotency-Key was already used with a different checkout payload',
      );
    }
    await incrementStat('idempotent');
    await recordEvent({
      type: 'CHECKOUT_IDEMPOTENT',
      level: 'info',
      message: 'Concurrent duplicate checkout resolved to the existing order',
      orderId: order.id,
      data: { latencyMs: Date.now() - startedAt },
    });
    return replayResponse(order);
  }

  const expiresAt = new Date(Date.now() + config.RESERVATION_TTL_SECONDS * 1000);

  try {
    const order = await prisma.$transaction(async (tx) => {
      // Final durable capacity guard. The row lock serializes concurrent writers
      // and the WHERE clause makes overselling impossible even if Redis admits
      // too many requests (for example after a cache flush during a race).
      const updated = await tx.$executeRaw`
        UPDATE "products"
        SET "reservedStock" = "reservedStock" + 1,
            "updatedAt" = NOW()
        WHERE "id" = ${product.id}
          AND "reservedStock" + "soldStock" + 1 <= "initialStock"
      `;
      if (updated !== 1) throw new DurableSoldOutError();

      await tx.reservation.create({
        data: {
          id: orderId,
          productId: product.id,
          quantity: 1,
          idempotencyKey,
          payloadHash,
          status: 'ACTIVE',
          expiresAt,
        },
      });

      const created = await tx.order.create({
        data: {
          id: orderId,
          productId: product.id,
          reservationId: orderId,
          idempotencyKey,
          payloadHash,
          status: 'PENDING',
          quantity: 1,
          unitPriceInr: product.priceInr,
          totalPriceInr: product.priceInr,
          customerName: payload.customerName.trim(),
          customerEmail: payload.customerEmail.trim().toLowerCase(),
          shippingAddress: payload.shippingAddress.trim(),
        },
      });

      await tx.outboxEvent.create({
        data: {
          orderId: created.id,
          eventType: 'ORDER_RESERVED',
          status: 'PENDING',
          payload: {
            orderId: created.id,
            productId: product.id,
            quantity: 1,
            eventId: randomUUID(),
          },
          nextAttemptAt: new Date(),
        },
      });

      return created;
    }, { maxWait: 15_000, timeout: 30_000 });

    await incrementStat('accepted');
    await recordEvent({
      type: 'CHECKOUT_ACCEPTED',
      level: 'info',
      message: 'Reservation, order and outbox event committed to PostgreSQL',
      orderId: order.id,
      data: {
        remainingAdmissionStock: reservation.remainingStock,
        latencyMs: Date.now() - startedAt,
      },
    });

    logger.info('Checkout accepted', {
      orderId: order.id,
      remainingStock: reservation.remainingStock,
      latencyMs: Date.now() - startedAt,
    });

    return {
      orderId: order.id,
      status: order.status,
      trackingUrl: `/orders/${order.id}`,
      acceptedAt: order.createdAt.toISOString(),
      remainingStock: reservation.remainingStock,
      replayed: false,
      message: 'Reservation accepted and queued for processing',
    };
  } catch (error) {
    await compensateSafely(orderId, idempotencyKey, 'POSTGRES_CHECKOUT_FAILURE');

    if (error instanceof DurableSoldOutError) {
      await incrementStat('soldOut');
      await recordEvent({
        type: 'CHECKOUT_REJECTED',
        level: 'warn',
        message: 'Durable ledger capacity guard rejected admission',
        orderId,
        data: { reason: 'DURABLE_LEDGER_FULL' },
      });
      throw new AppError(409, 'SOLD_OUT', 'All 500 flash-sale units have been claimed');
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // A Redis restart can remove the idempotency record while PostgreSQL still
      // holds it. The unique constraint is the final arbiter; return the existing
      // order if the payload matches instead of creating a duplicate.
      const duplicate = await findOrderByIdempotencyKey(idempotencyKey);
      if (duplicate && duplicate.payloadHash === payloadHash) {
        await incrementStat('idempotent');
        await recordEvent({
          type: 'CHECKOUT_IDEMPOTENT',
          level: 'info',
          message: 'Database uniqueness resolved a duplicate checkout',
          orderId: duplicate.id,
        });
        return replayResponse(duplicate);
      }
    }

    await incrementStat('failed');
    logger.error('Checkout persistence failed', {
      orderId,
      error: safeErrorMessage(error),
    });
    throw new AppError(
      503,
      'PERSISTENCE_UNAVAILABLE',
      'Unable to durably record the order. No successful order was created.',
    );
  }
}

import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { randomUUID } from 'crypto';

export type ConfirmOutcome =
  | { outcome: 'confirmed'; orderId: string; orderStatus: string }
  | { outcome: 'duplicate'; orderId: string; orderStatus: string }
  | { outcome: 'expired'; orderId: string }
  | { outcome: 'not_found'; orderId: string }
  | { outcome: 'ledger_conflict'; orderId: string; reason: string };

export async function markProcessing(orderId: string): Promise<boolean> {
  const updated = await prisma.order.updateMany({
    where: { id: orderId, status: 'PENDING', processingStartedAt: null },
    data: { processingStartedAt: new Date() },
  });
  return updated.count === 1;
}

export async function confirmOrder(orderId: string): Promise<ConfirmOutcome> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
    `;
    if (locked.length === 0) {
      return { outcome: 'not_found', orderId };
    }

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { reservation: true },
    });
    if (!order) return { outcome: 'not_found', orderId };

    if (order.status !== 'PENDING') {
      return { outcome: 'duplicate', orderId, orderStatus: order.status };
    }

    if (order.reservation.expiresAt.getTime() <= Date.now()) {
      return { outcome: 'expired', orderId };
    }

    if (order.reservation.status !== 'ACTIVE') {
      return {
        outcome: 'ledger_conflict',
        orderId,
        reason: `Reservation is ${order.reservation.status} while order is PENDING`,
      };
    }

    const productUpdate = await tx.$executeRaw`
      UPDATE "products"
      SET "reservedStock" = "reservedStock" - 1,
          "soldStock" = "soldStock" + 1,
          "updatedAt" = NOW()
      WHERE "id" = ${order.productId}
        AND "reservedStock" >= ${order.quantity}
    `;
    if (productUpdate !== 1) {
      return {
        outcome: 'ledger_conflict',
        orderId,
        reason: 'Durable reserved ledger could not move the unit to sold',
      };
    }

    const reservationUpdate = await tx.reservation.updateMany({
      where: { id: order.reservationId, status: 'ACTIVE' },
      data: { status: 'CONFIRMED', releasedAt: new Date() },
    });
    if (reservationUpdate.count !== 1) {
      throw new Error('Reservation transition raced unexpectedly under row lock');
    }

    const now = new Date();
    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'CONFIRMED',
        confirmedAt: now,
        processingStartedAt: order.processingStartedAt ?? now,
        failureReason: null,
      },
    });

    return { outcome: 'confirmed', orderId, orderStatus: 'CONFIRMED' };
  });
}

export type FailOutcome =
  | { outcome: 'failed'; orderId: string; idempotencyKey: string }
  | { outcome: 'duplicate'; orderId: string; idempotencyKey: string; orderStatus: string }
  | { outcome: 'not_found'; orderId: string };

export async function failPendingOrder(
  orderId: string,
  reason: string,
  reservationStatus: 'RELEASED' | 'EXPIRED' = 'RELEASED',
): Promise<FailOutcome> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
    `;
    if (locked.length === 0) return { outcome: 'not_found', orderId };

    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { reservation: true },
    });
    if (!order) return { outcome: 'not_found', orderId };

    if (order.status !== 'PENDING') {
      return {
        outcome: 'duplicate',
        orderId,
        idempotencyKey: order.idempotencyKey,
        orderStatus: order.status,
      };
    }

    const productUpdate = await tx.$executeRaw`
      UPDATE "products"
      SET "reservedStock" = "reservedStock" - 1,
          "updatedAt" = NOW()
      WHERE "id" = ${order.productId}
        AND "reservedStock" >= ${order.quantity}
    `;
    if (productUpdate !== 1) {
      // A ledger mismatch must be visible. Still move the order to FAILED so it
      // does not remain stuck forever; the monitor invariant will flag the drift.
      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'FAILED',
          failureReason: `${reason}; reserved ledger could not be decremented`,
        },
      });
      await tx.reservation.updateMany({
        where: { id: order.reservationId, status: 'ACTIVE' },
        data: { status: reservationStatus, releasedAt: new Date() },
      });
      return { outcome: 'failed', orderId, idempotencyKey: order.idempotencyKey };
    }

    await tx.reservation.updateMany({
      where: { id: order.reservationId, status: 'ACTIVE' },
      data: { status: reservationStatus, releasedAt: new Date() },
    });

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'FAILED',
        failureReason: reason.slice(0, 240),
        confirmedAt: null,
      },
    });

    return { outcome: 'failed', orderId, idempotencyKey: order.idempotencyKey };
  });
}

export function newEventId(): string {
  return randomUUID();
}

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(error.code);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return true;
  return false;
}

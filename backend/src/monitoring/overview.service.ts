import { prisma } from '../db/prisma';
import { redis } from '../db/redis';
import { getInventorySnapshot } from '../inventory/inventory.service';
import { getPerformanceSummary, readEvents, readStats } from './monitor.service';
import { getRabbitMetrics, checkRabbitManagementHealthy } from './rabbit-health';
import { config } from '../config';
import { logger, safeErrorMessage } from '../lib/logger';

async function timeCheck(check: () => Promise<unknown>) {
  const started = Date.now();
  try {
    await check();
    return { status: 'ok' as const, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    return {
      status: 'down' as const,
      latencyMs: Date.now() - started,
      error: safeErrorMessage(error),
    };
  }
}

export async function getHealthReport() {
  const [postgres, redisCheck, rabbit] = await Promise.all([
    timeCheck(() => prisma.$queryRaw`SELECT 1`),
    timeCheck(() => redis.ping()),
    checkRabbitManagementHealthy(),
  ]);

  const services = [
    {
      name: 'api',
      status: 'ok' as const,
      latencyMs: 0,
      detail: `Express process up ${Math.floor(process.uptime())}s`,
      error: null,
    },
    {
      name: 'postgresql',
      status: postgres.status,
      latencyMs: postgres.latencyMs,
      detail: postgres.status === 'ok' ? 'SELECT 1 succeeded' : 'Durable ledger unreachable',
      error: postgres.error,
    },
    {
      name: 'redis',
      status: redisCheck.status,
      latencyMs: redisCheck.latencyMs,
      detail:
        redisCheck.status === 'ok'
          ? 'Admission counter reachable (PING)'
          : 'Inventory admission unavailable',
      error: redisCheck.error,
    },
    {
      name: 'rabbitmq',
      status: rabbit.ok ? ('ok' as const) : ('down' as const),
      latencyMs: rabbit.latencyMs,
      detail: rabbit.ok
        ? 'Management API healthy; durable queues declared'
        : 'Management API unavailable; queue depth cannot be reported',
      error: rabbit.error,
    },
  ];

  const overall =
    services.every((service) => service.status === 'ok')
      ? 'healthy'
      : services.some((service) => service.status === 'down')
        ? 'degraded'
        : 'healthy';

  return {
    status: overall,
    checkedAt: new Date().toISOString(),
    services,
    queues: rabbit.queues,
  };
}

export async function getMonitorOverview() {
  const [
    inventory,
    statsResult,
    recentOrders,
    orderCounts,
    outboxCounts,
    oldestPendingOutbox,
    queueMetrics,
    eventsResult,
  ] = await Promise.all([
    getInventorySnapshot().catch((error) => {
      logger.warn('Inventory snapshot failed', { error: safeErrorMessage(error) });
      return null;
    }),
    readStats(),
    prisma.order
      .findMany({
        orderBy: { createdAt: 'desc' },
        take: config.RECENT_ORDER_LIMIT,
        select: {
          id: true,
          status: true,
          quantity: true,
          totalPriceInr: true,
          createdAt: true,
          processingStartedAt: true,
          confirmedAt: true,
          failureReason: true,
          reservation: { select: { status: true, expiresAt: true } },
        },
      })
      .catch(() => []),
    prisma.order
      .groupBy({ by: ['status'], _count: { _all: true } })
      .catch(() => []),
    prisma.outboxEvent
      .groupBy({ by: ['status'], _count: { _all: true } })
      .catch(() => []),
    prisma.outboxEvent
      .findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
      .catch(() => null),
    getRabbitMetrics(),
    readEvents(25),
  ]);

  const orderCountByStatus = Object.fromEntries(
    orderCounts.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const outboxByStatus = Object.fromEntries(
    outboxCounts.map((row) => [row.status, row._count._all]),
  ) as Record<string, number>;

  const stats = statsResult.stats;
  const decided = stats.accepted + stats.soldOut;

  return {
    generatedAt: new Date().toISOString(),
    inventory,
    checkout: {
      attempts: stats.attempts,
      accepted: stats.accepted,
      soldOut: stats.soldOut,
      failed: stats.failed,
      idempotent: stats.idempotent,
      rejected: stats.rejected,
      successRatePercent:
        decided === 0 ? null : Number(((stats.accepted / decided) * 100).toFixed(2)),
      countersAvailable: statsResult.available,
      source: statsResult.available ? 'redis-counters' : 'api-process-fallback',
    },
    orders: {
      pending: orderCountByStatus.PENDING ?? 0,
      confirmed: orderCountByStatus.CONFIRMED ?? 0,
      failed: orderCountByStatus.FAILED ?? 0,
      recent: recentOrders.map((order) => ({
        id: order.id,
        status: order.status,
        quantity: order.quantity,
        totalPriceInr: order.totalPriceInr,
        createdAt: order.createdAt.toISOString(),
        processingStartedAt: order.processingStartedAt?.toISOString() ?? null,
        confirmedAt: order.confirmedAt?.toISOString() ?? null,
        failureReason: order.failureReason,
        reservationStatus: order.reservation.status,
      })),
    },
    asyncProcessing: {
      outbox: {
        pending: outboxByStatus.PENDING ?? 0,
        publishing: outboxByStatus.PUBLISHING ?? 0,
        published: outboxByStatus.PUBLISHED ?? 0,
        failed: outboxByStatus.FAILED ?? 0,
        oldestPendingAgeSeconds: oldestPendingOutbox
          ? Math.max(0, Math.floor((Date.now() - oldestPendingOutbox.createdAt.getTime()) / 1000))
          : null,
      },
      queue: queueMetrics,
      processedConfirmations: orderCountByStatus.CONFIRMED ?? 0,
      failedOrders: orderCountByStatus.FAILED ?? 0,
      events: eventsResult.events,
      eventsAvailable: eventsResult.available,
    },
    performance: getPerformanceSummary(),
  };
}

export async function getMonitorEvents(limit: number) {
  return readEvents(limit);
}

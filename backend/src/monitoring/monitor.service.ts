import { randomUUID } from 'crypto';
import { redis } from '../db/redis';
import { config, redisKeys } from '../config';
import { safeErrorMessage } from '../lib/logger';

export type MonitorEventType =
  | 'CHECKOUT_ACCEPTED'
  | 'CHECKOUT_SOLD_OUT'
  | 'CHECKOUT_IDEMPOTENT'
  | 'CHECKOUT_REJECTED'
  | 'RESERVATION_COMPENSATED'
  | 'ORPHAN_RESERVATION_RELEASED'
  | 'ORDER_CONFIRMED'
  | 'ORDER_FAILED'
  | 'ORDER_PROCESSING'
  | 'OUTBOX_PUBLISHED'
  | 'OUTBOX_RETRY'
  | 'OUTBOX_FAILED'
  | 'WORKER_ERROR'
  | 'DUPLICATE_DELIVERY'
  | 'RECOVERY_PASS'
  | 'SYSTEM_WARNING'
  | 'INVENTORY_RESET';

export interface MonitorEvent {
  id: string;
  type: MonitorEventType;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
  orderId?: string;
  data?: Record<string, string | number | boolean | null>;
}

const MAX_EVENTS = 200;
const RING_SIZE = 500;

const statKeys = {
  attempts: `${redisKeys.statsPrefix}attempts`,
  accepted: `${redisKeys.statsPrefix}accepted`,
  soldOut: `${redisKeys.statsPrefix}sold_out`,
  failed: `${redisKeys.statsPrefix}failed`,
  idempotent: `${redisKeys.statsPrefix}idempotent`,
  rejected: `${redisKeys.statsPrefix}rejected`,
} as const;

export interface CheckoutStats {
  attempts: number;
  accepted: number;
  soldOut: number;
  failed: number;
  idempotent: number;
  rejected: number;
}

const localStats: CheckoutStats = {
  attempts: 0,
  accepted: 0,
  soldOut: 0,
  failed: 0,
  idempotent: 0,
  rejected: 0,
};

const latencySamples: Array<{ at: number; ms: number; status: number }> = [];
let totalRequests = 0;
let totalErrors = 0;
let statsRedisAvailable = true;

function pushLatency(ms: number, status: number) {
  totalRequests += 1;
  if (status >= 500) totalErrors += 1;
  latencySamples.push({ at: Date.now(), ms, status });
  if (latencySamples.length > RING_SIZE) latencySamples.shift();
}

export function recordRequestLatency(ms: number, status: number): void {
  pushLatency(ms, status);
}

export async function incrementStat(
  name: 'attempts' | 'accepted' | 'soldOut' | 'failed' | 'idempotent' | 'rejected',
  amount = 1,
): Promise<void> {
  localStats[name] += amount;
  try {
    await redis.incrby(statKeys[name], amount);
    statsRedisAvailable = true;
  } catch {
    statsRedisAvailable = false;
  }
}

export async function recordEvent(
  event: Omit<MonitorEvent, 'id' | 'at'> & { at?: string },
): Promise<void> {
  const payload: MonitorEvent = {
    ...event,
    id: randomUUID(),
    at: event.at ?? new Date().toISOString(),
  };

  try {
    const multi = redis.multi();
    multi.lpush(redisKeys.events, JSON.stringify(payload));
    multi.ltrim(redisKeys.events, 0, MAX_EVENTS - 1);
    await multi.exec();
  } catch {
    // Monitoring must never break checkout or order processing.
  }
}

export async function readEvents(limit = 50): Promise<{ events: MonitorEvent[]; available: boolean }> {
  try {
    const raw = await redis.lrange(redisKeys.events, 0, Math.max(0, Math.min(limit, MAX_EVENTS) - 1));
    const events = raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as MonitorEvent;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is MonitorEvent => entry !== null);
    return { events, available: true };
  } catch {
    return { events: [], available: false };
  }
}

export async function readStats(): Promise<{ stats: CheckoutStats; available: boolean }> {
  try {
    const values = await redis.mget(
      statKeys.attempts,
      statKeys.accepted,
      statKeys.soldOut,
      statKeys.failed,
      statKeys.idempotent,
      statKeys.rejected,
    );
    const stats: CheckoutStats = {
      attempts: Number(values[0] ?? 0),
      accepted: Number(values[1] ?? 0),
      soldOut: Number(values[2] ?? 0),
      failed: Number(values[3] ?? 0),
      idempotent: Number(values[4] ?? 0),
      rejected: Number(values[5] ?? 0),
    };
    statsRedisAvailable = true;
    return { stats, available: true };
  } catch (error) {
    statsRedisAvailable = false;
    return { stats: { ...localStats }, available: false };
  }
}

export function getPerformanceSummary() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  const recent = latencySamples.filter((sample) => sample.at >= oneMinuteAgo);
  const durations = recent.map((sample) => sample.ms).sort((a, b) => a - b);
  const percentile = (p: number) =>
    durations.length === 0 ? null : durations[Math.min(durations.length - 1, Math.floor(p * durations.length))];

  const errors = latencySamples.filter((sample) => sample.status >= 500).length;
  const uptimeSeconds = process.uptime();

  return {
    source: 'api-process',
    window: 'recent 500 API requests; throughput over the last 60s',
    requestCount: totalRequests,
    errorCount: totalErrors,
    errorRatePercent:
      totalRequests === 0 ? 0 : Number(((totalErrors / totalRequests) * 100).toFixed(2)),
    requestsLastMinute: recent.length,
    throughputPerSecond: Number((recent.length / 60).toFixed(2)),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: durations.length > 0 ? durations[durations.length - 1] : null,
    uptimeSeconds: Math.floor(uptimeSeconds),
    samplerErrorCount: errors,
    statsRedisAvailable,
  };
}

export async function resetMonitoringState(): Promise<void> {
  localStats.attempts = 0;
  localStats.accepted = 0;
  localStats.soldOut = 0;
  localStats.failed = 0;
  localStats.idempotent = 0;
  localStats.rejected = 0;
  latencySamples.length = 0;
  totalRequests = 0;
  totalErrors = 0;
  try {
    await redis.del(redisKeys.events);
    await Promise.all(Object.values(statKeys).map((key) => redis.del(key)));
  } catch {
    // best effort
  }
}

export function monitorErrorMessage(error: unknown): string {
  return safeErrorMessage(error);
}

export function requestTimeoutMs(): number {
  return Math.max(500, config.OUTBOX_POLL_INTERVAL_MS);
}

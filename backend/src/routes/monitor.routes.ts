import { Router } from 'express';
import { config } from '../config';
import { getHealthReport, getMonitorEvents, getMonitorOverview } from '../monitoring/overview.service';
import { eventLimitSchema } from '../lib/validation';
import { AppError } from '../lib/errors';

export const monitorRouter = Router();

monitorRouter.get('/overview', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getMonitorOverview());
});

monitorRouter.get('/health', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await getHealthReport());
});

monitorRouter.get('/events', async (req, res) => {
  const parsed = eventLimitSchema.safeParse(req.query.limit ?? 50);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_LIMIT', 'limit must be an integer between 1 and 100');
  }
  const result = await getMonitorEvents(parsed.data);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    events: result.events,
    available: result.available,
    source: 'redis-capped-activity-log',
  });
});

monitorRouter.get('/config', (_req, res) => {
  // Safe, non-secret operational configuration for the demonstration page.
  res.json({
    initialStock: config.INITIAL_STOCK,
    reservationTtlSeconds: config.RESERVATION_TTL_SECONDS,
    workerPrefetch: config.WORKER_PREFETCH,
    queuePrefix: config.QUEUE_PREFIX,
  });
});

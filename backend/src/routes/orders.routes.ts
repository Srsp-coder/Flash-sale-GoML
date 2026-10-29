import { Router } from 'express';
import { AppError } from '../lib/errors';
import { orderIdSchema } from '../lib/validation';
import { getOrderView, isTerminalStatus } from '../services/order.service';
import { logger, safeErrorMessage } from '../lib/logger';

export const ordersRouter = Router();

ordersRouter.get('/:orderId', async (req, res) => {
  const parsed = orderIdSchema.safeParse(req.params.orderId);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_ORDER_ID', 'Order ID must be a valid UUID');
  }
  const order = await getOrderView(parsed.data);
  if (!order) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ order, terminal: isTerminalStatus(order.status) });
});

/**
 * Server-sent events for order tracking. The route sends the current snapshot
 * immediately, then only on change, and closes after a terminal state. A client
 * that reconnects simply receives the current durable snapshot again.
 */
ordersRouter.get('/:orderId/events', async (req, res) => {
  const parsed = orderIdSchema.safeParse(req.params.orderId);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_ORDER_ID', 'Order ID must be a valid UUID');
  }

  const initial = await getOrderView(parsed.data);
  if (!initial) {
    throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  let lastFingerprint = '';
  let pollTimer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const send = (order: Awaited<ReturnType<typeof getOrderView>>) => {
    if (!order || closed) return;
    const fingerprint = `${order.status}:${order.updatedAt}`;
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    res.write(`id: ${order.updatedAt}\n`);
    res.write('event: order\n');
    res.write(`data: ${JSON.stringify({ order, terminal: isTerminalStatus(order.status) })}\n\n`);
  };

  const cleanup = () => {
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeat) clearInterval(heartbeat);
  };

  req.on('close', cleanup);

  send(initial);
  if (isTerminalStatus(initial.status)) {
    res.write('event: done\ndata: {}\n\n');
    res.end();
    cleanup();
    return;
  }

  pollTimer = setInterval(async () => {
    if (closed) return;
    try {
      const order = await getOrderView(parsed.data);
      if (!order) return;
      send(order);
      if (isTerminalStatus(order.status)) {
        res.write('event: done\ndata: {}\n\n');
        res.end();
        cleanup();
      }
    } catch (error) {
      logger.warn('SSE order poll failed', {
        orderId: parsed.data,
        error: safeErrorMessage(error),
      });
    }
  }, 1000);

  heartbeat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, 15_000);
});

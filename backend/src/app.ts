import 'express-async-errors';
import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { config } from './config';
import { AppError } from './lib/errors';
import { logger, safeErrorMessage } from './lib/logger';
import { productsRouter } from './routes/products.routes';
import { checkoutRouter } from './routes/checkout.routes';
import { ordersRouter } from './routes/orders.routes';
import { monitorRouter } from './routes/monitor.routes';
import { recordRequestLatency } from './monitoring/monitor.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

function allowedOrigins(): string[] | '*' {
  const raw = config.CORS_ORIGIN.trim();
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    req.requestId = req.get('X-Request-Id') ?? randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      recordRequestLatency(elapsedMs, res.statusCode);
    });
    next();
  });

  app.use(
    cors({
      origin: allowedOrigins(),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Request-Id', 'Last-Event-ID'],
      exposedHeaders: ['X-Request-Id', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: config.REQUEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: config.REQUEST_BODY_LIMIT }));

  const skipLimiter = () => config.RATE_LIMIT_DISABLED || config.NODE_ENV === 'test';

  const globalLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipLimiter,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Retry shortly.' },
        requestId: (req as Request).requestId,
        timestamp: new Date().toISOString(),
      });
    },
  });

  const checkoutLimiter = rateLimit({
    windowMs: config.RATE_LIMIT_WINDOW_MS,
    limit: config.CHECKOUT_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipLimiter,
    handler: (req, res) => {
      res.status(429).json({
        error: { code: 'CHECKOUT_RATE_LIMITED', message: 'Checkout rate limit exceeded.' },
        requestId: (req as Request).requestId,
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.use('/api', globalLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'flashsale-api',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api', (_req, res) => {
    res.json({
      service: 'FlashSale API',
      endpoints: [
        'GET /api/health',
        'GET /api/products/flash-sale',
        'POST /api/checkout (Idempotency-Key required)',
        'GET /api/orders/:orderId',
        'GET /api/orders/:orderId/events',
        'GET /api/monitor/overview',
        'GET /api/monitor/health',
        'GET /api/monitor/events',
      ],
    });
  });

  app.use('/api/products', productsRouter);
  app.use('/api/checkout', checkoutLimiter, checkoutRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/monitor', monitorRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'API route not found' },
      timestamp: new Date().toISOString(),
    });
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    if (error instanceof AppError) {
      if (
        error.details &&
        typeof error.details === 'object' &&
        'retryAfterSeconds' in error.details
      ) {
        const seconds = Number((error.details as { retryAfterSeconds: number }).retryAfterSeconds);
        if (Number.isFinite(seconds)) res.setHeader('Retry-After', String(seconds));
      }
      res.status(error.statusCode).json({
        error: { code: error.code, message: error.message, details: error.details },
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({
        error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const maybeStatus = (error as { status?: number; type?: string })?.status;
    if (maybeStatus === 413) {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the configured limit' },
        requestId: req.requestId,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.error('Unhandled API error', {
      requestId: req.requestId,
      path: req.path,
      error: safeErrorMessage(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

export const app = createApp();

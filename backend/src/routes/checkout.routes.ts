import { Router } from 'express';
import { AppError } from '../lib/errors';
import { checkoutSchema, idempotencyKeySchema } from '../lib/validation';
import { processCheckout } from '../services/checkout.service';

export const checkoutRouter = Router();

checkoutRouter.post('/', async (req, res) => {
  const rawKey = req.get('Idempotency-Key');
  if (!rawKey) {
    throw new AppError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'An Idempotency-Key header is required for checkout',
    );
  }
  const key = idempotencyKeySchema.safeParse(rawKey);
  if (!key.success) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', key.error.issues[0]?.message ?? 'Invalid key');
  }

  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Checkout payload is invalid', {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const result = await processCheckout(parsed.data, key.data);
  res.status(202).json(result);
});

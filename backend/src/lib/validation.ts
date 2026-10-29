import { z } from 'zod';

export const checkoutSchema = z
  .object({
    productId: z.string().trim().min(1).max(100),
    customerName: z.string().trim().min(2, 'Name must be at least 2 characters').max(80),
    customerEmail: z.string().trim().email('Enter a valid email address').max(200),
    shippingAddress: z
      .string()
      .trim()
      .min(10, 'Address must be at least 10 characters')
      .max(500),
  })
  .strict();

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, 'Idempotency-Key must be 8-128 safe characters');

export const orderIdSchema = z.string().uuid('Order ID must be a UUID');

export const eventLimitSchema = z.coerce.number().int().min(1).max(100).default(50);

import { prisma } from '../db/prisma';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]}${'*'.repeat(Math.max(1, part.length - 1))}`)
    .join(' ');
}

export interface OrderView {
  id: string;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  quantity: number;
  unitPriceInr: number;
  totalPriceInr: number;
  currency: string;
  createdAt: string;
  updatedAt: string;
  processingStartedAt: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
  reservationStatus: string;
  reservationExpiresAt: string;
  customer: {
    name: string;
    email: string;
  };
  product: {
    id: string;
    sku: string;
    name: string;
    tagline: string;
    imageUrl: string;
    specs: unknown;
    priceInr: number;
  };
  timeline: Array<{
    key: string;
    label: string;
    description: string;
    at: string | null;
    state: 'complete' | 'active' | 'pending' | 'failed';
  }>;
}

export async function getOrderView(orderId: string): Promise<OrderView | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { product: true, reservation: true },
  });
  if (!order) return null;

  const terminal = order.status !== 'PENDING';
  const failed = order.status === 'FAILED';

  const timeline: OrderView['timeline'] = [
    {
      key: 'reserved',
      label: 'Reservation secured',
      description: 'One unit was admitted and durably reserved.',
      at: order.createdAt.toISOString(),
      state: 'complete',
    },
    {
      key: 'processing',
      label: 'Order processing',
      description: 'The queue worker is validating and confirming this order.',
      at: order.processingStartedAt?.toISOString() ?? null,
      state: failed ? 'failed' : terminal ? 'complete' : order.processingStartedAt ? 'active' : 'pending',
    },
    {
      key: 'final',
      label: failed ? 'Order could not be completed' : 'Order confirmed',
      description: failed
        ? order.failureReason ?? 'The reservation was released.'
        : 'Payment and inventory confirmation are complete.',
      at: order.confirmedAt?.toISOString() ?? null,
      state: failed ? 'failed' : terminal ? 'complete' : 'pending',
    },
  ];

  return {
    id: order.id,
    status: order.status,
    quantity: order.quantity,
    unitPriceInr: order.unitPriceInr,
    totalPriceInr: order.totalPriceInr,
    currency: order.product.currency ?? 'INR',
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    processingStartedAt: order.processingStartedAt?.toISOString() ?? null,
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    failureReason: order.failureReason,
    reservationStatus: order.reservation.status,
    reservationExpiresAt: order.reservation.expiresAt.toISOString(),
    customer: {
      name: maskName(order.customerName),
      email: maskEmail(order.customerEmail),
    },
    product: {
      id: order.product.id,
      sku: order.product.sku,
      name: order.product.name,
      tagline: order.product.tagline,
      imageUrl: order.product.imageUrl,
      specs: order.product.specs,
      priceInr: order.product.priceInr,
    },
    timeline,
  };
}

export function isTerminalStatus(status: string): boolean {
  return status === 'CONFIRMED' || status === 'FAILED';
}

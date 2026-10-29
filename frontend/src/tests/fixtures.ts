import type {
  EventsResponse,
  FlashSaleResponse,
  HealthReport,
  MonitorOverview,
  OrderResponse,
} from '../types';

export const product = {
  id: 'flash-sale-phone',
  sku: 'FLASH-PHONE-01',
  name: 'Aether X1 Pro 5G',
  tagline: 'The flagship drop. 500 units. One shot.',
  description: 'A limited flash-sale drop with one unit per checkout.',
  priceInr: 49999,
  originalPriceInr: 69999,
  currency: 'INR',
  imageUrl: '/phone.svg',
  specs: {
    display: '6.7-inch LTPO AMOLED',
    processor: 'Snapdragon 8 Gen 3',
    memory: '12 GB',
    storage: '256 GB',
    camera: '50 MP',
    frontCamera: '32 MP',
    battery: '5,000 mAh',
    connectivity: '5G',
    security: 'IP68',
    os: 'Android 15',
    colors: 'Obsidian Black',
    box: 'Handset and charger',
  },
};

export const flashSale: FlashSaleResponse = {
  product,
  inventory: {
    initialStock: 500,
    availableStock: 499,
    activeReservations: 0,
    confirmedOrders: 1,
    admissionStock: 499,
    admissionSource: 'redis',
    invariantHolds: true,
    generatedAt: '2026-10-28T10:00:00.000Z',
  },
  sale: {
    status: 'LIVE',
    totalUnits: 500,
    claimedUnits: 1,
    percentClaimed: 0,
    limitPerCustomer: 1,
  },
};

export const orderView: OrderResponse = {
  terminal: true,
  order: {
    id: '11111111-2222-4333-8444-555555555555',
    status: 'CONFIRMED',
    quantity: 1,
    unitPriceInr: 49999,
    totalPriceInr: 49999,
    currency: 'INR',
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:02.000Z',
    processingStartedAt: '2026-10-28T10:00:01.000Z',
    confirmedAt: '2026-10-28T10:00:02.000Z',
    failureReason: null,
    reservationStatus: 'CONFIRMED',
    reservationExpiresAt: '2026-10-28T10:10:00.000Z',
    customer: { name: 'A*** R**', email: 'a***@example.com' },
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      tagline: product.tagline,
      imageUrl: product.imageUrl,
      specs: product.specs,
      priceInr: product.priceInr,
    },
    timeline: [
      {
        key: 'reserved',
        label: 'Reservation secured',
        description: 'One unit was admitted and durably reserved.',
        at: '2026-10-28T10:00:00.000Z',
        state: 'complete',
      },
      {
        key: 'processing',
        label: 'Order processing',
        description: 'The queue worker is validating and confirming this order.',
        at: '2026-10-28T10:00:01.000Z',
        state: 'complete',
      },
      {
        key: 'final',
        label: 'Order confirmed',
        description: 'Payment and inventory confirmation are complete.',
        at: '2026-10-28T10:00:02.000Z',
        state: 'complete',
      },
    ],
  },
};

export const healthReport: HealthReport = {
  status: 'healthy',
  checkedAt: '2026-10-28T10:00:00.000Z',
  services: [
    { name: 'api', status: 'ok', latencyMs: 0, detail: 'Express process up 10s', error: null },
    { name: 'postgresql', status: 'ok', latencyMs: 4, detail: 'SELECT 1 succeeded', error: null },
    { name: 'redis', status: 'ok', latencyMs: 2, detail: 'PING succeeded', error: null },
    { name: 'rabbitmq', status: 'ok', latencyMs: 6, detail: 'Management API healthy', error: null },
  ],
  queues: ['flashsale.orders.queue'],
};

export const monitorOverview: MonitorOverview = {
  generatedAt: '2026-10-28T10:00:05.000Z',
  inventory: {
    productId: product.id,
    initialStock: 500,
    availableStock: 499,
    activeReservations: 0,
    confirmedOrders: 1,
    reservedStock: 0,
    soldStock: 1,
    admissionStock: 499,
    admissionSource: 'redis',
    drift: 0,
    invariant: {
      holds: true,
      equation: 'available + active reservations + confirmed = initial stock',
      activeReservationRows: 0,
      confirmedOrderRows: 1,
    },
    generatedAt: '2026-10-28T10:00:05.000Z',
  },
  checkout: {
    attempts: 3,
    accepted: 1,
    soldOut: 1,
    failed: 0,
    idempotent: 1,
    rejected: 0,
    successRatePercent: 50,
    countersAvailable: true,
    source: 'redis-counters',
  },
  orders: {
    pending: 0,
    confirmed: 1,
    failed: 0,
    recent: [
      {
        id: orderView.order.id,
        status: 'CONFIRMED',
        quantity: 1,
        totalPriceInr: 49999,
        createdAt: '2026-10-28T10:00:00.000Z',
        processingStartedAt: '2026-10-28T10:00:01.000Z',
        confirmedAt: '2026-10-28T10:00:02.000Z',
        failureReason: null,
        reservationStatus: 'CONFIRMED',
      },
    ],
  },
  asyncProcessing: {
    outbox: { pending: 0, publishing: 0, published: 1, failed: 0, oldestPendingAgeSeconds: null },
    queue: {
      available: true,
      source: 'management-api',
      queues: {
        main: { name: 'flashsale.orders.queue', ready: 0, unacknowledged: 0, consumers: 1 },
        retry: { name: 'flashsale.orders.retry', ready: 0, unacknowledged: 0, consumers: 0 },
        deadLetter: { name: 'flashsale.orders.dlq', ready: 0, unacknowledged: 0, consumers: 0 },
      },
      error: null,
      latencyMs: 12,
    },
    processedConfirmations: 1,
    failedOrders: 0,
    events: [
      {
        id: 'event-1',
        type: 'ORDER_CONFIRMED',
        level: 'info',
        message: 'Order confirmed; reservation moved to sold ledger',
        at: '2026-10-28T10:00:02.000Z',
        orderId: orderView.order.id,
      },
    ],
    eventsAvailable: true,
  },
  performance: {
    source: 'api-process',
    window: 'recent 500 API requests; throughput over the last 60s',
    requestCount: 10,
    errorCount: 0,
    errorRatePercent: 0,
    requestsLastMinute: 10,
    throughputPerSecond: 0.17,
    p50Ms: 12,
    p95Ms: 80,
    maxMs: 90,
    uptimeSeconds: 60,
    samplerErrorCount: 0,
    statsRedisAvailable: true,
  },
};

export const eventsResponse: EventsResponse = {
  events: monitorOverview.asyncProcessing.events,
  available: true,
  source: 'redis-capped-activity-log',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

export function apiErrorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

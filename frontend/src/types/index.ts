export type OrderStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';
export type SaleStatus = 'LIVE' | 'SOLD_OUT';

export interface ProductSpecs {
  display: string;
  processor: string;
  memory: string;
  storage: string;
  camera: string;
  frontCamera: string;
  battery: string;
  connectivity: string;
  security: string;
  os: string;
  colors: string;
  box: string;
  [key: string]: string;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  tagline: string;
  description: string;
  priceInr: number;
  originalPriceInr: number;
  currency: string;
  imageUrl: string;
  specs: ProductSpecs;
}

export interface FlashSaleInventory {
  initialStock: number;
  availableStock: number;
  activeReservations: number;
  confirmedOrders: number;
  admissionStock: number | null;
  admissionSource: 'redis' | 'durable-fallback';
  invariantHolds: boolean;
  generatedAt: string;
}

export interface FlashSaleResponse {
  product: Product;
  inventory: FlashSaleInventory;
  sale: {
    status: SaleStatus;
    totalUnits: number;
    claimedUnits: number;
    percentClaimed: number;
    limitPerCustomer: number;
  };
}

export interface CheckoutRequest {
  productId: string;
  customerName: string;
  customerEmail: string;
  shippingAddress: string;
}

export interface CheckoutResponse {
  orderId: string;
  status: OrderStatus;
  trackingUrl: string;
  acceptedAt: string;
  remainingStock: number | null;
  replayed: boolean;
  message: string;
}

export interface TimelineItem {
  key: string;
  label: string;
  description: string;
  at: string | null;
  state: 'complete' | 'active' | 'pending' | 'failed';
}

export interface OrderView {
  id: string;
  status: OrderStatus;
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
  customer: { name: string; email: string };
  product: Pick<Product, 'id' | 'sku' | 'name' | 'tagline' | 'imageUrl' | 'specs' | 'priceInr'>;
  timeline: TimelineItem[];
}

export interface OrderResponse {
  order: OrderView;
  terminal: boolean;
}

export interface MonitorEvent {
  id: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  at: string;
  orderId?: string;
  data?: Record<string, string | number | boolean | null>;
}

export interface MonitorInventory {
  productId: string;
  initialStock: number;
  availableStock: number;
  activeReservations: number;
  confirmedOrders: number;
  reservedStock: number;
  soldStock: number;
  admissionStock: number | null;
  admissionSource: 'redis' | 'durable-fallback';
  drift: number | null;
  invariant: {
    holds: boolean;
    equation: string;
    activeReservationRows: number;
    confirmedOrderRows: number;
  };
  generatedAt: string;
}

export interface QueueStat {
  name: string;
  ready: number | null;
  unacknowledged: number | null;
  consumers: number | null;
}

export interface MonitorOverview {
  generatedAt: string;
  inventory: MonitorInventory | null;
  checkout: {
    attempts: number;
    accepted: number;
    soldOut: number;
    failed: number;
    idempotent: number;
    rejected: number;
    successRatePercent: number | null;
    countersAvailable: boolean;
    source: string;
  };
  orders: {
    pending: number;
    confirmed: number;
    failed: number;
    recent: Array<{
      id: string;
      status: OrderStatus;
      quantity: number;
      totalPriceInr: number;
      createdAt: string;
      processingStartedAt: string | null;
      confirmedAt: string | null;
      failureReason: string | null;
      reservationStatus: string;
    }>;
  };
  asyncProcessing: {
    outbox: {
      pending: number;
      publishing: number;
      published: number;
      failed: number;
      oldestPendingAgeSeconds: number | null;
    };
    queue: {
      available: boolean;
      source: string;
      queues: {
        main: QueueStat | null;
        retry: QueueStat | null;
        deadLetter: QueueStat | null;
      };
      error: string | null;
      latencyMs: number | null;
    };
    processedConfirmations: number;
    failedOrders: number;
    events: MonitorEvent[];
    eventsAvailable: boolean;
  };
  performance: {
    source: string;
    window: string;
    requestCount: number;
    errorCount: number;
    errorRatePercent: number;
    requestsLastMinute: number;
    throughputPerSecond: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    uptimeSeconds: number;
    samplerErrorCount: number;
    statsRedisAvailable: boolean;
  };
}

export interface HealthService {
  name: string;
  status: 'ok' | 'down' | 'degraded';
  latencyMs: number;
  detail: string;
  error: string | null;
}

export interface HealthReport {
  status: 'healthy' | 'degraded';
  checkedAt: string;
  services: HealthService[];
  queues: string[];
}

export interface EventsResponse {
  events: MonitorEvent[];
  available: boolean;
  source: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
  timestamp?: string;
}

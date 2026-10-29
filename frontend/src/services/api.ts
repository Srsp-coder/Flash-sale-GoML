import type {
  ApiErrorBody,
  CheckoutRequest,
  CheckoutResponse,
  EventsResponse,
  FlashSaleResponse,
  HealthReport,
  MonitorOverview,
  OrderResponse,
} from '../types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export const API_PREFIX = `${API_BASE}/api`;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Could not reach the FlashSale API. Check that the backend is running.',
    );
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'REQUEST_FAILED',
      body?.error?.message ?? `Request failed with HTTP ${response.status}`,
      body?.error?.details,
      body?.requestId,
    );
  }

  return payload as T;
}

export function fetchFlashSale(signal?: AbortSignal): Promise<FlashSaleResponse> {
  return request<FlashSaleResponse>('/products/flash-sale', { signal });
}

export function createCheckout(
  payload: CheckoutRequest,
  idempotencyKey: string,
): Promise<CheckoutResponse> {
  return request<CheckoutResponse>('/checkout', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

export function fetchOrder(orderId: string, signal?: AbortSignal): Promise<OrderResponse> {
  return request<OrderResponse>(`/orders/${encodeURIComponent(orderId)}`, { signal });
}

export function fetchMonitorOverview(signal?: AbortSignal): Promise<MonitorOverview> {
  return request<MonitorOverview>('/monitor/overview', { signal });
}

export function fetchMonitorHealth(signal?: AbortSignal): Promise<HealthReport> {
  return request<HealthReport>('/monitor/health', { signal });
}

export function fetchMonitorEvents(limit = 30, signal?: AbortSignal): Promise<EventsResponse> {
  return request<EventsResponse>(`/monitor/events?limit=${limit}`, { signal });
}

export function orderEventsUrl(orderId: string): string {
  return `${API_PREFIX}/orders/${encodeURIComponent(orderId)}/events`;
}

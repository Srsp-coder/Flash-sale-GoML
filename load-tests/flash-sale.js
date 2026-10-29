import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3000';
const TOTAL_ITERATIONS = Number(__ENV.ITERATIONS || 1200);
const VUS = Number(__ENV.VUS || 200);

const accepted = new Counter('flashsale_accepted');
const soldOut = new Counter('flashsale_sold_out');
const unexpected = new Counter('flashsale_unexpected');
const checkoutLatency = new Trend('flashsale_checkout_latency', true);

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: TOTAL_ITERATIONS,
      maxDuration: '3m',
    },
  },
  thresholds: {
    // Every response must be either 202 or an explicit 409 SOLD_OUT.
    checks: ['rate>0.99'],
    flashsale_unexpected: ['count==0'],
    flashsale_accepted: ['count==500'],
    flashsale_sold_out: ['count==700'],
    http_req_duration: ['p(95)<15000'],
  },
};

export default function () {
  const key = `k6-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = JSON.stringify({
    productId: 'flash-sale-phone',
    customerName: `k6 VU ${__VU}`,
    customerEmail: `k6-${__VU}-${__ITER}@example.com`,
    shippingAddress: `Load test VU ${__VU}, 100 Feet Road, Bengaluru 560038`,
  });

  const response = http.post(`${BASE_URL}/api/checkout`, payload, {
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    tags: { name: 'checkout' },
  });

  checkoutLatency.add(response.timings.duration);

  let body = {};
  try {
    body = response.json();
  } catch {
    body = {};
  }

  if (response.status === 202) {
    accepted.add(1);
    check(response, {
      'accepted has order id': (r) => Boolean(r.json('orderId')),
      'accepted is not a replay': (r) => r.json('replayed') === false,
    });
    return;
  }

  if (response.status === 409 && body?.error?.code === 'SOLD_OUT') {
    soldOut.add(1);
    check(response, {
      'sold out error code': () => true,
    });
    return;
  }

  unexpected.add(1);
  check(response, {
    'unexpected response is reported': () => false,
  });
}

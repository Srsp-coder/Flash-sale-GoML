/**
 * Mandatory concurrency proof for the FlashSale checkout.
 *
 * Resets the isolated test ledger to 500 units, fires 1,000 concurrent
 * checkouts with unique Idempotency-Keys at a real HTTP server, then runs the
 * real outbox publisher and RabbitMQ worker until every accepted order reaches
 * a terminal state. It asserts the durable ledger, not just HTTP responses.
 *
 * Requires PostgreSQL, Redis and RabbitMQ from docker-compose (or the local
 * development containers). It never touches the development database: the
 * environment is forced to `flashsale_test`, Redis DB 15, queue prefix
 * `flashsale_test`.
 *
 *   npm run test:concurrency
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { configureTestEnv, TEST_ENV } from '../helpers/test-env';

const REQUESTS = Number(process.env.CONCURRENCY_REQUESTS ?? 1_000);
const UNITS = Number(process.env.CONCURRENCY_UNITS ?? 500);
const REPLAY_SAMPLE = Number(process.env.CONCURRENCY_REPLAYS ?? 50);

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  ms: number;
  key: string;
  payload: Record<string, string>;
}

function postCheckout(
  port: number,
  agent: http.Agent,
  key: string,
  payload: Record<string, string>,
): Promise<Omit<HttpResult, 'key' | 'payload'>> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/checkout',
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Idempotency-Key': key,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            parsed = { raw: text };
          }
          resolve({
            status: response.statusCode ?? 0,
            body: parsed,
            ms: performance.now() - started,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function purgeTestQueues(): Promise<void> {
  const amqp = (await import('amqplib')).default;
  const { assertTopology } = await import('../../src/queue/rabbitmq');
  const { queueNames } = await import('../../src/config');
  const connection = await amqp.connect(TEST_ENV.RABBITMQ_URL);
  try {
    const channel = await connection.createChannel();
    // Assert with the exact durable arguments so pre-existing test queues match.
    await assertTopology(channel as never);
    for (const queue of [queueNames.queue, queueNames.retryQueue, queueNames.deadLetterQueue]) {
      await channel.purgeQueue(queue);
    }
    await channel.close();
  } finally {
    await connection.close();
  }
}

async function main(): Promise<void> {
  configureTestEnv();

  const { migrateTestDatabase, resetTestState } = await import('../helpers/database');
  const { prisma } = await import('../../src/db/prisma');
  const { redis } = await import('../../src/db/redis');
  const { redisKeys } = await import('../../src/config');
  const { app } = await import('../../src/app');
  const { OutboxPublisher } = await import('../../src/services/outbox.publisher');
  const { OrderWorker } = await import('../../src/workers/order.worker');
  const { getInventorySnapshot } = await import('../../src/inventory/inventory.service');
  const { closeRabbit, getQueueDepths } = await import('../../src/queue/rabbitmq');

  let server: Server | null = null;
  let worker: InstanceType<typeof OrderWorker> | null = null;

  try {
    console.log('==> preparing isolated test database and 500-unit sale');
    await migrateTestDatabase();
    await resetTestState(UNITS);
    await purgeTestQueues();

    server = app.listen({ port: 0, host: '127.0.0.1', backlog: 4096 });
    await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`==> API listening on ${baseUrl}`);

    const requests = Array.from({ length: REQUESTS }, (_, index) => {
      const key = `concurrency-${String(index).padStart(5, '0')}`;
      return {
        key,
        payload: {
          productId: 'flash-sale-phone',
          customerName: `Load Tester ${index}`,
          customerEmail: `load${index}@example.com`,
          shippingAddress: `Unit ${index}, 100 Feet Road, Bengaluru 560038`,
        },
      };
    });

    console.log(`==> firing ${REQUESTS} concurrent checkouts with unique keys`);
    // A bounded keep-alive pool avoids Windows ephemeral-port/SYN backlog limits
    // while still putting all 1,000 checkouts in flight at once. The agent queues
    // excess requests; each checkout request is already dispatched concurrently.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
    const startedAt = performance.now();
    const results: HttpResult[] = await Promise.all(
      requests.map(async ({ key, payload }) => {
        try {
          const result = await postCheckout(port, agent, key, payload);
          return { ...result, key, payload };
        } catch (error) {
          const cause = (error as { code?: string; message?: string });
          throw new Error(
            `checkout request ${key} failed at the network layer: ${cause.code ?? ''} ${cause.message ?? String(error)}`,
          );
        }
      }),
    );
    const checkoutWallMs = performance.now() - startedAt;
    agent.destroy();

    const accepted = results.filter((result) => result.status === 202);
    const soldOut = results.filter((result) => result.status === 409);
    const other = results.filter((result) => result.status !== 202 && result.status !== 409);

    assert(other.length === 0, `unexpected HTTP statuses: ${JSON.stringify(other.slice(0, 5).map((r) => ({ status: r.status, body: r.body })))}`);
    assert(
      accepted.length === UNITS,
      `expected exactly ${UNITS} accepted responses, got ${accepted.length}`,
    );
    assert(
      soldOut.length === REQUESTS - UNITS,
      `expected ${REQUESTS - UNITS} sold-out responses, got ${soldOut.length}`,
    );
    assert(
      soldOut.every(
        (result) =>
          (result.body.error as { code?: string } | undefined)?.code === 'SOLD_OUT',
      ),
      'every rejected request must carry the SOLD_OUT error code',
    );

    const acceptedOrderIds = accepted.map((result) => String(result.body.orderId));
    assert(new Set(acceptedOrderIds).size === UNITS, 'accepted responses must be unique orders');
    const acceptedKeys = new Set(accepted.map((result) => result.key));
    assert(acceptedKeys.size === UNITS, 'each accepted order must own a unique Idempotency-Key');

    const [orderCount, reservationCount, outboxCount, product] = await Promise.all([
      prisma.order.count(),
      prisma.reservation.count(),
      prisma.outboxEvent.count(),
      prisma.product.findFirstOrThrow({ where: { sku: 'FLASH-PHONE-01' } }),
    ]);
    assert(orderCount === UNITS, `expected ${UNITS} durable orders, got ${orderCount}`);
    assert(reservationCount === UNITS, `expected ${UNITS} reservations, got ${reservationCount}`);
    assert(outboxCount === UNITS, `expected ${UNITS} outbox events, got ${outboxCount}`);
    assert(product.reservedStock === UNITS, `expected ${UNITS} reserved, got ${product.reservedStock}`);
    assert(product.soldStock === 0, `expected 0 sold before processing, got ${product.soldStock}`);
    assert(
      product.initialStock === UNITS,
      `expected initial stock ${UNITS}, got ${product.initialStock}`,
    );
    assert((await redis.get(redisKeys.stock)) === '0', 'Redis admission counter must reach 0');

    console.log('==> checking concurrent idempotent replays');
    const replaySample = accepted.slice(0, REPLAY_SAMPLE);
    const replayStartedAt = performance.now();
    const replays = await Promise.all(
      replaySample.map(async (original) => {
        const response = await fetch(`${baseUrl}/api/checkout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': original.key,
          },
          body: JSON.stringify(original.payload),
        });
        const body = (await response.json()) as Record<string, unknown>;
        return { status: response.status, body, originalOrderId: original.body.orderId };
      }),
    );
    const replayWallMs = performance.now() - replayStartedAt;

    assert(
      replays.every((replay) => replay.status === 202 && replay.body.replayed === true),
      'every replay must return 202 with replayed=true',
    );
    assert(
      replays.every((replay) => replay.body.orderId === replay.originalOrderId),
      'replays must return the original order id',
    );
    assert((await prisma.order.count()) === UNITS, 'replays must not create new orders');
    assert((await prisma.reservation.count()) === UNITS, 'replays must not create reservations');
    assert(
      (await prisma.product.findFirstOrThrow({ where: { sku: 'FLASH-PHONE-01' } }))
        .reservedStock === UNITS,
      'replays must not decrement the reserved ledger',
    );
    assert((await redis.get(redisKeys.stock)) === '0', 'replays must not decrement admission stock');

    console.log('==> publishing the transactional outbox through RabbitMQ');
    const publisher = new OutboxPublisher(undefined, 1_000, 100);
    const outboxDeadline = Date.now() + 60_000;
    let pendingOutbox = await prisma.outboxEvent.count({
      where: { status: { in: ['PENDING', 'PUBLISHING'] } },
    });
    while (pendingOutbox > 0) {
      if (Date.now() > outboxDeadline) {
        throw new Error(`outbox did not drain: ${pendingOutbox} pending`);
      }
      const tick = await publisher.tick();
      if (tick.published === 0 && tick.failed > 0) {
        throw new Error('outbox publish failed');
      }
      pendingOutbox = await prisma.outboxEvent.count({
        where: { status: { in: ['PENDING', 'PUBLISHING'] } },
      });
      if (pendingOutbox > 0) await sleep(50);
    }
    await publisher.stop();

    const outboxByStatus = await prisma.outboxEvent.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const outboxStatuses = Object.fromEntries(
      outboxByStatus.map((row) => [row.status, row._count._all]),
    );
    assert(outboxStatuses.PUBLISHED === UNITS, 'all outbox events must be published');
    assert((outboxStatuses.FAILED ?? 0) === 0, 'no outbox event may be exhausted');

    console.log('==> starting the real RabbitMQ worker');
    worker = new OrderWorker(0, 6);
    await worker.start();

    const terminalDeadline = Date.now() + 120_000;
    let confirmed = 0;
    let failed = 0;
    do {
      await sleep(250);
      [confirmed, failed] = await Promise.all([
        prisma.order.count({ where: { status: 'CONFIRMED' } }),
        prisma.order.count({ where: { status: 'FAILED' } }),
      ]);
      if (Date.now() > terminalDeadline) {
        throw new Error(`orders did not reach terminal state: confirmed=${confirmed} failed=${failed}`);
      }
    } while (confirmed < UNITS && failed === 0);

    await worker.stop();
    worker = null;

    const terminalOrders = await prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const terminalStatuses = Object.fromEntries(
      terminalOrders.map((row) => [row.status, row._count._all]),
    );
    assert(terminalStatuses.CONFIRMED === UNITS, `expected ${UNITS} confirmed orders`);
    assert((terminalStatuses.FAILED ?? 0) === 0, 'no order may fail');
    assert((terminalStatuses.PENDING ?? 0) === 0, 'no order may remain pending');

    const finalProduct = await prisma.product.findFirstOrThrow({ where: { sku: 'FLASH-PHONE-01' } });
    assert(finalProduct.reservedStock === 0, 'reserved ledger must return to 0');
    assert(finalProduct.soldStock === UNITS, `expected ${UNITS} sold, got ${finalProduct.soldStock}`);
    assert(
      finalProduct.initialStock - finalProduct.reservedStock - finalProduct.soldStock === 0,
      'available + reserved + sold must equal initial stock',
    );
    assert((await redis.get(redisKeys.stock)) === '0', 'Redis admission counter must stay 0');

    const activeReservations = await prisma.reservation.count({ where: { status: 'ACTIVE' } });
    const confirmedReservations = await prisma.reservation.count({ where: { status: 'CONFIRMED' } });
    assert(activeReservations === 0, 'no reservation may remain active');
    assert(confirmedReservations === UNITS, 'every reservation must be confirmed');

    const inventory = await getInventorySnapshot();
    assert(inventory, 'inventory snapshot must exist');
    assert(inventory.invariant.holds, 'zero-overselling invariant must hold');
    assert(inventory.availableStock === 0, 'available stock must be 0');
    assert(inventory.confirmedOrders === UNITS, 'snapshot must show 500 confirmed');

    const depths = await getQueueDepths();
    assert(depths.queue?.ready === 0, `main queue must be empty, got ${depths.queue?.ready}`);
    assert(depths.retry?.ready === 0, `retry queue must be empty, got ${depths.retry?.ready}`);
    assert(
      depths.deadLetter?.ready === 0,
      `dead-letter queue must be empty, got ${depths.deadLetter?.ready}`,
    );

    const overviewResponse = await fetch(`${baseUrl}/api/monitor/overview`);
    const overview = (await overviewResponse.json()) as {
      inventory: { invariant: { holds: boolean } };
      checkout: { accepted: number; soldOut: number; idempotent: number };
      orders: { confirmed: number; failed: number; pending: number };
    };
    assert(overview.inventory.invariant.holds, 'monitor invariant must hold');
    assert(overview.orders.confirmed === UNITS, 'monitor must report 500 confirmed orders');
    assert(overview.orders.failed === 0, 'monitor must report 0 failed orders');
    assert(overview.orders.pending === 0, 'monitor must report 0 pending orders');
    assert(overview.checkout.accepted === UNITS, 'monitor accepted counter must be 500');
    assert(overview.checkout.soldOut === REQUESTS - UNITS, 'monitor sold-out counter must be 500');

    const latencies = results.map((result) => result.ms);
    const report = {
      requests: REQUESTS,
      units: UNITS,
      accepted: accepted.length,
      soldOut: soldOut.length,
      otherStatuses: other.length,
      checkoutWallMs: Number(checkoutWallMs.toFixed(1)),
      throughputPerSecond: Number((REQUESTS / (checkoutWallMs / 1000)).toFixed(1)),
      latencyMs: {
        p50: Number(percentile(latencies, 0.5).toFixed(1)),
        p95: Number(percentile(latencies, 0.95).toFixed(1)),
        p99: Number(percentile(latencies, 0.99).toFixed(1)),
        max: Number(Math.max(...latencies).toFixed(1)),
      },
      idempotentReplays: { requests: REPLAY_SAMPLE, wallMs: Number(replayWallMs.toFixed(1)) },
      ledger: {
        initialStock: finalProduct.initialStock,
        availableStock: inventory.availableStock,
        activeReservations: inventory.activeReservations,
        confirmedOrders: inventory.confirmedOrders,
        invariantHolds: inventory.invariant.holds,
      },
      orders: terminalStatuses,
      reservations: { active: activeReservations, confirmed: confirmedReservations },
      outbox: outboxStatuses,
      queues: depths,
    };

    console.log('\n=== RESULT: PASS ===');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await worker?.stop().catch(() => undefined);
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    await closeRabbit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

main().catch((error) => {
  console.error('\n=== RESULT: FAIL ===');
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});

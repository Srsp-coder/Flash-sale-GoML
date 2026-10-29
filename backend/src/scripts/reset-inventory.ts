import 'dotenv/config';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { closeRedis } from '../db/redis';
import { resetRedisInventory } from '../inventory/redis-reservation';
import { recordEvent, resetMonitoringState } from '../monitoring/monitor.service';
import { FLASH_SALE_SKU } from '../config';

/**
 * Development-only destructive reset. It refuses to run in production and
 * refuses while any order or outbox event is still processing.
 */
async function main() {
  if (config.NODE_ENV === 'production') {
    throw new Error('Refusing to reset inventory in production');
  }

  const confirmed = process.argv.includes('--yes') || process.env.FORCE_RESET === 'true';
  if (!confirmed) {
    console.error(
      'Refusing to delete order data without confirmation.\n' +
        'Run: npm run reset:inventory:force\n' +
        '(or set FORCE_RESET=true, or pass --yes directly to tsx)',
    );
    process.exit(2);
  }

  const [pendingOrders, pendingOutbox, activeReservations, product] = await Promise.all([
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.outboxEvent.count({ where: { status: { in: ['PENDING', 'PUBLISHING'] } } }),
    prisma.reservation.count({ where: { status: 'ACTIVE' } }),
    prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } }),
  ]);

  if (pendingOrders > 0 || pendingOutbox > 0 || activeReservations > 0) {
    throw new Error(
      `Refusing reset: ${pendingOrders} pending order(s), ${pendingOutbox} pending outbox event(s), ` +
        `${activeReservations} active reservation(s). Wait for processing to finish.`,
    );
  }

  if (!product) {
    throw new Error('Flash-sale product does not exist. Run the seed command first.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.outboxEvent.deleteMany();
    await tx.order.deleteMany();
    await tx.reservation.deleteMany();
    await tx.product.update({
      where: { id: product.id },
      data: {
        initialStock: config.INITIAL_STOCK,
        reservedStock: 0,
        soldStock: 0,
      },
    });
  });

  await resetRedisInventory(config.INITIAL_STOCK);
  await resetMonitoringState();
  await recordEvent({
    type: 'INVENTORY_RESET',
    level: 'warn',
    message: 'Development reset restored the flash-sale inventory',
    data: {
      initialStock: config.INITIAL_STOCK,
      productId: product.id,
      environment: config.NODE_ENV,
    },
  });

  console.log(
    `Reset complete: ${config.INITIAL_STOCK} available units, order/reservation/outbox tables cleared, ` +
      'Redis admission counter and monitor counters reseeded.',
  );
}

main()
  .catch((error) => {
    console.error(`Reset failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await closeRedis();
  });

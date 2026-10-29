import { app } from './app';
import { config } from './config';
import { prisma, disconnectPrisma } from './db/prisma';
import { closeRedis } from './db/redis';
import { closeRabbit } from './queue/rabbitmq';
import { ensureFlashSaleProduct, initializeAdmissionCounter } from './inventory/inventory.service';
import { logger, safeErrorMessage } from './lib/logger';

async function main() {
  const product = await ensureFlashSaleProduct();
  await initializeAdmissionCounter();

  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info('FlashSale API listening', {
      host: config.HOST,
      port: config.PORT,
      env: config.NODE_ENV,
      product: product.name,
      initialStock: product.initialStock,
    });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down API', { signal });
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRedis();
    await closeRabbit();
    await disconnectPrisma();
    clearTimeout(force);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error) => {
  logger.error('API failed to start', { error: safeErrorMessage(error) });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

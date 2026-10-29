import { config } from './config';
import { prisma, disconnectPrisma } from './db/prisma';
import { closeRedis } from './db/redis';
import { closeRabbit } from './queue/rabbitmq';
import { OrderWorker } from './workers/order.worker';
import { RecoveryService } from './workers/recovery.service';
import { initializeAdmissionCounter } from './inventory/inventory.service';
import { logger, safeErrorMessage } from './lib/logger';

async function main() {
  await initializeAdmissionCounter();
  const worker = new OrderWorker();
  const recovery = new RecoveryService();
  await recovery.start();
  await worker.start();
  logger.info('Worker process ready', { queuePrefix: config.QUEUE_PREFIX });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down worker', { signal });
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await worker.stop();
    await recovery.stop();
    await closeRabbit();
    await closeRedis();
    await disconnectPrisma();
    clearTimeout(force);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error) => {
  logger.error('Worker failed to start', { error: safeErrorMessage(error) });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

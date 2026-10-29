import { prisma, disconnectPrisma } from './db/prisma';
import { closeRedis } from './db/redis';
import { closeRabbit } from './queue/rabbitmq';
import { OutboxPublisher } from './services/outbox.publisher';
import { logger, safeErrorMessage } from './lib/logger';

async function main() {
  const publisher = new OutboxPublisher();
  await publisher.start();
  logger.info('Outbox publisher process ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down outbox publisher', { signal });
    await publisher.stop();
    await closeRabbit();
    await closeRedis();
    await disconnectPrisma();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error) => {
  logger.error('Outbox publisher failed to start', { error: safeErrorMessage(error) });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});

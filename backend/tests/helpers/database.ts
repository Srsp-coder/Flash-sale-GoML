import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';
import { configureTestEnv, TEST_ENV } from './test-env';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

function parsedDatabaseUrl(): URL {
  return new URL(TEST_ENV.DATABASE_URL);
}

async function ensureDatabaseExists(): Promise<void> {
  const url = parsedDatabaseUrl();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!databaseName) throw new Error('Test DATABASE_URL does not include a database name');

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (existing.rowCount === 0) {
      const quoted = `"${databaseName.replace(/"/g, '""')}"`;
      await client.query(`CREATE DATABASE ${quoted}`);
      console.log(`[test-db] created database ${databaseName}`);
    }
  } finally {
    await client.end();
  }
}

function runMigrations(): void {
  execSync('npx prisma migrate deploy', {
    cwd: BACKEND_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL },
    stdio: 'pipe',
    shell: true,
  });
}

/** Reset the durable ledger and the isolated Redis namespace to a 500-unit sale. */
export async function resetTestState(stock = 500): Promise<void> {
  const { prisma } = await import('../../src/db/prisma');
  const { ensureFlashSaleProduct } = await import('../../src/inventory/inventory.service');
  const { resetRedisInventory } = await import('../../src/inventory/redis-reservation');
  const { resetMonitoringState } = await import('../../src/monitoring/monitor.service');

  const product = await ensureFlashSaleProduct();

  await prisma.$transaction(async (tx) => {
    await tx.outboxEvent.deleteMany();
    await tx.order.deleteMany();
    await tx.reservation.deleteMany();
    await tx.product.update({
      where: { id: product.id },
      data: { initialStock: stock, reservedStock: 0, soldStock: 0 },
    });
  });

  await resetRedisInventory(stock);
  await resetMonitoringState();
}

export async function closeTestConnections(): Promise<void> {
  const { prisma } = await import('../../src/db/prisma');
  const { closeRedis } = await import('../../src/db/redis');
  await prisma.$disconnect();
  await closeRedis();
}

export async function migrateTestDatabase(): Promise<void> {
  configureTestEnv();
  await ensureDatabaseExists();
  runMigrations();
}

export async function prepareTestDatabase(): Promise<void> {
  await migrateTestDatabase();
  await resetTestState();
  await closeTestConnections();
}

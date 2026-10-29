import { prisma } from '../db/prisma';
import { FLASH_SALE_PRODUCT_ID, FLASH_SALE_SKU, config } from '../config';
import { getAdmissionStock, seedStockIfMissing } from './redis-reservation';
import { logger } from '../lib/logger';

export const DEFAULT_SPECS = {
  display: '6.7-inch LTPO AMOLED, 1–120 Hz, 2400 nits peak',
  processor: 'Snapdragon 8 Gen 3, 4 nm octa-core',
  memory: '12 GB LPDDR5X',
  storage: '256 GB UFS 4.0',
  camera: '50 MP OIS main + 12 MP ultrawide + 10 MP 3× telephoto',
  frontCamera: '32 MP autofocus',
  battery: '5,000 mAh, 80 W wired, 50 W wireless',
  connectivity: '5G, Wi-Fi 7, Bluetooth 5.4, NFC, USB-C',
  security: 'Ultrasonic in-display fingerprint, IP68',
  os: 'Android 15 with 5 years of OS updates',
  colors: 'Obsidian Black, Solar Titanium',
  box: 'Handset, 80 W charger, USB-C cable, protective case',
};

export async function ensureFlashSaleProduct() {
  const existing = await prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
  if (existing) return existing;

  return prisma.product.create({
    data: {
      id: FLASH_SALE_PRODUCT_ID,
      sku: FLASH_SALE_SKU,
      name: 'Aether X1 Pro 5G',
      tagline: 'The flagship drop. 500 units. One shot.',
      description:
        'A titanium-framed flagship with a 120 Hz LTPO display, a 50 MP OIS camera system and ' +
        '80 W fast charging. Built for people who move first. This is a limited flash-sale drop: ' +
        'one unit per checkout, 500 units in total.',
      priceInr: 49_999,
      originalPriceInr: 69_999,
      currency: 'INR',
      imageUrl: '/phone.svg',
      specs: DEFAULT_SPECS,
      initialStock: config.INITIAL_STOCK,
      reservedStock: 0,
      soldStock: 0,
    },
  });
}

export async function getFlashSaleProduct() {
  return prisma.product.findUnique({ where: { sku: FLASH_SALE_SKU } });
}

export interface InventorySnapshot {
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

/**
 * Durable accounting:
 *   available + active reservations + confirmed units = initial stock
 *
 * The product counters are the ledger. Row counts are checked independently so
 * a drifting counter is visible rather than silently trusted.
 */
export async function getInventorySnapshot(): Promise<InventorySnapshot | null> {
  const product = await getFlashSaleProduct();
  if (!product) return null;

  const [activeReservationRows, confirmedOrderRows, admissionStock] = await Promise.all([
    prisma.reservation.count({ where: { productId: product.id, status: 'ACTIVE' } }),
    prisma.order.count({ where: { productId: product.id, status: 'CONFIRMED' } }),
    getAdmissionStock().catch(() => -1),
  ]);

  const activeReservations = product.reservedStock;
  const confirmedOrders = product.soldStock;
  const availableStock = Math.max(0, product.initialStock - activeReservations - confirmedOrders);
  const redisValue = admissionStock < 0 ? null : admissionStock;

  return {
    productId: product.id,
    initialStock: product.initialStock,
    availableStock,
    activeReservations,
    confirmedOrders,
    reservedStock: product.reservedStock,
    soldStock: product.soldStock,
    admissionStock: redisValue,
    admissionSource: redisValue === null ? 'durable-fallback' : 'redis',
    drift: redisValue === null ? null : redisValue - availableStock,
    invariant: {
      holds:
        availableStock + activeReservations + confirmedOrders === product.initialStock &&
        activeReservationRows === activeReservations &&
        confirmedOrderRows === confirmedOrders,
      equation: 'available + active reservations + confirmed = initial stock',
      activeReservationRows,
      confirmedOrderRows,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function initializeAdmissionCounter(): Promise<void> {
  const product = await getFlashSaleProduct();
  if (!product) {
    logger.warn('Flash-sale product missing; run the seed command before accepting checkouts');
    return;
  }

  const durableAvailable = Math.max(
    0,
    product.initialStock - product.reservedStock - product.soldStock,
  );
  const result = await seedStockIfMissing(durableAvailable);
  logger.info(result.seeded ? 'Seeded Redis admission counter' : 'Redis admission counter present', {
    stock: result.stock,
    durableAvailable,
  });
}

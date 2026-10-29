/* Seed creates the flash-sale product only if it does not already exist.
   It never resets stock, so restarting the application is safe. */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SPECS = {
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

async function main() {
  const existing = await prisma.product.findUnique({ where: { sku: 'FLASH-PHONE-01' } });
  if (existing) {
    console.log(
      `Flash-sale product already exists (${existing.name}); stock left untouched ` +
        `(initial=${existing.initialStock}, reserved=${existing.reservedStock}, sold=${existing.soldStock}).`,
    );
    return;
  }

  const initialStock = Number(process.env.INITIAL_STOCK || 500);
  const product = await prisma.product.create({
    data: {
      id: 'flash-sale-phone',
      sku: 'FLASH-PHONE-01',
      name: 'Aether X1 Pro 5G',
      tagline: 'The flagship drop. 500 units. One shot.',
      description:
        'A titanium-framed flagship with a 120 Hz LTPO display, a 50 MP OIS camera system and 80 W fast charging. Built for people who move first. This is a limited flash-sale drop: one unit per checkout, 500 units in total.',
      priceInr: 49999,
      originalPriceInr: 69999,
      currency: 'INR',
      imageUrl: '/phone.svg',
      specs: SPECS,
      initialStock,
    },
  });
  console.log(`Seeded ${product.name} with ${product.initialStock} units.`);
}

main()
  .catch((error) => {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

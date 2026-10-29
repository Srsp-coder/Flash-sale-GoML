import { Router } from 'express';
import { getFlashSaleProduct, getInventorySnapshot } from '../inventory/inventory.service';
import { AppError } from '../lib/errors';

export const productsRouter = Router();

function publicProduct(product: NonNullable<Awaited<ReturnType<typeof getFlashSaleProduct>>>) {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    tagline: product.tagline,
    description: product.description,
    priceInr: product.priceInr,
    originalPriceInr: product.originalPriceInr,
    currency: product.currency,
    imageUrl: product.imageUrl,
    specs: product.specs,
  };
}

productsRouter.get('/flash-sale', async (_req, res) => {
  const product = await getFlashSaleProduct();
  if (!product) {
    throw new AppError(503, 'PRODUCT_NOT_READY', 'Flash sale is not configured yet');
  }

  const inventory = await getInventorySnapshot();
  if (!inventory) {
    throw new AppError(503, 'INVENTORY_UNAVAILABLE', 'Inventory state is unavailable');
  }

  const claimed = inventory.initialStock - inventory.availableStock;
  res.setHeader('Cache-Control', 'no-store');

  res.json({
    product: publicProduct(product),
    inventory: {
      initialStock: inventory.initialStock,
      availableStock: inventory.availableStock,
      activeReservations: inventory.activeReservations,
      confirmedOrders: inventory.confirmedOrders,
      admissionStock: inventory.admissionStock,
      admissionSource: inventory.admissionSource,
      invariantHolds: inventory.invariant.holds,
      generatedAt: inventory.generatedAt,
    },
    sale: {
      status: inventory.availableStock > 0 ? 'LIVE' : 'SOLD_OUT',
      totalUnits: inventory.initialStock,
      claimedUnits: claimed,
      percentClaimed:
        inventory.initialStock === 0
          ? 100
          : Math.min(100, Math.round((claimed / inventory.initialStock) * 100)),
      limitPerCustomer: 1,
    },
  });
});

import { db } from "../store/index.js";
import type { OrderState } from "../graph/state.js";

/**
 * Inventory Agent: checks stock for every line item and reserves it
 * atomically. If any SKU is short, the whole order is marked backordered
 * for those SKUs and routed straight to the Support Agent instead of
 * Payment.
 */
export async function inventoryAgent(state: OrderState): Promise<Partial<OrderState>> {
  const backorderedSkus: string[] = [];
  const autoProvisioned: string[] = [];

  // Each line item's reservation attempt is independent (a different SKU
  // row), so there's no need to pay a full network round-trip per item, one
  // at a time — running them concurrently cuts total latency from O(n)
  // sequential round-trips to roughly one, for an order with n line items.
  // The stock check and decrement for each SKU happen as a single atomic
  // database operation (db.reserveInventory — see store/types.ts and
  // supabase/migrations/0007_atomic_inventory_reservation.sql), so two
  // concurrent orders racing for the same SKU can never both succeed and
  // oversell it, unlike a plain read-then-write.
  const checkedItems = await Promise.all(
    state.items.map(async (item) => {
      const existing = await db.getInventoryQuantity(item.sku);

      if (existing === null) {
        // Unknown SKU — most likely a line item sourced from an uploaded PO
        // that isn't yet in our catalog. Auto-provision it with exactly the
        // requested quantity so the order can proceed, rather than blindly
        // backordering every externally-sourced item.
        await db.ensureInventoryItem(item.sku, item.name ?? item.sku, item.quantity, item.unitPrice);
        autoProvisioned.push(item.sku);
      }

      const reserved = await db.reserveInventory(item.sku, item.quantity);
      return { sku: item.sku, quantity: item.quantity, reserved };
    })
  );

  for (const { sku, reserved } of checkedItems) {
    if (!reserved) backorderedSkus.push(sku);
  }

  const inventoryOk = backorderedSkus.length === 0;

  // If any SKU came up short, roll back every *other* SKU in this order
  // that *did* reserve successfully, so a shortfall never leaves them
  // silently held while the order as a whole is backordered. That, in
  // turn, is what makes it safe to retry a backordered order later (e.g.
  // after restocking): re-running this agent against the full item list
  // won't double-reserve items that "succeeded" on an earlier,
  // ultimately-failed attempt.
  if (!inventoryOk) {
    await Promise.all(
      checkedItems.filter((item) => item.reserved).map(({ sku, quantity }) => db.releaseInventory(sku, quantity))
    );
  }

  await db.updateOrder(state.orderId, { status: inventoryOk ? "inventory_checked" : "backordered" });

  const detailParts = [
    inventoryOk ? "All line items reserved from stock." : `Insufficient stock for: ${backorderedSkus.join(", ")}`,
  ];
  if (autoProvisioned.length > 0) {
    detailParts.push(`Auto-provisioned new catalog SKUs: ${autoProvisioned.join(", ")}.`);
  }

  await db.logAgentStep(
    state.orderId,
    "inventory",
    inventoryOk ? "stock_reserved" : "stock_shortfall",
    detailParts.join(" ")
  );

  return {
    inventoryOk,
    backorderedSkus,
    status: inventoryOk ? "inventory_checked" : "backordered",
  };
}

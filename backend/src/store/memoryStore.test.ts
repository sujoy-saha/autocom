import { beforeEach, describe, expect, it } from "vitest";
import { memoryStore } from "./memoryStore.js";

// The in-memory store is a process-wide singleton (module-level Maps), so
// each test uses its own unique SKU and explicitly seeds the row it needs
// via upsertInventoryItem, rather than relying on cross-test isolation.
describe("memoryStore inventory reservation", () => {
  beforeEach(async () => {
    await memoryStore.upsertInventoryItem("TEST-SKU-A", "Test Widget A", 5, 10);
  });

  it("reserveInventory decrements stock and returns true when enough is available", async () => {
    const ok = await memoryStore.reserveInventory("TEST-SKU-A", 3);
    expect(ok).toBe(true);
    expect(await memoryStore.getInventoryQuantity("TEST-SKU-A")).toBe(2);
  });

  it("reserveInventory returns false and leaves stock untouched when there isn't enough", async () => {
    const ok = await memoryStore.reserveInventory("TEST-SKU-A", 99);
    expect(ok).toBe(false);
    expect(await memoryStore.getInventoryQuantity("TEST-SKU-A")).toBe(5);
  });

  it("reserveInventory returns false for a SKU that doesn't exist", async () => {
    const ok = await memoryStore.reserveInventory("NO-SUCH-SKU", 1);
    expect(ok).toBe(false);
  });

  it("releaseInventory increments stock back (rollback path)", async () => {
    await memoryStore.reserveInventory("TEST-SKU-A", 3);
    await memoryStore.releaseInventory("TEST-SKU-A", 3);
    expect(await memoryStore.getInventoryQuantity("TEST-SKU-A")).toBe(5);
  });

  it("never allows quantity_available to go negative via back-to-back reservations", async () => {
    const results = await Promise.all([
      memoryStore.reserveInventory("TEST-SKU-A", 3),
      memoryStore.reserveInventory("TEST-SKU-A", 3),
    ]);
    // Exactly one of the two 3-unit reservations against 5 units of stock
    // can succeed; the other must be rejected rather than driving stock
    // negative.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await memoryStore.getInventoryQuantity("TEST-SKU-A")).toBeGreaterThanOrEqual(0);
  });
});

describe("memoryStore restock approval", () => {
  it("credits stock and creates only one invoice across concurrent approval retries", async () => {
    const sku = `TEST-RESTOCK-${Date.now()}`;
    await memoryStore.upsertInventoryItem(sku, "Restock test item", 0, 10);
    const restockOrder = await memoryStore.createRestockOrder({
      orderId: null,
      sku,
      quantity: 4,
      unitPrice: 10,
      totalCost: 40,
      etaDays: 3,
      vendorOrderId: "vendor-order-test",
    });

    const results = await Promise.all([
      memoryStore.approveRestockOrder(restockOrder.id, 40, "test approval"),
      memoryStore.approveRestockOrder(restockOrder.id, 40, "duplicate retry"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await memoryStore.getInventoryQuantity(sku)).toBe(4);
    expect(restockOrder.status).toBe("invoiced");
    expect((await memoryStore.listInvoices()).filter((invoice) => invoice.restock_order_id === restockOrder.id)).toHaveLength(1);
  });
});

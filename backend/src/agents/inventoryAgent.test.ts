import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked before importing the agent so inventoryAgent.ts's static
// `import { db } from "../store/index.js"` binds to this fake instead of
// the real memory/Supabase store — keeps these tests fast and network-free,
// and lets us assert exactly which store calls the agent makes (in
// particular, that a partial shortfall rolls back the SKUs that *did*
// reserve successfully).
vi.mock("../store/index.js", () => ({
  db: {
    getInventoryQuantity: vi.fn(),
    ensureInventoryItem: vi.fn(),
    reserveInventory: vi.fn(),
    releaseInventory: vi.fn(),
    updateOrder: vi.fn(),
    logAgentStep: vi.fn(),
  },
}));

const { db } = await import("../store/index.js");
const { inventoryAgent } = await import("./inventoryAgent.js");
import type { OrderState } from "../graph/state.js";

function baseState(items: OrderState["items"]): OrderState {
  return {
    orderId: "order-1",
    orderNumber: "ORD-000001",
    customerId: "cust-1",
    customerEmail: "buyer@example.com",
    rawRequest: "",
    items,
    totalAmount: 100,
    inventoryOk: false,
    backorderedSkus: [],
    approvalRequired: false,
    paymentStatus: "pending",
    status: "received",
    notifications: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("inventoryAgent", () => {
  it("reserves every line item and reports inventoryOk when all SKUs have enough stock", async () => {
    (db.getInventoryQuantity as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (db.reserveInventory as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const state = baseState([
      { sku: "SKU-001", quantity: 2, unitPrice: 10 },
      { sku: "SKU-002", quantity: 1, unitPrice: 20 },
    ]);

    const result = await inventoryAgent(state);

    expect(result.inventoryOk).toBe(true);
    expect(result.backorderedSkus).toEqual([]);
    expect(db.reserveInventory).toHaveBeenCalledWith("SKU-001", 2);
    expect(db.reserveInventory).toHaveBeenCalledWith("SKU-002", 1);
    expect(db.releaseInventory).not.toHaveBeenCalled();
    expect(db.updateOrder).toHaveBeenCalledWith("order-1", { status: "inventory_checked" });
  });

  it("rolls back SKUs that reserved successfully when a different SKU in the same order is short", async () => {
    (db.getInventoryQuantity as ReturnType<typeof vi.fn>).mockResolvedValue(10);
    (db.reserveInventory as ReturnType<typeof vi.fn>).mockImplementation(async (sku: string) =>
      sku === "SKU-SHORT" ? false : true
    );

    const state = baseState([
      { sku: "SKU-001", quantity: 2, unitPrice: 10 },
      { sku: "SKU-SHORT", quantity: 50, unitPrice: 5 },
    ]);

    const result = await inventoryAgent(state);

    expect(result.inventoryOk).toBe(false);
    expect(result.backorderedSkus).toEqual(["SKU-SHORT"]);
    // SKU-001 reserved successfully but must be released since the order
    // as a whole is backordered.
    expect(db.releaseInventory).toHaveBeenCalledWith("SKU-001", 2);
    expect(db.releaseInventory).not.toHaveBeenCalledWith("SKU-SHORT", expect.anything());
    expect(db.updateOrder).toHaveBeenCalledWith("order-1", { status: "backordered" });
  });

  it("auto-provisions an unknown SKU (e.g. from an uploaded PO) with the requested quantity", async () => {
    (db.getInventoryQuantity as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (db.reserveInventory as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const state = baseState([{ sku: "NEW-SKU", quantity: 3, unitPrice: 15, name: "New Widget" }]);

    const result = await inventoryAgent(state);

    expect(db.ensureInventoryItem).toHaveBeenCalledWith("NEW-SKU", "New Widget", 3, 15);
    expect(db.reserveInventory).toHaveBeenCalledWith("NEW-SKU", 3);
    expect(result.inventoryOk).toBe(true);
  });
});

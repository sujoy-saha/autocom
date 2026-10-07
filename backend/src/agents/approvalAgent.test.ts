import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store/index.js", () => ({
  db: {
    updateOrder: vi.fn(),
    logAgentStep: vi.fn(),
  },
}));
vi.mock("../config.js", () => ({
  config: { approvalThreshold: 500 },
}));

const { db } = await import("../store/index.js");
const { approvalAgent } = await import("./approvalAgent.js");
import type { OrderState } from "../graph/state.js";

function baseState(totalAmount: number): OrderState {
  return {
    orderId: "order-1",
    orderNumber: "ORD-000001",
    customerId: "cust-1",
    customerEmail: "buyer@example.com",
    rawRequest: "",
    items: [],
    totalAmount,
    inventoryOk: true,
    backorderedSkus: [],
    approvalRequired: false,
    paymentStatus: "pending",
    status: "inventory_checked",
    notifications: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approvalAgent", () => {
  it("auto-approves an order at exactly the threshold (strictly-greater-than check)", async () => {
    const result = await approvalAgent(baseState(500));
    expect(result.approvalRequired).toBe(false);
    expect(db.updateOrder).not.toHaveBeenCalled();
  });

  it("auto-approves an order below the threshold", async () => {
    const result = await approvalAgent(baseState(499.99));
    expect(result.approvalRequired).toBe(false);
  });

  it("holds an order above the threshold for human sign-off", async () => {
    const result = await approvalAgent(baseState(500.01));
    expect(result.approvalRequired).toBe(true);
    expect(result.status).toBe("pending_approval");
    expect(db.updateOrder).toHaveBeenCalledWith("order-1", { status: "pending_approval" });
  });
});

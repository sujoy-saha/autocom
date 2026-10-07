import { db } from "../store/index.js";
import type { RestockOrderRow } from "../store/types.js";

/**
 * Supplier Agent: the supplier-side counterpart to the Replenishment Agent.
 * The moment a restock ("backfill") order is placed with the vendor (see
 * agents/replenishmentAgent.ts -> db.createRestockOrder), this agent
 * registers receipt of that request on the supplier's behalf and logs it
 * to the order's timeline. It does not decide anything itself — a real
 * human Supplier must explicitly approve or reject the request (see
 * routes/restock.ts's `:id/approve` / `:id/reject`) before anything else in
 * the pipeline (invoicing) can proceed. This mirrors a genuine trading
 * partner receiving a purchase request and holding it for review rather
 * than auto-fulfilling everything a buyer asks for.
 */
export async function supplierAgentReceiveRestockOrder(restockOrder: RestockOrderRow): Promise<void> {
  if (!restockOrder.order_id) return;
  await db.logAgentStep(
    restockOrder.order_id,
    "supplier",
    "restock_request_received",
    `Supplier Agent received the restock request for ${restockOrder.quantity} unit(s) of ${restockOrder.sku} ` +
      `(vendor order ${restockOrder.vendor_order_id ?? "n/a"}, €${restockOrder.total_cost.toFixed(2)}) — ` +
      `awaiting Supplier approval before an invoice can be sent.`
  );
}

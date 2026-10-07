import { db } from "../store/index.js";
import { config } from "../config.js";
import type { OrderState } from "../graph/state.js";

/**
 * Approval Agent: the enterprise guardrail gate between Inventory and
 * Payment. Orders whose total exceeds `config.approvalThreshold` are held
 * (status "pending_approval") instead of proceeding straight to Payment —
 * a human must call `POST /api/orders/:id/approve` (or `/reject`, see
 * routes/orders.ts) before money moves. Orders at or under the threshold
 * are auto-approved and pass straight through.
 *
 * Stock is already reserved by the time this runs (Inventory is the
 * previous node), so a held order is never double-charged or
 * double-reserved on approval — see orderService.ts's `approveOrder`,
 * which resumes the pipeline directly at Payment rather than restarting
 * the whole graph.
 */
export async function approvalAgent(state: OrderState): Promise<Partial<OrderState>> {
  const requiresApproval = state.totalAmount > config.approvalThreshold;

  if (!requiresApproval) {
    await db.logAgentStep(
      state.orderId,
      "approval",
      "auto_approved",
      `Total €${state.totalAmount.toFixed(2)} is at or below the €${config.approvalThreshold.toFixed(2)} ` +
        `auto-approval threshold — proceeding straight to payment.`
    );
    return { approvalRequired: false };
  }

  await db.updateOrder(state.orderId, { status: "pending_approval" });
  await db.logAgentStep(
    state.orderId,
    "approval",
    "approval_required",
    `Total €${state.totalAmount.toFixed(2)} exceeds the €${config.approvalThreshold.toFixed(2)} ` +
      `auto-approval threshold — held for human sign-off before payment is charged.`
  );

  return { approvalRequired: true, status: "pending_approval" };
}

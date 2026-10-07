import { db } from "../store/index.js";
import { completeText } from "../llm/nebiusClient.js";
import type { OrderState } from "../graph/state.js";

/**
 * Support Agent: the final node on every path (success, backorder, or
 * payment failure). Uses Nemotron to draft a customer-facing message
 * tailored to the actual outcome, then persists it as a notification.
 */
export async function supportAgent(state: OrderState): Promise<Partial<OrderState>> {
  const outcome =
    state.status === "fulfilled"
      ? "The order was paid and has shipped."
      : state.status === "backordered"
        ? `The order could not be fully stocked (short on: ${state.backorderedSkus.join(", ")}).`
        : state.status === "payment_failed"
          ? "Payment for the order failed."
          : "The order status changed.";

  const message = await completeText(
    `Order ${state.orderNumber} for ${state.customerEmail}. Outcome: ${outcome} ` +
      `Total: €${state.totalAmount.toFixed(2)}. ` +
      (state.trackingNumber ? `Tracking number: ${state.trackingNumber}. ` : "") +
      `Write a short, friendly customer notification email (3-4 sentences) about this. ` +
      `Refer to the order only as "${state.orderNumber}" — never mention any internal ID.`,
    {
      system:
        "You are the Support & Notifications Agent for an order management system. " +
        "Write concise, empathetic, professional customer emails.",
      temperature: 0.4,
    }
  );

  await db.insertNotification({
    orderId: state.orderId,
    channel: "email",
    message,
  });

  const finalStatus = state.status === "fulfilled" ? "completed" : state.status;
  await db.updateOrder(state.orderId, { status: finalStatus });

  await db.logAgentStep(state.orderId, "support", "notification_sent", message);

  return { status: finalStatus, notifications: [...state.notifications, message] };
}

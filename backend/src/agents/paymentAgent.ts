import { v4 as uuid } from "uuid";
import { db } from "../store/index.js";
import { config } from "../config.js";
import * as stripePayment from "../services/stripePayment.js";
import type { OrderState } from "../graph/state.js";

/**
 * Payment Agent: charges the customer via Stripe's test-mode (sandbox) API
 * using a configurable Stripe test PaymentMethod (see
 * services/stripePayment.ts and config.stripeTestPaymentMethod/
 * stripeDeclinePaymentMethod). Falls back to a local simulated charge
 * (~90% approval) when no STRIPE_SECRET_KEY is configured
 * (config.isDemoPayment), so the app still runs without Stripe creds.
 */
async function simulateChargeCard(amount: number): Promise<{ status: "succeeded" | "failed"; ref: string }> {
  const approved = Math.random() > 0.1;
  return { status: approved ? "succeeded" : "failed", ref: `sim_${uuid().slice(0, 8)}` };
}

async function chargeCard(
  amount: number,
  paymentMethodId?: string
): Promise<{ status: "succeeded" | "failed"; ref: string }> {
  if (config.isDemoPayment) {
    return simulateChargeCard(amount);
  }
  const result = await stripePayment.chargeCard(amount, "eur", paymentMethodId);
  return { status: result.status, ref: result.ref };
}

export async function paymentAgent(state: OrderState): Promise<Partial<OrderState>> {
  const result = await chargeCard(state.totalAmount, state.testPaymentMethodId);

  await db.insertPayment({
    orderId: state.orderId,
    amount: state.totalAmount,
    status: result.status,
    providerRef: result.ref,
  });

  const status = result.status === "succeeded" ? "paid" : "payment_failed";
  await db.updateOrder(state.orderId, { status });

  await db.logAgentStep(
    state.orderId,
    "payment",
    result.status === "succeeded" ? "payment_succeeded" : "payment_failed",
    `Charged €${state.totalAmount.toFixed(2)} (ref ${result.ref}) -> ${result.status}`
  );

  return { paymentStatus: result.status, paymentRef: result.ref, status };
}

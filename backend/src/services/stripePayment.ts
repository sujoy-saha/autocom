import Stripe from "stripe";
import { config } from "../config.js";

/**
 * Stripe test-mode (sandbox) payment integration for the Payment Agent
 * (see agents/paymentAgent.ts). Only ever initialized with a Stripe *test*
 * secret key (sk_test_...) — config.stripeSecretKey. When no key is
 * configured (config.isDemoPayment), paymentAgent falls back to a local
 * simulated charge instead of calling this module.
 */
const stripe = config.stripeSecretKey
  ? new Stripe(config.stripeSecretKey, { apiVersion: "2026-08-26.dahlia" })
  : null;

export interface ChargeResult {
  status: "succeeded" | "failed";
  /** Stripe PaymentIntent ID (pi_...), used as the payment's provider_ref. */
  ref: string;
  failureMessage?: string;
}

/**
 * Charges `amount` (in major currency units, e.g. EUR) against Stripe's
 * test-mode sandbox using a test PaymentMethod (defaults to
 * config.stripeTestPaymentMethod, e.g. "pm_card_visa"). Pass one of
 * Stripe's published decline test PaymentMethod IDs (e.g.
 * config.stripeDeclinePaymentMethod, "pm_card_chargeDeclined") to exercise
 * a real Stripe-side decline for demos.
 *
 * https://stripe.com/docs/testing#cards
 */
export async function chargeCard(
  amount: number,
  currency: string = "eur",
  paymentMethodId: string = config.stripeTestPaymentMethod
): Promise<ChargeResult> {
  if (!stripe) {
    throw new Error("chargeCard called without a configured STRIPE_SECRET_KEY");
  }

  // Stripe expects the smallest currency unit (cents for EUR/USD).
  const amountInCents = Math.round(amount * 100);

  try {
    const intent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency,
      payment_method: paymentMethodId,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
    });

    if (intent.status === "succeeded") {
      return { status: "succeeded", ref: intent.id };
    }

    // Any non-succeeded status (e.g. requires_payment_method after a
    // synchronous decline) is treated as a failed charge.
    return {
      status: "failed",
      ref: intent.id,
      failureMessage: intent.last_payment_error?.message ?? `Payment intent status: ${intent.status}`,
    };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      // Card declined (e.g. pm_card_chargeDeclined) — Stripe raises this as
      // an error rather than returning a non-succeeded intent.
      const ref = (err.payment_intent as Stripe.PaymentIntent | undefined)?.id ?? `stripe_err_${Date.now()}`;
      return { status: "failed", ref, failureMessage: err.message };
    }
    throw err;
  }
}

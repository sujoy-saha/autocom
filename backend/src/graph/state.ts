export interface OrderLineItem {
  sku: string;
  quantity: number;
  unitPrice: number;
  /** Human-readable name, used to auto-provision a catalog entry when a
   * PO-sourced SKU isn't already known to inventory. */
  name?: string;
}

/**
 * Shared state threaded through every node of the LangGraph order pipeline.
 * Each agent reads what it needs and returns a partial patch that LangGraph
 * merges back into the state before invoking the next node.
 */
export interface OrderState {
  orderId: string;
  /** Human-readable order number (e.g. "ORD-000042") shown in customer-facing
   * notifications/UI instead of the internal UUID primary key. */
  orderNumber: string;
  customerId: string;
  customerEmail: string;
  rawRequest: string;

  items: OrderLineItem[];
  totalAmount: number;

  inventoryOk: boolean;
  backorderedSkus: string[];

  /** Set by the Approval Agent: true if totalAmount exceeded
   * config.approvalThreshold and the order was held for human sign-off
   * (status "pending_approval") instead of proceeding straight to Payment. */
  approvalRequired: boolean;

  paymentStatus: "pending" | "succeeded" | "failed";
  paymentRef?: string;
  /** Optional Stripe test PaymentMethod override (see
   * services/stripePayment.ts) for demoing a specific test card outcome —
   * e.g. config.stripeDeclinePaymentMethod to force a decline, or a good
   * card ID on a subsequent retry-payment call. Ignored in demo/simulated
   * payment mode (config.isDemoPayment). */
  testPaymentMethodId?: string;

  shipmentId?: string;
  trackingNumber?: string;

  status: string;
  notifications: string[];
}

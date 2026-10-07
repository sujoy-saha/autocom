import { db } from "../store/index.js";
import { buildOrderGraph, buildResumeAfterApprovalGraph } from "../graph/orchestrator.js";
import { newOrderId, formatOrderNumber } from "../utils/orderId.js";
import { extractOrderFromText } from "../agents/chatIntakeAgent.js";
import { extractPurchaseOrder, persistPurchaseOrder, type PoIntakeResult } from "../agents/poIntakeAgent.js";
import type { OrderLineItem } from "../graph/state.js";
import type { ParsedPurchaseOrder } from "../agents/poParser.js";

/**
 * Single compiled LangGraph instance, shared by every intake channel (PO PDF
 * upload via the REST route, free-text chat/bot orders via the `place_order`
 * MCP tool) so the pipeline wiring and per-agent business logic live in
 * exactly one place instead of being re-implemented per channel.
 */
export const orderGraph = buildOrderGraph();

/** Tail-only graph (Payment -> Fulfillment/Support) used to resume an order
 * held by the Approval Agent — see `approveOrder` below. */
export const resumeAfterApprovalGraph = buildResumeAfterApprovalGraph();

export interface ChatOrderInput {
  customerEmail: string;
  customerName?: string;
  /** The customer's plain-English order request, e.g. "2 wireless mice and a mechanical keyboard". */
  message: string;
}

export interface ChatOrderResult {
  orderId: string;
  orderNumber: string;
  customerId: string;
  items: OrderLineItem[];
  totalAmount: number;
  extractionMethod: "nemotron" | "regex-fallback";
  unmatchedText: string[];
  /** Final LangGraph state (status, payment/shipment refs, notifications, ...), or null if intake failed before the graph ran. */
  result: Record<string, unknown> | null;
}

/**
 * End-to-end intake for a free-text order — e.g. a web chat bot, exposed as
 * the `place_order` MCP tool (see mcp/server.ts). Matches the requested
 * items against the *live* catalog (unlike PO intake, which trusts an
 * external vendor's own SKUs/prices from an uploaded document), creates the
 * customer/order records, then runs the same `orderGraph` used by every
 * other intake channel (inventory -> payment -> fulfillment -> support).
 *
 * The order row is created *before* any extraction/logging happens (unlike
 * the PO upload path), since `agent_logs.order_id` has a not-null foreign
 * key against `orders` — logging a step against an order id that doesn't
 * exist yet would fail against a real Supabase backend.
 */
export async function createOrderFromText(input: ChatOrderInput): Promise<ChatOrderResult> {
  const { customerEmail, customerName, message } = input;
  const orderId = newOrderId();

  const customer = await db.getOrCreateCustomer(customerName ?? customerEmail, customerEmail);
  const { orderSeq } = await db.createOrder({ id: orderId, customerId: customer.id, rawRequest: message });
  const orderNumber = formatOrderNumber(orderSeq, orderId);

  const { items, totalAmount, extractionMethod, unmatchedText } = await extractOrderFromText(orderId, message);

  if (items.length === 0) {
    // Nothing matched — this wasn't really an order request (or was
    // unparseable), so don't leave a stray order record behind; roll back
    // the row created above (see deleteOrder's doc comment).
    await db.deleteOrder(orderId);
    return {
      orderId,
      orderNumber,
      customerId: customer.id,
      items,
      totalAmount,
      extractionMethod,
      unmatchedText,
      result: null,
    };
  }

  await db.updateOrder(orderId, { items, total_amount: totalAmount });

  const result = await orderGraph.invoke({
    orderId,
    orderNumber,
    customerId: customer.id,
    customerEmail,
    rawRequest: message,
    items,
    totalAmount,
  });

  return { orderId, orderNumber, customerId: customer.id, items, totalAmount, extractionMethod, unmatchedText, result };
}

export interface PdfOrderInput {
  fileBuffer: Buffer;
  fileName: string;
  /** Fallback identity if the PDF's billing address has no extractable contact email/name. */
  customerName?: string;
  customerEmail?: string;
}

export interface PdfOrderResult {
  orderId: string;
  orderNumber: string;
  customerId: string;
  parsed: ParsedPurchaseOrder;
  extractionMethod: "nemotron" | "regex-fallback";
  result: Record<string, unknown>;
}

export type PdfOrderOutcome = PdfOrderResult | { error: string };

/**
 * End-to-end intake for an uploaded purchase-order PDF — shared by the
 * `/api/orders/from-po` REST route and the chat bot's PDF-attachment path
 * (see agents/chatBotAgent.ts). The PO Intake Agent extracts vendor/items/
 * pricing/billing address from the document *first* (so the customer's
 * identity can be derived from the PO's own billing contact rather than
 * requiring the caller to supply it), then the same `orderGraph` used by
 * every other intake channel runs starting at Inventory.
 */
export async function createOrderFromPdf(input: PdfOrderInput): Promise<PdfOrderOutcome> {
  const { fileBuffer, fileName, customerName, customerEmail } = input;
  const orderId = newOrderId();
  const extracted = await extractPurchaseOrder(orderId, fileBuffer);

  if (extracted.items.length === 0) {
    return { error: "Could not find any line items in the uploaded PDF. Try a clearer scan/export." };
  }

  // Prefer the PO's own billing contact as the customer's identity; fall
  // back to caller-supplied values (or an explicit error) only if the PDF
  // didn't have an extractable billing address/email.
  const resolvedEmail = extracted.parsed.billingAddress?.contactEmail ?? customerEmail;

  if (!resolvedEmail) {
    return {
      error: "Could not find a billing contact email in the uploaded PDF, and no customerEmail was provided.",
    };
  }

  const resolvedName = extracted.parsed.billingAddress?.companyName ?? customerName ?? resolvedEmail;

  const rawRequest = `Uploaded purchase order: ${fileName}`;
  const customer = await db.getOrCreateCustomer(resolvedName, resolvedEmail);
  const { orderSeq } = await db.createOrder({ id: orderId, customerId: customer.id, rawRequest });
  const orderNumber = formatOrderNumber(orderSeq, orderId);
  await persistPurchaseOrder(orderId, customer.id, extracted);

  const { items, totalAmount, parsed, extractionMethod } = extracted;

  const result = await orderGraph.invoke({
    orderId,
    orderNumber,
    customerId: customer.id,
    customerEmail: resolvedEmail,
    rawRequest,
    items,
    totalAmount,
  });

  return { orderId, orderNumber, customerId: customer.id, parsed, extractionMethod, result };
}

export interface RetryOrderResult {
  orderId: string;
  orderNumber: string;
  result: Record<string, unknown>;
}

export type RetryOrderOutcome = RetryOrderResult | { error: string };

/**
 * Re-runs the order pipeline (inventory -> payment -> fulfillment ->
 * support) for an order that previously landed on `backordered`, e.g. after
 * restocking a short SKU. Only valid for orders currently in that state —
 * inventory reservation is atomic (see inventoryAgent.ts), so a backordered
 * order never had *any* of its line items reserved yet, making it safe to
 * re-check the full item list from scratch without double-reserving.
 */
export async function retryBackorderedOrder(orderId: string): Promise<RetryOrderOutcome> {
  const { order, customer } = await db.getOrderDetails(orderId);

  if (!order) {
    return { error: `No order found with id ${orderId}.` };
  }
  if (order.status !== "backordered") {
    return {
      error: `Order is not backordered (current status: "${order.status}") — nothing to retry.`,
    };
  }
  if (!customer) {
    return { error: "Order has no associated customer record." };
  }

  const items = (order.items ?? []) as OrderLineItem[];
  const totalAmount = order.total_amount ?? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const orderNumber = formatOrderNumber(order.order_seq, order.id);

  await db.logAgentStep(
    orderId,
    "inventory",
    "retry_requested",
    "Manual retry requested — re-checking inventory for previously backordered item(s)."
  );

  const result = await orderGraph.invoke({
    orderId,
    orderNumber,
    customerId: order.customer_id,
    customerEmail: customer.email,
    rawRequest: order.raw_request,
    items,
    totalAmount,
  });

  return { orderId, orderNumber, result };
}

export interface ApproveOrderResult {
  orderId: string;
  orderNumber: string;
  result: Record<string, unknown>;
}

export type ApproveOrderOutcome = ApproveOrderResult | { error: string };

/**
 * Approves an order held by the Approval Agent (status "pending_approval",
 * see agents/approvalAgent.ts) and resumes the pipeline directly at Payment
 * via `resumeAfterApprovalGraph`. Deliberately does NOT re-invoke the full
 * order graph from START — Inventory already reserved this order's stock
 * before the approval gate, so restarting at Inventory would double-reserve
 * it (contrast with `retryBackorderedOrder`, which is safe to restart from
 * Inventory precisely because a backordered order never reserved anything).
 */
export async function approveOrder(orderId: string): Promise<ApproveOrderOutcome> {
  const { order, customer } = await db.getOrderDetails(orderId);

  if (!order) {
    return { error: `No order found with id ${orderId}.` };
  }
  if (order.status !== "pending_approval") {
    return { error: `Order is not pending approval (current status: "${order.status}") — nothing to approve.` };
  }
  if (!customer) {
    return { error: "Order has no associated customer record." };
  }

  const items = (order.items ?? []) as OrderLineItem[];
  const totalAmount = order.total_amount ?? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const orderNumber = formatOrderNumber(order.order_seq, order.id);

  await db.updateOrder(orderId, { status: "approved" });
  await db.logAgentStep(
    orderId,
    "approval",
    "approved",
    "Order approved by a human reviewer — resuming pipeline at payment."
  );

  const result = await resumeAfterApprovalGraph.invoke({
    orderId,
    orderNumber,
    customerId: order.customer_id,
    customerEmail: customer.email,
    rawRequest: order.raw_request,
    items,
    totalAmount,
  });

  return { orderId, orderNumber, result };
}

/**
 * Rejects an order held by the Approval Agent. No further pipeline steps
 * run — Payment is never charged. Stock reserved by Inventory is
 * deliberately left as-is (releasing it is a real inventory-management
 * decision, not something to do implicitly on rejection); release it
 * manually via the inventory admin endpoints if needed.
 */
export async function rejectOrder(orderId: string, reason?: string): Promise<ApproveOrderOutcome> {
  const { order } = await db.getOrderDetails(orderId);

  if (!order) {
    return { error: `No order found with id ${orderId}.` };
  }
  if (order.status !== "pending_approval") {
    return { error: `Order is not pending approval (current status: "${order.status}") — nothing to reject.` };
  }

  await db.updateOrder(orderId, { status: "rejected" });
  await db.logAgentStep(
    orderId,
    "approval",
    "rejected",
    reason ? `Order rejected by a human reviewer: ${reason}` : "Order rejected by a human reviewer."
  );

  return {
    orderId,
    orderNumber: formatOrderNumber(order.order_seq, order.id),
    result: { status: "rejected" },
  };
}

/**
 * Retries payment for an order the Payment Agent previously declined
 * (status "payment_failed" — see agents/paymentAgent.ts's simulated ~10%
 * decline rate). Resumes directly at Payment via `resumeAfterApprovalGraph`,
 * same tail used after a human approval: Inventory already reserved this
 * order's stock and there's nothing to re-check there, so re-running the
 * full graph from START would double-reserve it.
 */
export async function retryPayment(orderId: string, testPaymentMethodId?: string): Promise<ApproveOrderOutcome> {
  const { order, customer } = await db.getOrderDetails(orderId);

  if (!order) {
    return { error: `No order found with id ${orderId}.` };
  }
  if (order.status !== "payment_failed") {
    return { error: `Order payment did not fail (current status: "${order.status}") — nothing to retry.` };
  }
  if (!customer) {
    return { error: "Order has no associated customer record." };
  }

  const items = (order.items ?? []) as OrderLineItem[];
  const totalAmount = order.total_amount ?? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const orderNumber = formatOrderNumber(order.order_seq, order.id);

  await db.logAgentStep(orderId, "payment", "retry_requested", "Manual retry requested — re-attempting payment.");

  const result = await resumeAfterApprovalGraph.invoke({
    orderId,
    orderNumber,
    customerId: order.customer_id,
    customerEmail: customer.email,
    rawRequest: order.raw_request,
    items,
    totalAmount,
    testPaymentMethodId,
  });

  return { orderId, orderNumber, result };
}


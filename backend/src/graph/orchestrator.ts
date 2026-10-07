import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import { inventoryAgent } from "../agents/inventoryAgent.js";
import { replenishmentAgent } from "../agents/replenishmentAgent.js";
import { approvalAgent } from "../agents/approvalAgent.js";
import { paymentAgent } from "../agents/paymentAgent.js";
import { fulfillmentAgent } from "../agents/fulfillmentAgent.js";
import { supportAgent } from "../agents/supportAgent.js";
import type { OrderLineItem } from "./state.js";

// LangGraph state annotation. Each field's reducer defaults to "last write
// wins", which matches how our agents return full replacement values.
const OrderAnnotation = Annotation.Root({
  orderId: Annotation<string>,
  orderNumber: Annotation<string>,
  customerId: Annotation<string>,
  customerEmail: Annotation<string>,
  rawRequest: Annotation<string>,

  items: Annotation<OrderLineItem[]>({ default: () => [], reducer: (_, next) => next }),
  totalAmount: Annotation<number>({ default: () => 0, reducer: (_, next) => next }),

  inventoryOk: Annotation<boolean>({ default: () => false, reducer: (_, next) => next }),
  backorderedSkus: Annotation<string[]>({ default: () => [], reducer: (_, next) => next }),

  approvalRequired: Annotation<boolean>({ default: () => false, reducer: (_, next) => next }),

  paymentStatus: Annotation<"pending" | "succeeded" | "failed">({
    default: () => "pending",
    reducer: (_, next) => next,
  }),
  paymentRef: Annotation<string | undefined>({ default: () => undefined, reducer: (_, next) => next }),
  testPaymentMethodId: Annotation<string | undefined>({ default: () => undefined, reducer: (_, next) => next }),

  shipmentId: Annotation<string | undefined>({ default: () => undefined, reducer: (_, next) => next }),
  trackingNumber: Annotation<string | undefined>({ default: () => undefined, reducer: (_, next) => next }),

  status: Annotation<string>({ default: () => "received", reducer: (_, next) => next }),
  notifications: Annotation<string[]>({ default: () => [], reducer: (_, next) => next }),
});

/**
 * The end-to-end order pipeline:
 *
 *   PO Intake Agent (pre-run) ─▶ inventory -+-> approval -+-> payment -+-> fulfillment -> support -> END
 *                                            |             |            |
 *                                            |             '-- (held) --+-> END (awaiting human decision)
 *                                            '-> replenishment -> support (backorder, vendor restock requested)
 *                                                                        (payment declined also lands on support)
 *
 * PDF purchase orders are parsed by the PO Intake Agent *before* the graph
 * runs (see routes/orders.ts), so `items`/`totalAmount` arrive already
 * populated and the graph starts straight at Inventory.
 *
 * A shortfall at Inventory routes to the Replenishment Agent, which
 * autonomously requests restock from an *external* vendor MCP server
 * (mcp/vendorServer.ts / vendorClient.ts — a separate system from our own
 * catalog tools) before still landing on Support, since the current order
 * remains backordered until that stock physically arrives (see
 * agents/replenishmentAgent.ts).
 *
 * The Approval Agent is an enterprise guardrail: orders over
 * config.approvalThreshold stop here (status "pending_approval") and the
 * graph run ends without reaching Payment, until a human calls
 * `POST /api/orders/:id/approve` (see orderService.ts's `approveOrder`,
 * which resumes via `buildResumeAfterApprovalGraph` below — starting a
 * fresh run at Inventory would double-reserve stock that's already held).
 *
 * Routing decisions (inventory shortfall, approval required, payment
 * declined) are made purely from state written by the previous agent, so
 * each agent stays a simple, independently testable function.
 */
export function buildOrderGraph() {
  const graph = new StateGraph(OrderAnnotation)
    .addNode("inventory", inventoryAgent)
    .addNode("replenishment", replenishmentAgent)
    .addNode("approval", approvalAgent)
    .addNode("payment", paymentAgent)
    .addNode("fulfillment", fulfillmentAgent)
    .addNode("support", supportAgent)
    .addEdge(START, "inventory")
    .addConditionalEdges("inventory", (state) => (state.inventoryOk ? "approval" : "replenishment"), {
      approval: "approval",
      replenishment: "replenishment",
    })
    .addEdge("replenishment", "support")
    .addConditionalEdges("approval", (state) => (state.approvalRequired ? END : "payment"), {
      [END]: END,
      payment: "payment",
    })
    .addConditionalEdges(
      "payment",
      (state) => (state.paymentStatus === "succeeded" ? "fulfillment" : "support"),
      { fulfillment: "fulfillment", support: "support" }
    )
    .addEdge("fulfillment", "support")
    .addEdge("support", END);

  return graph.compile();
}

/**
 * The tail of the pipeline (Payment -> Fulfillment/Support -> END), used to
 * resume an order that was held by the Approval Agent once a human approves
 * it (see orderService.ts's `approveOrder`). Deliberately does not include
 * Inventory or Approval — stock was already reserved and the approval
 * decision already made, so re-running the full graph from START would
 * double-reserve stock and re-evaluate a decision that's no longer pending.
 */
export function buildResumeAfterApprovalGraph() {
  const graph = new StateGraph(OrderAnnotation)
    .addNode("payment", paymentAgent)
    .addNode("fulfillment", fulfillmentAgent)
    .addNode("support", supportAgent)
    .addEdge(START, "payment")
    .addConditionalEdges(
      "payment",
      (state) => (state.paymentStatus === "succeeded" ? "fulfillment" : "support"),
      { fulfillment: "fulfillment", support: "support" }
    )
    .addEdge("fulfillment", "support")
    .addEdge("support", END);

  return graph.compile();
}

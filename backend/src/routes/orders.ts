import { Router } from "express";
import multer from "multer";
import { db } from "../store/index.js";
import {
  createOrderFromText,
  createOrderFromPdf,
  retryBackorderedOrder,
  approveOrder,
  rejectOrder,
  retryPayment,
} from "../services/orderService.js";
import { formatOrderNumber } from "../utils/orderId.js";
import { expensiveLimiter } from "../middleware/rateLimit.js";
import { requireRole } from "../middleware/auth.js";
import type { OrderRow } from "../store/types.js";

export const ordersRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/** Attaches the human-readable `order_number` (e.g. "ORD-000042") the UI
 * and chat bot display instead of the raw UUID primary key. */
function withOrderNumber<T extends OrderRow>(order: T): T & { order_number: string } {
  return { ...order, order_number: formatOrderNumber(order.order_seq, order.id) };
}

// Create + run an order from an uploaded purchase-order PDF (see
// services/orderService.ts's createOrderFromPdf for the shared intake logic,
// also reused by the chat bot's PDF-attachment path).
ordersRouter.post("/from-po", expensiveLimiter, upload.single("file"), async (req, res) => {
  const { customerName, customerEmail } = req.body ?? {};
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: "A PDF file field named 'file' is required" });
  }

  try {
    const outcome = await createOrderFromPdf({
      fileBuffer: file.buffer,
      fileName: file.originalname,
      customerName,
      customerEmail,
    });

    if ("error" in outcome) {
      return res.status(422).json(outcome);
    }

    res.status(201).json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create + run an order from a free-text request (e.g. a web chat bot) —
// the same intake channel exposed as the `place_order` MCP tool (see
// mcp/server.ts), reachable over plain HTTP for callers that aren't MCP
// clients themselves. Requested items are matched against the *live*
// catalog rather than trusted from an external document.
ordersRouter.post("/from-text", expensiveLimiter, async (req, res) => {
  const { customerEmail, customerName, message } = req.body ?? {};

  if (!customerEmail || !message) {
    return res.status(400).json({ error: "customerEmail and message are required" });
  }

  try {
    const order = await createOrderFromText({ customerEmail, customerName, message });
    if (order.items.length === 0) {
      return res.status(422).json({
        error: "Could not match any items in the message to the live catalog.",
        unmatchedText: order.unmatchedText,
      });
    }
    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Re-runs a backordered order's pipeline (inventory -> payment ->
// fulfillment -> support) after the missing stock has been restocked —
// see services/orderService.ts's retryBackorderedOrder.
ordersRouter.post("/:id/retry", requireRole("seller"), async (req, res) => {
  try {
    const outcome = await retryBackorderedOrder(req.params.id);
    if ("error" in outcome) {
      return res.status(409).json(outcome);
    }
    res.json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Enterprise guardrail: approves an order held by the Approval Agent
// (status "pending_approval" — see agents/approvalAgent.ts) and resumes the
// pipeline at Payment. See services/orderService.ts's approveOrder.
ordersRouter.post("/:id/approve", requireRole("seller"), async (req, res) => {
  try {
    const outcome = await approveOrder(req.params.id);
    if ("error" in outcome) {
      return res.status(409).json(outcome);
    }
    res.json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Enterprise guardrail: rejects an order held by the Approval Agent.
// Payment is never charged. See services/orderService.ts's rejectOrder.
ordersRouter.post("/:id/reject", requireRole("seller"), async (req, res) => {
  try {
    const outcome = await rejectOrder(req.params.id, req.body?.reason);
    if ("error" in outcome) {
      return res.status(409).json(outcome);
    }
    res.json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Retries payment for an order the Payment Agent previously declined
// (status "payment_failed"), resuming at Payment. See
// services/orderService.ts's retryPayment.
ordersRouter.post("/:id/retry-payment", requireRole("seller"), async (req, res) => {
  try {
    // Optional Stripe test PaymentMethod override (e.g. to retry with a
    // good test card after a forced decline) — see services/stripePayment.ts.
    const outcome = await retryPayment(req.params.id, req.body?.testPaymentMethodId);
    if ("error" in outcome) {
      return res.status(409).json(outcome);
    }
    res.json(outcome);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

ordersRouter.get("/", async (_req, res) => {
  try {
    const orders = await db.listOrders();
    res.json(orders.map(withOrderNumber));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Destructive admin action: wipes every order (and dependent payment/
// shipment/notification/agent_log rows), leaving customers and inventory
// untouched. Order numbering restarts at ORD-000001 for the next order
// created afterwards (see supabaseStore.createOrder / memoryStore).
ordersRouter.delete("/", expensiveLimiter, async (_req, res) => {
  try {
    await db.deleteAllOrders();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

ordersRouter.get("/:id", async (req, res) => {
  try {
    const { order, logs } = await db.getOrderWithLogs(req.params.id);
    res.json({ order: order ? withOrderNumber(order) : null, logs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Full order-status dashboard view: order + customer + payment/shipment/
// notification records + agent log timeline, for a per-order status page.
ordersRouter.get("/:id/details", async (req, res) => {
  try {
    const details = await db.getOrderDetails(req.params.id);
    res.json({ ...details, order: details.order ? withOrderNumber(details.order) : null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

import { Router } from "express";
import { db } from "../store/index.js";
import { requireRole } from "../middleware/auth.js";
import { supplierInvoiceAgent } from "../agents/supplierInvoiceAgent.js";

export const restockRouter = Router();

// Vendor/backfill restock orders placed by the Replenishment Agent (see
// agents/replenishmentAgent.ts), visible to Sellers (oversight) and
// Suppliers (so they can invoice against them). Buyers never see this.
restockRouter.get("/", requireRole("seller", "supplier"), async (_req, res) => {
  try {
    const restockOrders = await db.listRestockOrders();
    res.json(restockOrders);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Human Supplier approves a restock request the Supplier Agent registered
// (see agents/supplierAgent.ts) -- this is the human-in-the-loop gate the
// Supplier Agent waits on. Approving means the goods are confirmed shipped,
// so the seller's live inventory is credited immediately here -- it does
// NOT wait for the Seller to later review/pay the invoice, which is a
// separate billing decision. Approving also hands off to the Supplier
// Invoice Agent, which auto-generates and sends the invoice to the Seller.
restockRouter.post("/:id/approve", requireRole("supplier"), async (req, res) => {
  try {
    const restockOrder = await db.getRestockOrder(req.params.id);
    if (!restockOrder) {
      return res.status(404).json({ error: "Unknown restock order" });
    }
    if (restockOrder.status !== "placed") {
      return res.status(409).json({ error: `Restock order is "${restockOrder.status}", not "placed"` });
    }

    const invoice = await supplierInvoiceAgent(restockOrder);
    if (!invoice) {
      return res.status(409).json({ error: "Restock order was already approved or is no longer available" });
    }
    res.json({ restockOrder: { ...restockOrder, status: "invoiced" }, invoice });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Human Supplier declines to fulfill a restock request -- terminal, no
// invoice is ever generated.
restockRouter.post("/:id/reject", requireRole("supplier"), async (req, res) => {
  try {
    const restockOrder = await db.getRestockOrder(req.params.id);
    if (!restockOrder) {
      return res.status(404).json({ error: "Unknown restock order" });
    }
    if (restockOrder.status !== "placed") {
      return res.status(409).json({ error: `Restock order is "${restockOrder.status}", not "placed"` });
    }

    await db.updateRestockOrderStatus(restockOrder.id, "supplier_rejected");
    if (restockOrder.order_id) {
      await db.logAgentStep(
        restockOrder.order_id,
        "supplier",
        "restock_request_rejected",
        `Supplier declined the restock request for ${restockOrder.quantity} unit(s) of ${restockOrder.sku} — no invoice sent.`
      );
    }
    res.json({ ...restockOrder, status: "supplier_rejected" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

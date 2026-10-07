import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "../store/index.js";
import { config } from "../config.js";
import * as stripePayment from "../services/stripePayment.js";
import { requireRole } from "../middleware/auth.js";
import { invoiceValidatorAgent } from "../agents/invoiceValidatorAgent.js";

export const invoicesRouter = Router();

/** Charges the invoice via Stripe test mode (mirrors agents/paymentAgent.ts's
 * pattern), falling back to a simulated ~90%-approval charge when no
 * STRIPE_SECRET_KEY is configured (config.isDemoPayment). */
async function chargeInvoice(amount: number): Promise<{ status: "succeeded" | "failed"; ref: string }> {
  if (config.isDemoPayment) {
    const approved = Math.random() > 0.1;
    return { status: approved ? "succeeded" : "failed", ref: `sim_inv_${uuid().slice(0, 8)}` };
  }
  const result = await stripePayment.chargeCard(amount, "eur");
  return { status: result.status, ref: result.ref };
}

// Manual invoice submission fallback -- the normal path is the automated
// Supplier Invoice Agent firing on restock-order approval (see
// routes/restock.ts's `:id/approve`), but a Supplier can still submit one
// directly against a restock order it's already approved (e.g. amending an
// amount). Either way, the Invoice Validator Agent runs immediately after.
invoicesRouter.post("/", requireRole("supplier"), async (req, res) => {
  const { restockOrderId, amount, note } = req.body ?? {};

  if (!restockOrderId || typeof amount !== "number" || Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "restockOrderId and a positive numeric amount are required" });
  }

  try {
    const restockOrder = await db.getRestockOrder(restockOrderId);
    if (!restockOrder) {
      return res.status(404).json({ error: "Unknown restock order" });
    }

    if (restockOrder.status !== "placed" && restockOrder.status !== "invoiced") {
      return res.status(409).json({ error: `Restock order is "${restockOrder.status}" and cannot accept an invoice` });
    }

    // A direct invoice submitted against a still-placed restock uses the same
    // atomic receipt-and-invoice transaction as Supplier approval.
    let invoice;
    if (restockOrder.status === "placed") {
      invoice = await db.approveRestockOrder(restockOrderId, amount, note ?? null);
      if (!invoice) {
        return res.status(409).json({ error: "Restock order was already approved or is no longer available" });
      }
    } else {
      invoice = await db.createInvoice({ restockOrderId, amount, note });
    }

    await invoiceValidatorAgent(invoice, restockOrder);
    res.status(201).json(invoice);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Seller + Supplier can list invoices (Supplier sees the same shared list —
// this is a hackathon-scale single-supplier simulation, not multi-tenant).
invoicesRouter.get("/", requireRole("seller", "supplier"), async (_req, res) => {
  try {
    const invoices = await db.listInvoices();
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Seller reviews and approves an invoice -- the human decision the Invoice
// Seller reviews and approves an invoice -- the human decision the Invoice
// Validator Agent's verdict was prepared for. Charges it via Stripe test
// mode (or the simulated fallback), mirroring the normal Payment Agent flow.
// Note: inventory is NOT credited here -- the Supplier already shipped and
// the seller's inventory was already credited the moment the Supplier
// approved the restock request (see routes/restock.ts's `:id/approve`).
// This step is purely the billing/payment decision on top of goods already
// received.
invoicesRouter.post("/:id/approve", requireRole("seller"), async (req, res) => {
  try {
    const invoice = await db.getInvoice(req.params.id);
    if (!invoice) {
      return res.status(404).json({ error: "Unknown invoice" });
    }
    if (invoice.status !== "submitted") {
      return res.status(409).json({ error: `Invoice is "${invoice.status}", not "submitted"` });
    }

    const result = await chargeInvoice(invoice.amount);
    const restockOrder = await db.getRestockOrder(invoice.restock_order_id);
    if (result.status === "succeeded") {
      await db.updateInvoiceStatus(invoice.id, "paid", result.ref);
      await db.updateRestockOrderStatus(invoice.restock_order_id, "paid");

      if (restockOrder?.order_id) {
        await db.logAgentStep(
          restockOrder.order_id,
          "seller",
          "invoice_approved",
          `Seller approved and paid invoice ${invoice.id} (€${invoice.amount.toFixed(2)}) for ` +
            `${restockOrder.quantity} unit(s) of ${restockOrder.sku} -- stock was already received into ` +
            `inventory when the Supplier approved the restock request.`
        );
      }
    } else {
      await db.updateInvoiceStatus(invoice.id, "rejected", result.ref);
      await db.updateRestockOrderStatus(invoice.restock_order_id, "invoice_rejected");
      if (restockOrder?.order_id) {
        await db.logAgentStep(
          restockOrder.order_id,
          "seller",
          "invoice_payment_failed",
          `Charge for invoice ${invoice.id} (€${invoice.amount.toFixed(2)}) failed -- invoice rejected. Stock was already received when the Supplier approved the restock request; only billing is affected.`
        );
      }
    }

    res.json({ ...invoice, status: result.status === "succeeded" ? "paid" : "rejected", provider_ref: result.ref });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Seller rejects an invoice outright (e.g. wrong amount) — no charge made.
invoicesRouter.post("/:id/reject", requireRole("seller"), async (req, res) => {
  try {
    const invoice = await db.getInvoice(req.params.id);
    if (!invoice) {
      return res.status(404).json({ error: "Unknown invoice" });
    }
    if (invoice.status !== "submitted") {
      return res.status(409).json({ error: `Invoice is "${invoice.status}", not "submitted"` });
    }

    await db.updateInvoiceStatus(invoice.id, "rejected");
    await db.updateRestockOrderStatus(invoice.restock_order_id, "invoice_rejected");

    const restockOrder = await db.getRestockOrder(invoice.restock_order_id);
    if (restockOrder?.order_id) {
      await db.logAgentStep(
        restockOrder.order_id,
        "seller",
        "invoice_rejected",
        `Seller rejected invoice ${invoice.id} (€${invoice.amount.toFixed(2)}) -- no charge made. Stock was already received when the Supplier approved the restock request; only billing is affected.`
      );
    }

    res.json({ ...invoice, status: "rejected" });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

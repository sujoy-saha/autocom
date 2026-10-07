import { db } from "../store/index.js";
import type { InvoiceRow, RestockOrderRow } from "../store/types.js";

/**
 * Invoice Validator Agent: runs automatically the instant an invoice is
 * created (whether by the automated Supplier Invoice Agent or the manual
 * submission path), cross-checking it against the restock order it's
 * billed against before it ever reaches the human Seller. Records its
 * verdict (validated/flagged) + a human-readable note on the invoice
 * itself (see store's updateInvoiceValidation) so the Seller review queue
 * (frontend/app/invoices/page.tsx) can surface a warning banner for a
 * mismatch — the Seller still makes the final approve/reject call, this
 * agent never blocks or auto-decides, only flags.
 */
export async function invoiceValidatorAgent(invoice: InvoiceRow, restockOrder: RestockOrderRow): Promise<void> {
  const expected = restockOrder.total_cost;
  const tolerance = Math.max(0.01, expected * 0.01); // 1% tolerance for rounding
  const diff = Math.abs(invoice.amount - expected);

  const problems: string[] = [];
  if (diff > tolerance) {
    problems.push(
      `invoice amount €${invoice.amount.toFixed(2)} does not match the restock order's total €${expected.toFixed(2)} ` +
        `(diff €${diff.toFixed(2)})`
    );
  }
  if (restockOrder.status === "supplier_rejected" || restockOrder.status === "invoice_rejected") {
    problems.push(`restock order is "${restockOrder.status}", not a live approved order`);
  }

  const status: InvoiceRow["validation_status"] = problems.length === 0 ? "validated" : "flagged";
  const note =
    problems.length === 0
      ? `Matches restock order ${restockOrder.id} (${restockOrder.quantity}x ${restockOrder.sku} @ €${expected.toFixed(2)}).`
      : `Flagged: ${problems.join("; ")}.`;

  await db.updateInvoiceValidation(invoice.id, status, note);

  if (restockOrder.order_id) {
    await db.logAgentStep(
      restockOrder.order_id,
      "invoice_validator",
      status === "validated" ? "invoice_validated" : "invoice_flagged",
      `Invoice Validator Agent ${status === "validated" ? "validated" : "flagged"} invoice ${invoice.id}: ${note}`
    );
  }
}

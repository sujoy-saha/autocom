-- Agentic supplier workflow: Supplier Agent -> Supplier Invoice Agent ->
-- Invoice Validator Agent -> human Seller approval.
--
-- Flow this enables (see backend/src/agents/supplierAgent.ts,
-- supplierInvoiceAgent.ts, invoiceValidatorAgent.ts, routes/restock.ts,
-- routes/invoices.ts):
--   1. Replenishment Agent places a restock order with the vendor -- the
--      Supplier Agent logs it as received and the restock order sits
--      "placed", waiting for the human Supplier to approve or reject it
--      (new backend/src/routes/restock.ts :id/approve|reject endpoints).
--   2. On Supplier approval, the Supplier Invoice Agent automatically
--      generates and submits an invoice to the Seller (restock order ->
--      "invoiced"). On rejection, the restock order becomes terminal
--      ("supplier_rejected") and no invoice is ever created.
--   3. The moment an invoice is created (whether by the automated Supplier
--      Invoice Agent or the pre-existing manual submission path), the
--      Invoice Validator Agent cross-checks its amount against the restock
--      order's total_cost and records a validated/flagged verdict for the
--      human Seller to see before deciding.
--   4. The human Seller (unchanged approve/reject endpoints) makes the
--      final call -- approving still charges via Stripe test mode and
--      credits inventory (see 0005_personas.sql's goods-receipt note).

alter table restock_orders drop constraint if exists restock_orders_status_check;
alter table restock_orders add constraint restock_orders_status_check
  check (status in ('placed', 'invoiced', 'invoice_approved', 'invoice_rejected', 'supplier_rejected', 'paid'));

alter table invoices add column if not exists validation_status text
  check (validation_status in ('validated', 'flagged'));
alter table invoices add column if not exists validation_note text;

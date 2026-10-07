"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hasSupabase, supabaseBrowser } from "../lib/supabaseClient";
import { apiFetch } from "../lib/apiClient";
import { useTopbarState } from "../lib/useTopbarState";
import { formatCurrency } from "../lib/format";
import { NavBar } from "../components/NavBar";

interface RestockOrder {
  id: string;
  sku: string;
  quantity: number;
  unit_price: number;
  total_cost: number;
  eta_days: number | null;
  vendor_order_id: string | null;
}

interface Invoice {
  id: string;
  restock_order_id: string;
  amount: number;
  currency: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  validation_status: "validated" | "flagged" | null;
  validation_note: string | null;
  provider_ref: string | null;
  note: string | null;
  created_at: string;
}

function statusTone(status: string): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "paid":
    case "approved":
      return "success";
    case "submitted":
      return "warning";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

// Displayed as "received" from the Seller's point of view -- the Supplier
// submitted it, but the Seller is the one reviewing it here. The underlying
// "submitted" status value is unchanged so existing status checks still work.
function statusLabel(status: string): string {
  return status === "submitted" ? "received" : status;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * Seller-only invoice review queue: invoices the Supplier Invoice Agent
 * auto-generated (or a Supplier manually submitted) against restock
 * ("backfill") orders (see /supplier). Each invoice has already been
 * cross-checked by the Invoice Validator Agent (see
 * backend/src/agents/invoiceValidatorAgent.ts) — a "flagged" badge below
 * means its amount doesn't match the underlying restock order, or the
 * restock order isn't in a valid state; the Seller still makes the final
 * approve/reject call. Approving charges the invoice via Stripe test mode
 * (or the simulated fallback — see backend/src/routes/invoices.ts),
 * mirroring the existing Payment Agent's normal invoice/payment process.
 */
export default function InvoicesPage() {
  const router = useRouter();
  const { demoMode, userEmail, signOut, role, roleLoading } = useTopbarState();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [restockOrders, setRestockOrders] = useState<RestockOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [decisioningId, setDecisioningId] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    if (!roleLoading && role !== "seller") {
      router.replace(role === "supplier" ? "/supplier" : "/dashboard");
    }
  }, [roleLoading, role, router]);

  async function refresh() {
    const [invoiceRes, restockRes] = await Promise.all([apiFetch("/api/invoices"), apiFetch("/api/restock-orders")]);
    if (invoiceRes.ok) setInvoices(await invoiceRes.json());
    if (restockRes.ok) setRestockOrders(await restockRes.json());
    setLoading(false);
  }

  useEffect(() => {
    refresh();

    if (!hasSupabase || !supabaseBrowser) {
      const interval = setInterval(refresh, 3000);
      return () => clearInterval(interval);
    }

    const client = supabaseBrowser;
    const channel = client
      .channel("invoices-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "invoices" }, () => refresh())
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, []);

  function restockOrderFor(restockOrderId: string): RestockOrder | undefined {
    return restockOrders.find((r) => r.id === restockOrderId);
  }

  async function decideInvoice(invoiceId: string, decision: "approve" | "reject") {
    setDecisioningId(invoiceId);
    try {
      const res = await apiFetch(`/api/invoices/${invoiceId}/${decision}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? `Failed to ${decision} invoice`);
        return;
      }
      await refresh();
    } finally {
      setDecisioningId(null);
    }
  }

  return (
    <>
      <NavBar demoMode={demoMode} userEmail={userEmail} onSignOut={signOut} role={role} />

      <main className="container">
        <div className="page-heading">
          <h2>Supplier invoices</h2>
          <p>
            Review invoices submitted by suppliers against backfill restock orders. Inventory is already
            received when the Supplier approves the restock request — approving here just charges the
            invoice via Stripe test mode.
          </p>
        </div>

        {demoMode && (
          <p className="demo-banner">
            <strong>Demo mode:</strong> no Supabase credentials configured on the backend. Using an
            in-memory list that resets on backend restart.
          </p>
        )}

        <div className="card">
          <div className="card-header">
            <h3>Invoices</h3>
            <p className="card-subtext">{invoices.length} total</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Vendor order</th>
                <th>SKU</th>
                <th className="num-cell">Amount</th>
                <th>Note</th>
                <th>Validation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => {
                const restockOrder = restockOrderFor(invoice.restock_order_id);
                return (
                  <tr
                    key={invoice.id}
                    data-clickable="true"
                    data-selected={invoice.id === selectedInvoiceId}
                    tabIndex={0}
                    role="button"
                    aria-label={`View invoice for ${restockOrder?.sku ?? invoice.id}`}
                    onClick={() => setSelectedInvoiceId(invoice.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setSelectedInvoiceId(invoice.id);
                    }}
                  >
                    <td>{restockOrder?.vendor_order_id ?? "—"}</td>
                    <td>{restockOrder?.sku ?? "—"}</td>
                    <td className="num-cell">{formatCurrency(invoice.amount)}</td>
                    <td>{invoice.note || "—"}</td>
                    <td>
                      {invoice.validation_status ? (
                        <span
                          className="status"
                          data-tone={invoice.validation_status === "validated" ? "success" : "warning"}
                          title={invoice.validation_note ?? undefined}
                        >
                          {invoice.validation_status}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <span className="status" data-tone={statusTone(invoice.status)}>
                        {statusLabel(invoice.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {loading && invoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">
                    Loading invoices…
                  </td>
                </tr>
              )}
              {!loading && invoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">
                    No supplier invoices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedInvoiceId &&
          (() => {
            const invoice = invoices.find((i) => i.id === selectedInvoiceId);
            if (!invoice) return null;
            const restockOrder = restockOrderFor(invoice.restock_order_id);
            return (
              <div className="modal-overlay" onClick={() => setSelectedInvoiceId(null)}>
                <div className="card modal-content" onClick={(e) => e.stopPropagation()}>
                  <div className="card-header">
                    <h3>
                      Invoice · <span className="order-number">{restockOrder?.sku ?? invoice.id}</span>
                    </h3>
                    <div className="modal-header-actions">
                      {invoice.status === "submitted" && (
                        <>
                          <button
                            type="button"
                            onClick={() => decideInvoice(invoice.id, "approve")}
                            disabled={decisioningId === invoice.id}
                          >
                            {decisioningId === invoice.id ? "Working…" : "Approve"}
                          </button>
                          <button
                            type="button"
                            className="danger-link"
                            onClick={() => decideInvoice(invoice.id, "reject")}
                            disabled={decisioningId === invoice.id}
                          >
                            {decisioningId === invoice.id ? "Working…" : "Reject"}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="modal-close"
                        aria-label="Close"
                        onClick={() => setSelectedInvoiceId(null)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="order-details">
                    <p>
                      <strong>Status:</strong>{" "}
                      <span className="status" data-tone={statusTone(invoice.status)}>
                        {statusLabel(invoice.status)}
                      </span>
                    </p>
                    {invoice.validation_status && (
                      <p>
                        <strong>Validation:</strong>{" "}
                        <span
                          className="status"
                          data-tone={invoice.validation_status === "validated" ? "success" : "warning"}
                        >
                          {invoice.validation_status}
                        </span>
                        {invoice.validation_note && (
                          <>
                            <br />
                            {invoice.validation_note}
                          </>
                        )}
                      </p>
                    )}
                    {invoice.status !== "submitted" && (
                      <p className="demo-banner">
                        <strong>Note:</strong> the restock order's stock was already received into the
                        seller's inventory when the Supplier approved it — this decision only affects
                        billing/payment, not inventory.
                      </p>
                    )}

                    <h3>Restock order</h3>
                    <table>
                      <thead>
                        <tr>
                          <th>Vendor order</th>
                          <th>SKU</th>
                          <th className="num-cell">Qty</th>
                          <th className="num-cell">Unit price</th>
                          <th className="num-cell">Total cost</th>
                          <th>ETA</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>{restockOrder?.vendor_order_id ?? "—"}</td>
                          <td>{restockOrder?.sku ?? "—"}</td>
                          <td className="num-cell">{restockOrder?.quantity ?? "—"}</td>
                          <td className="num-cell">
                            {restockOrder ? formatCurrency(restockOrder.unit_price) : "—"}
                          </td>
                          <td className="num-cell">
                            {restockOrder ? formatCurrency(restockOrder.total_cost) : "—"}
                          </td>
                          <td>{restockOrder?.eta_days != null ? `${restockOrder.eta_days}d` : "—"}</td>
                        </tr>
                      </tbody>
                    </table>

                    <h3>Invoice</h3>
                    <p>
                      <strong>Amount:</strong> {formatCurrency(invoice.amount)}
                      <br />
                      <strong>Submitted:</strong> {formatDateTime(invoice.created_at)}
                      <br />
                      {invoice.note && (
                        <>
                          <strong>Note:</strong> {invoice.note}
                          <br />
                        </>
                      )}
                      {invoice.provider_ref && (
                        <>
                          <strong>Payment ref:</strong> {invoice.provider_ref}
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}
      </main>
    </>
  );
}

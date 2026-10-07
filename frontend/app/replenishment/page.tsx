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
  order_id: string | null;
  sku: string;
  quantity: number;
  unit_price: number;
  total_cost: number;
  eta_days: number | null;
  vendor_order_id: string | null;
  status: "placed" | "invoiced" | "invoice_approved" | "invoice_rejected" | "supplier_rejected" | "paid";
  created_at: string;
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
    case "invoice_approved":
      return "success";
    case "invoiced":
      return "info";
    case "placed":
      return "neutral";
    case "invoice_rejected":
    case "supplier_rejected":
      return "danger";
    default:
      return "neutral";
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * Seller-only, read-only oversight view of the vendor/backfill restock
 * orders the Replenishment Agent placed on shortfalls (see
 * backend/src/agents/replenishmentAgent.ts, persisted to the
 * restock_orders table). One order per short SKU (see that agent's
 * per-SKU loop) -- there's no consolidated multi-item order today. The
 * actual approve/reject decision on each request belongs to the Supplier
 * persona (see /supplier); this page just lets the Seller track what's
 * been requested, its vendor terms, and any resulting invoice.
 */
export default function ReplenishmentPage() {
  const router = useRouter();
  const { demoMode, userEmail, signOut, role, roleLoading } = useTopbarState();
  const [restockOrders, setRestockOrders] = useState<RestockOrder[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  useEffect(() => {
    if (!roleLoading && role !== "seller") {
      router.replace(role === "supplier" ? "/supplier" : "/dashboard");
    }
  }, [roleLoading, role, router]);

  async function refresh() {
    const [restockRes, invoiceRes] = await Promise.all([apiFetch("/api/restock-orders"), apiFetch("/api/invoices")]);
    if (restockRes.ok) setRestockOrders(await restockRes.json());
    if (invoiceRes.ok) setInvoices(await invoiceRes.json());
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
      .channel("replenishment-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "restock_orders" }, () => refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "invoices" }, () => refresh())
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, []);

  function invoiceFor(restockOrderId: string): Invoice | undefined {
    return invoices.find((inv) => inv.restock_order_id === restockOrderId);
  }

  return (
    <>
      <NavBar demoMode={demoMode} userEmail={userEmail} onSignOut={signOut} role={role} />

      <main className="container">
        <div className="page-heading">
          <h2>Replenishment orders</h2>
          <p>
            Vendor restock ("backfill") orders the Replenishment Agent placed after a shortfall — one
            order per short SKU. The Supplier reviews and approves/rejects each one (see Backfill Orders);
            this is a read-only tracker so you can see what's been requested, its vendor terms, and any
            resulting invoice.
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
            <h3>Restock orders</h3>
            <p className="card-subtext">{restockOrders.length} total</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Vendor order</th>
                <th>SKU</th>
                <th className="num-cell">Qty</th>
                <th className="num-cell">Unit price</th>
                <th className="num-cell">Total cost</th>
                <th>ETA</th>
                <th>Status</th>
                <th>Invoice</th>
              </tr>
            </thead>
            <tbody>
              {restockOrders.map((order) => {
                const invoice = invoiceFor(order.id);
                return (
                  <tr
                    key={order.id}
                    data-clickable="true"
                    data-selected={order.id === selectedOrderId}
                    tabIndex={0}
                    role="button"
                    aria-label={`View replenishment order for ${order.sku}`}
                    onClick={() => setSelectedOrderId(order.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setSelectedOrderId(order.id);
                    }}
                  >
                    <td>{order.vendor_order_id ?? "—"}</td>
                    <td>{order.sku}</td>
                    <td className="num-cell">{order.quantity}</td>
                    <td className="num-cell">{formatCurrency(order.unit_price)}</td>
                    <td className="num-cell">{formatCurrency(order.total_cost)}</td>
                    <td>{order.eta_days != null ? `${order.eta_days}d` : "—"}</td>
                    <td>
                      <span className="status" data-tone={statusTone(order.status)}>
                        {order.status.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td>
                      {invoice ? (
                        <span className="status" data-tone={statusTone(invoice.status)}>
                          {invoice.status} · {formatCurrency(invoice.amount)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
              {loading && restockOrders.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    Loading replenishment orders…
                  </td>
                </tr>
              )}
              {!loading && restockOrders.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty-state">
                    No replenishment orders yet — these appear when a shortfall triggers the Replenishment
                    Agent.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selectedOrderId &&
          (() => {
            const order = restockOrders.find((o) => o.id === selectedOrderId);
            if (!order) return null;
            const invoice = invoiceFor(order.id);
            return (
              <div className="modal-overlay" onClick={() => setSelectedOrderId(null)}>
                <div className="card modal-content" onClick={(e) => e.stopPropagation()}>
                  <div className="card-header">
                    <h3>
                      Replenishment order · <span className="order-number">{order.sku}</span>
                    </h3>
                    <div className="modal-header-actions">
                      <button
                        type="button"
                        className="modal-close"
                        aria-label="Close"
                        onClick={() => setSelectedOrderId(null)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="order-details">
                    <p>
                      <strong>Status:</strong>{" "}
                      <span className="status" data-tone={statusTone(order.status)}>
                        {order.status.replace(/_/g, " ")}
                      </span>
                    </p>
                    {order.status === "placed" && (
                      <p className="demo-banner">
                        <strong>Awaiting Supplier:</strong> this request is still waiting on the Supplier's
                        approve/reject decision.
                      </p>
                    )}

                    <h3>Details</h3>
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
                          <td>{order.vendor_order_id ?? "—"}</td>
                          <td>{order.sku}</td>
                          <td className="num-cell">{order.quantity}</td>
                          <td className="num-cell">{formatCurrency(order.unit_price)}</td>
                          <td className="num-cell">{formatCurrency(order.total_cost)}</td>
                          <td>{order.eta_days != null ? `${order.eta_days}d` : "—"}</td>
                        </tr>
                      </tbody>
                    </table>
                    <p>
                      <strong>Requested:</strong> {formatDateTime(order.created_at)}
                    </p>

                    <h3>Invoice</h3>
                    {!invoice && <p className="empty-state">No invoice generated yet.</p>}
                    {invoice && (
                      <div className="record-row">
                        <span className="status" data-tone={statusTone(invoice.status)}>
                          {invoice.status}
                        </span>{" "}
                        {formatCurrency(invoice.amount)}
                        {invoice.validation_status && (
                          <>
                            {" · "}
                            <span
                              className="status"
                              data-tone={invoice.validation_status === "validated" ? "success" : "warning"}
                              title={invoice.validation_note ?? undefined}
                            >
                              {invoice.validation_status}
                            </span>
                          </>
                        )}
                        {invoice.note && (
                          <>
                            <br />
                            {invoice.note}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
      </main>
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { hasSupabase, supabaseBrowser } from "../lib/supabaseClient";
import { apiFetch } from "../lib/apiClient";
import { useTopbarState } from "../lib/useTopbarState";
import { formatCurrency } from "../lib/format";
import { ChatBot } from "../components/ChatBot";
import { NavBar } from "../components/NavBar";

interface Order {
  id: string;
  order_number?: string;
  raw_request: string;
  status: string;
  total_amount: number | null;
  created_at: string;
  items?: unknown;
  po_number?: string | null;
  po_date?: string | null;
  customer_account_number?: string | null;
}

interface AgentLog {
  id: string;
  order_id: string;
  agent: string;
  action: string;
  detail: string | null;
  created_at: string;
}

interface OrderItem {
  sku: string;
  name?: string;
  quantity: number;
  unitPrice: number;
}

interface AddressInfo {
  companyName: string | null;
  street: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
}

interface OrderDetails {
  order: Order | null;
  customer: {
    id: string;
    name: string;
    email: string;
    billing_address?: AddressInfo | null;
    shipping_address?: AddressInfo | null;
  } | null;
  logs: AgentLog[];
  payments: { id: string; amount: number; status: string; provider_ref: string | null; created_at: string }[];
  shipments: { id: string; carrier: string | null; tracking_number: string | null; status: string; created_at: string }[];
  notifications: { id: string; channel: string; message: string; created_at: string }[];
}

/** Human-readable order number for display (e.g. "ORD-000042"); falls back
 * to a short UUID-derived form if the backend hasn't attached order_number
 * (e.g. legacy rows created before the order_seq migration ran). */
function displayOrderNumber(order: { order_number?: string; id: string }): string {
  return order.order_number ?? `ORD-${order.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

function statusTone(status: string | undefined): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "fulfilled":
    case "completed":
    case "shipped":
    case "approved":
      return "success";
    case "inventory_checked":
    case "paid":
    case "payment_succeeded":
      return "info";
    case "backordered":
    case "pending_approval":
      return "warning";
    case "payment_failed":
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

function statusEmoji(status: string | undefined): string {
  switch (status) {
    case "fulfilled":
    case "shipped":
      return "📦";
    case "completed":
    case "approved":
      return "✅";
    case "inventory_checked":
      return "🔍";
    case "paid":
    case "payment_succeeded":
      return "💸";
    case "backordered":
      return "⏳";
    case "pending_approval":
      return "🕓";
    case "payment_failed":
      return "⚠️";
    case "rejected":
      return "🚫";
    default:
      return "•";
  }
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="status" data-tone="neutral">—</span>;
  return (
    <span className="status" data-tone={statusTone(status)}>
      <span aria-hidden="true">{statusEmoji(status)}</span> {status.replace(/_/g, " ")}
    </span>
  );
}

export default function Dashboard() {
  const router = useRouter();
  const { demoMode, userEmail, signOut, role, roleLoading } = useTopbarState();
  const isSeller = role === "seller";

  // Suppliers never see the Buyer/Seller order screens — the dashboard is
  // Buyer/Seller only, matching the same "can't see anything from the
  // current screens" restriction the Inventory page already enforces (see
  // inventory/page.tsx).
  useEffect(() => {
    if (!roleLoading && role === "supplier") {
      router.replace("/supplier");
    }
  }, [roleLoading, role, router]);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null);
  const [view, setView] = useState<"details" | "timeline">("details");
  const [poFile, setPoFile] = useState<File | null>(null);
  const poFileInputRef = useRef<HTMLInputElement>(null);
  const [poUploading, setPoUploading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [decisioning, setDecisioning] = useState(false);
  const [clearingOrders, setClearingOrders] = useState(false);
  const [stageIndex, setStageIndex] = useState(0);

  // Rough mirror of the backend LangGraph pipeline (PO intake -> inventory ->
  // approval -> payment -> fulfillment -> support) so the upload spinner can
  // cycle through messages that actually match what's happening server-side,
  // instead of a single static "please wait" label for the whole request.
  const PIPELINE_STAGES = [
    "📄 Reading your PO…",
    "🔍 Matching line items to the catalog…",
    "📦 Checking inventory…",
    "💳 Running payment…",
    "🚚 Booking shipment…",
    "✨ Wrapping up…",
  ];

  useEffect(() => {
    if (!poUploading) {
      setStageIndex(0);
      return;
    }
    const id = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, PIPELINE_STAGES.length - 1));
    }, 1700);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poUploading]);

  async function refreshOrders() {
    const res = await apiFetch(`/api/orders`);
    if (res.ok) setOrders(await res.json());
    setOrdersLoading(false);
  }

  async function refreshLogs(orderId: string) {
    const res = await apiFetch(`/api/orders/${orderId}`);
    if (res.ok) {
      const { logs } = await res.json();
      setLogs(logs ?? []);
    }
  }

  async function refreshOrderDetails(orderId: string) {
    const res = await apiFetch(`/api/orders/${orderId}/details`);
    if (res.ok) setOrderDetails(await res.json());
  }

  /** Wipes every order (and dependent payment/shipment/notification/agent
   * log rows) so testing/demoing can start clean — order numbering restarts
   * at ORD-000001 for the next order (see backend routes/orders.ts's
   * DELETE /api/orders). Customer and inventory records are left untouched. */
  async function clearAllOrders() {
    if (!confirm("Clear all orders? This can't be undone and restarts order numbering from ORD-000001.")) {
      return;
    }
    setClearingOrders(true);
    try {
      const res = await apiFetch(`/api/orders`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to clear orders");
        return;
      }
      setSelectedOrderId(null);
      setOrderDetails(null);
      setLogs([]);
      setPoFile(null);
      if (poFileInputRef.current) poFileInputRef.current.value = "";
      await refreshOrders();
    } finally {
      setClearingOrders(false);
    }
  }

  useEffect(() => {
    refreshOrders();

    if (!hasSupabase || !supabaseBrowser) {
      // No Supabase project configured (e.g. zero-config DEMO_MODE run) —
      // poll instead of subscribing to Realtime.
      const interval = setInterval(() => {
        refreshOrders();
        if (selectedOrderId) {
          refreshLogs(selectedOrderId);
          refreshOrderDetails(selectedOrderId);
        }
      }, 2000);
      return () => clearInterval(interval);
    }

    const client = supabaseBrowser;
    const channel = client
      .channel("orders-and-logs")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => {
        refreshOrders();
        if (selectedOrderId) refreshOrderDetails(selectedOrderId);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "agent_logs" }, (payload) => {
        const row = payload.new as AgentLog;
        if (row.order_id === selectedOrderId) {
          refreshLogs(selectedOrderId);
          refreshOrderDetails(selectedOrderId);
        }
      })
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrderId]);

  async function uploadPurchaseOrder(e: React.FormEvent) {
    e.preventDefault();
    if (!poFile) return;
    setPoUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", poFile);

      const res = await apiFetch(`/api/orders/from-po`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedOrderId(data.orderId);
        setPoFile(null);
        if (poFileInputRef.current) poFileInputRef.current.value = "";
        await refreshOrders();
        await refreshLogs(data.orderId);
        await refreshOrderDetails(data.orderId);
      } else {
        alert(data.error ?? "Failed to process purchase order PDF");
      }
    } finally {
      setPoUploading(false);
    }
  }

  async function retryOrder(orderId: string, endpoint: "retry" | "retry-payment" = "retry") {
    setRetrying(true);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/${endpoint}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Failed to retry order");
        return;
      }
      await refreshOrders();
      await refreshLogs(orderId);
      await refreshOrderDetails(orderId);
    } finally {
      setRetrying(false);
    }
  }

  async function decideOrder(orderId: string, decision: "approve" | "reject") {
    setDecisioning(true);
    try {
      const res = await apiFetch(`/api/orders/${orderId}/${decision}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? `Failed to ${decision} order`);
        return;
      }
      await refreshOrders();
      await refreshLogs(orderId);
      await refreshOrderDetails(orderId);
    } finally {
      setDecisioning(false);
    }
  }

  return (
    <>
      <NavBar demoMode={demoMode} userEmail={userEmail} onSignOut={signOut} role={role} />

      <main className="container">
        <div className="page-heading">
          <h2>Purchase order intake</h2>
          <p>
            PO Intake, Inventory, Payment, Fulfillment &amp; Support agents coordinate end-to-end
            order execution via LangGraph, reasoning with NVIDIA Nemotron on Nebius Token Factory.
          </p>
        </div>

        {demoMode && (
          <p className="demo-banner">
            <strong>Demo mode:</strong> no Supabase/Nebius credentials configured on the backend.
            Using an in-memory store and canned agent responses. Set env vars for the live
            pipeline.
          </p>
        )}

        <div className="card upload-card">
          <div className="card-header">
            <h3>Upload purchase order</h3>
          </div>
          <form onSubmit={uploadPurchaseOrder}>
            <label>
              Submit a partner PO as PDF. The PO Intake Agent extracts partner, line items, and
              billing/shipping addresses, and creates or updates the customer record from the
              PO's own billing contact.
            </label>
            <div className="upload-row">
              <input
                type="file"
                accept="application/pdf"
                ref={poFileInputRef}
                onChange={(e) => setPoFile(e.target.files?.[0] ?? null)}
              />
              <button type="submit" disabled={poUploading || !poFile}>
                {poUploading ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Working on it…
                  </>
                ) : (
                  "Upload & place order"
                )}
              </button>
            </div>
            {poUploading && (
              <div className="pipeline-progress" role="status" aria-live="polite">
                <span className="btn-spinner btn-spinner-lg" aria-hidden="true" />
                <div className="pipeline-progress-text">
                  <strong>{PIPELINE_STAGES[stageIndex]}</strong>
                  <span className="card-subtext">
                    Our agents are extracting, checking stock, and processing your order — this can take a
                    little while.
                  </span>
                </div>
              </div>
            )}
          </form>
        </div>

        <div className="workspace">
          <div className="card">
            <div className="card-header">
              <div>
                <h3>Orders</h3>
                <p className="card-subtext">{orders.length} total</p>
              </div>
              {orders.length > 0 && isSeller && (
                <button
                  type="button"
                  className="secondary"
                  onClick={clearAllOrders}
                  disabled={clearingOrders}
                >
                  {clearingOrders ? (
                    <>
                      <span className="btn-spinner" aria-hidden="true" /> Clearing…
                    </>
                  ) : (
                    "Clear all orders"
                  )}
                </button>
              )}
            </div>
            <table className="orders-table">
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "21%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Created</th>
                  <th>PO</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="num-cell">Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr
                    key={order.id}
                    data-clickable="true"
                    data-selected={order.id === selectedOrderId}
                    tabIndex={0}
                    role="button"
                    aria-label={`View order ${displayOrderNumber(order)}`}
                    onClick={() => {
                      setSelectedOrderId(order.id);
                      refreshLogs(order.id);
                      refreshOrderDetails(order.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setSelectedOrderId(order.id);
                      refreshLogs(order.id);
                      refreshOrderDetails(order.id);
                    }}
                  >
                    <td>
                      <span className="order-number">{displayOrderNumber(order)}</span>
                    </td>
                    <td>{new Date(order.created_at).toLocaleDateString()}</td>
                    <td>
                      {order.po_number ?? <span className="empty-state">{order.raw_request}</span>}
                    </td>
                    <td>{order.customer_account_number ?? "—"}</td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td className="num-cell">{formatCurrency(order.total_amount)}</td>
                  </tr>
                ))}
                {ordersLoading && orders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-state">
                      Loading orders ✨
                    </td>
                  </tr>
                )}
                {!ordersLoading && orders.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-state">
                      Nothing here yet — drop a PO above to kick things off 🚀
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {selectedOrderId && (
          <div className="modal-overlay" onClick={() => setSelectedOrderId(null)}>
            <div className="card modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="card-header">
                <h3>
                  Order{" "}
                  <span className="order-number">
                    {orderDetails?.order ? displayOrderNumber(orderDetails.order) : "…"}
                  </span>
                </h3>
                <div className="modal-header-actions">
                  {isSeller && orderDetails?.order?.status === "backordered" && (
                    <button type="button" onClick={() => retryOrder(selectedOrderId)} disabled={retrying}>
                      {retrying ? (
                        <>
                          <span className="btn-spinner" aria-hidden="true" /> Retrying…
                        </>
                      ) : (
                        "Retry now"
                      )}
                    </button>
                  )}
                  {isSeller && orderDetails?.order?.status === "payment_failed" && (
                    <button
                      type="button"
                      onClick={() => retryOrder(selectedOrderId, "retry-payment")}
                      disabled={retrying}
                    >
                      {retrying ? (
                        <>
                          <span className="btn-spinner" aria-hidden="true" /> Retrying payment…
                        </>
                      ) : (
                        "Retry payment"
                      )}
                    </button>
                  )}
                  {isSeller && orderDetails?.order?.status === "pending_approval" && (
                    <>
                      <button
                        type="button"
                        onClick={() => decideOrder(selectedOrderId, "approve")}
                        disabled={decisioning}
                      >
                        {decisioning ? (
                          <>
                            <span className="btn-spinner" aria-hidden="true" /> Working…
                          </>
                        ) : (
                          "Approve"
                        )}
                      </button>
                      <button
                        type="button"
                        className="danger-link"
                        onClick={() => decideOrder(selectedOrderId, "reject")}
                        disabled={decisioning}
                      >
                        {decisioning ? (
                          <>
                            <span className="btn-spinner" aria-hidden="true" /> Working…
                          </>
                        ) : (
                          "Reject"
                        )}
                      </button>
                    </>
                  )}
                  <div className="view-toggle" role="tablist" aria-label="Order view">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "details"}
                      data-active={view === "details"}
                      onClick={() => setView("details")}
                    >
                      Details
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={view === "timeline"}
                      data-active={view === "timeline"}
                      onClick={() => setView("timeline")}
                    >
                      Agent timeline
                    </button>
                  </div>
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

              {view === "details" && (
                <>
                  {!orderDetails ? (
                    <p>Loading order details…</p>
                  ) : (
                    <div className="order-details">
                      <p>
                        <strong>Status:</strong> <StatusBadge status={orderDetails.order?.status} />
                      </p>
                      {orderDetails.order?.status === "pending_approval" && (
                        <p className="demo-banner">
                          <strong>Guardrail hold:</strong> this order's total exceeds the auto-approval
                          threshold and is waiting for a human decision before payment is charged.
                        </p>
                      )}
                      {(orderDetails.order?.po_number ||
                        orderDetails.order?.po_date ||
                        orderDetails.order?.customer_account_number) && (
                        <p>
                          {orderDetails.order?.po_number && (
                            <>
                              <strong>PO number:</strong> {orderDetails.order.po_number}
                              <br />
                            </>
                          )}
                          {orderDetails.order?.po_date && (
                            <>
                              <strong>Date:</strong> {orderDetails.order.po_date}
                              <br />
                            </>
                          )}
                          {orderDetails.order?.customer_account_number && (
                            <>
                              <strong>Customer account:</strong> {orderDetails.order.customer_account_number}
                            </>
                          )}
                        </p>
                      )}

                      {(orderDetails.customer?.billing_address || orderDetails.customer?.shipping_address) && (
                        <div className="address-grid">
                          {orderDetails.customer?.billing_address && (
                            <div className="address-block">
                              <h3>Billing address</h3>
                              <AddressCard address={orderDetails.customer.billing_address} />
                            </div>
                          )}
                          {orderDetails.customer?.shipping_address && (
                            <div className="address-block">
                              <h3>Shipping address</h3>
                              <AddressCard address={orderDetails.customer.shipping_address} />
                            </div>
                          )}
                        </div>
                      )}

                      <h3>Items</h3>
                      <table>
                        <thead>
                          <tr>
                            <th>SKU</th>
                            <th>Name</th>
                            <th className="num-cell">Qty</th>
                            <th className="num-cell">Unit price</th>
                            <th className="num-cell">Subtotal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {((orderDetails.order?.items as OrderItem[] | undefined) ?? []).map((item, i) => (
                            <tr key={i}>
                              <td>{item.sku}</td>
                              <td>{item.name ?? "—"}</td>
                              <td className="num-cell">{item.quantity}</td>
                              <td className="num-cell">{formatCurrency(item.unitPrice)}</td>
                              <td className="num-cell">{formatCurrency(item.quantity * item.unitPrice)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p>
                        <strong>Total:</strong> {formatCurrency(orderDetails.order?.total_amount)}
                      </p>

                      <h3>Payment</h3>
                      {orderDetails.payments.length === 0 && (
                        <p className="empty-state">No payment yet — hang tight 💳</p>
                      )}
                      {orderDetails.payments.map((p) => (
                        <div key={p.id} className="record-row">
                          <StatusBadge status={p.status} /> {formatCurrency(p.amount)} · ref: {p.provider_ref ?? "—"}
                        </div>
                      ))}

                      <h3>Shipment</h3>
                      {orderDetails.shipments.length === 0 && (
                        <p className="empty-state">Not shipped yet — still cooking 📦</p>
                      )}
                      {orderDetails.shipments.map((s) => (
                        <div key={s.id} className="record-row">
                          <StatusBadge status={s.status} /> {s.carrier ?? "carrier TBD"} · tracking:{" "}
                          {s.tracking_number ?? "—"}
                        </div>
                      ))}

                      <h3>Customer notifications</h3>
                      {orderDetails.notifications.length === 0 && (
                        <p className="empty-state">No notifications sent yet 🔕</p>
                      )}
                      {orderDetails.notifications.map((n) => (
                        <div key={n.id} className="log-item">
                          <div className="log-agent">{n.channel}</div>
                          <div>{n.message}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {view === "timeline" && (
                <>
                  {logs.map((log) => (
                    <div key={log.id} className="log-item">
                      <div className="log-agent">
                        {log.agent} · {log.action}
                      </div>
                      <div>{log.detail}</div>
                    </div>
                  ))}
                  {logs.length === 0 && <p className="empty-state">No agent activity yet — the bots are idle 🤖</p>}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      <ChatBot
        defaultEmail={userEmail ?? undefined}
        onOrderSelected={(orderId) => {
          setSelectedOrderId(orderId);
          refreshOrders();
          refreshLogs(orderId);
          refreshOrderDetails(orderId);
        }}
      />
    </>
  );
}

/** Renders a billing/shipping address block extracted from an uploaded PO
 * (company name, street, city/zip/country, and contact phone/email). Any
 * field the PO Intake Agent couldn't find is simply omitted. */
function AddressCard({ address }: { address: AddressInfo }) {
  return (
    <p>
      {address.companyName && (
        <>
          <strong>{address.companyName}</strong>
          <br />
        </>
      )}
      {address.street && (
        <>
          {address.street}
          <br />
        </>
      )}
      {(address.zipCode || address.city) && (
        <>
          {[address.zipCode, address.city].filter(Boolean).join(" ")}
          <br />
        </>
      )}
      {address.country && (
        <>
          {address.country}
          <br />
        </>
      )}
      {address.phone && (
        <>
          Phone: {address.phone}
          <br />
        </>
      )}
      {address.email && <>Email: {address.email}</>}
    </p>
  );
}

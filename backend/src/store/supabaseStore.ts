import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type {
  AgentLogRow,
  CustomerRow,
  DataStore,
  InventoryRow,
  InvoiceRow,
  NotificationRow,
  OrderRow,
  PaymentRow,
  ProfileRow,
  RestockOrderRow,
  ShipmentRow,
} from "./types.js";

// Backend uses the service-role key so agents can read/write across all
// tables (RLS bypass). Never ship this key to the frontend.
//
// Note: this module is imported unconditionally (see ./index.ts), even when
// running in DEMO_MODE with no real credentials, so we fall back to harmless
// placeholder values here purely to satisfy createClient()'s validation —
// this client is never actually invoked unless config.isDemoMode is false.
const supabase = createClient(
  config.supabaseUrl || "http://localhost:54321",
  config.supabaseServiceRoleKey || "demo-mode-placeholder-key",
  { auth: { persistSession: false } }
);

export const supabaseStore: DataStore = {
  async getInventoryCatalog() {
    const { data } = await supabase
      .from("inventory")
      .select("sku, name, quantity_available, unit_price")
      .order("sku", { ascending: true });
    return (data ?? []) as InventoryRow[];
  },

  async getInventoryQuantity(sku) {
    const { data } = await supabase
      .from("inventory")
      .select("quantity_available")
      .eq("sku", sku)
      .single();
    return data ? data.quantity_available : null;
  },

  async reserveInventory(sku, quantity) {
    // Atomic conditional decrement (see
    // supabase/migrations/0007_atomic_inventory_reservation.sql) -- the
    // stock check and the write happen as one database operation, so two
    // concurrent reservations for the same SKU can't both read sufficient
    // stock and both succeed.
    const { data, error } = await supabase.rpc("reserve_inventory", { p_sku: sku, p_qty: quantity });
    if (error) throw error;
    return Boolean(data);
  },

  async releaseInventory(sku, quantity) {
    const { error } = await supabase.rpc("release_inventory", { p_sku: sku, p_qty: quantity });
    if (error) throw error;
  },

  async ensureInventoryItem(sku, name, quantityAvailable, unitPrice) {
    await supabase
      .from("inventory")
      .upsert(
        { sku, name, quantity_available: quantityAvailable, unit_price: unitPrice },
        { onConflict: "sku", ignoreDuplicates: true }
      );
  },

  async upsertInventoryItem(sku, name, quantityAvailable, unitPrice) {
    const { error } = await supabase
      .from("inventory")
      .upsert({ sku, name, quantity_available: quantityAvailable, unit_price: unitPrice }, { onConflict: "sku" });
    if (error) throw error;
  },

  async deleteInventoryItem(sku) {
    const { error } = await supabase.from("inventory").delete().eq("sku", sku);
    if (error) throw error;
  },

  async receiveInventoryStock(sku, quantity) {
    const { error } = await supabase.rpc("receive_inventory_stock", { p_sku: sku, p_qty: quantity });
    if (error) throw error;
  },

  async getOrCreateCustomer(name, email) {
    const { data: existing } = await supabase
      .from("customers")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (existing) return existing;

    const { data: created, error } = await supabase
      .from("customers")
      .insert({ name, email })
      .select("id")
      .single();
    if (error) throw error;
    return created;
  },

  async upsertCustomerAddresses(customerId, addresses) {
    const patch: Record<string, unknown> = {};
    if (addresses.billing !== undefined) patch.billing_address = addresses.billing ?? null;
    if (addresses.shipping !== undefined) patch.shipping_address = addresses.shipping ?? null;
    if (Object.keys(patch).length === 0) return;
    await supabase.from("customers").update(patch).eq("id", customerId);
  },

  async createOrder(order) {
    // order_seq is computed here (rather than left to the `orders` table's
    // bigserial default) so that clearing all orders (see deleteAllOrders)
    // makes numbering start again at 1 — a bigserial's underlying sequence
    // keeps counting up even after every row is deleted, which would leave
    // human-readable order numbers permanently ahead of the actual data.
    const { data: last } = await supabase
      .from("orders")
      .select("order_seq")
      .order("order_seq", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSeq = ((last as { order_seq: number | null } | null)?.order_seq ?? 0) + 1;

    const { data, error } = await supabase
      .from("orders")
      .insert({
        id: order.id,
        customer_id: order.customerId,
        raw_request: order.rawRequest,
        status: "received",
        order_seq: nextSeq,
      })
      .select()
      .single();
    if (error) throw error;
    return { orderSeq: (data as OrderRow | null)?.order_seq ?? null };
  },

  async updateOrder(orderId, patch) {
    await supabase.from("orders").update(patch).eq("id", orderId);
  },

  async insertPayment(payment) {
    await supabase.from("payments").insert({
      order_id: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      provider_ref: payment.providerRef,
    });
  },

  async insertShipment(shipment) {
    const { data } = await supabase
      .from("shipments")
      .insert({
        order_id: shipment.orderId,
        carrier: shipment.carrier,
        tracking_number: shipment.trackingNumber,
        status: shipment.status,
      })
      .select()
      .single();
    return { id: data?.id };
  },

  async insertNotification(notification) {
    await supabase.from("notifications").insert({
      order_id: notification.orderId,
      channel: notification.channel,
      message: notification.message,
    });
  },

  async logAgentStep(orderId, agent, action, detail) {
    const { error } = await supabase
      .from("agent_logs")
      .insert({ order_id: orderId, agent, action, detail });
    if (error) {
      console.error(`Failed to log agent step (${agent}/${action}):`, error.message);
    }
  },

  async listOrders() {
    const { data } = await supabase.from("orders").select("*").order("created_at", { ascending: false });
    return (data ?? []) as OrderRow[];
  },

  async getOrderWithLogs(orderId) {
    const [{ data: order }, { data: logs }] = await Promise.all([
      supabase.from("orders").select("*").eq("id", orderId).single(),
      supabase.from("agent_logs").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
    ]);
    return { order: (order as OrderRow) ?? null, logs: (logs ?? []) as AgentLogRow[] };
  },

  async getOrderDetails(orderId) {
    const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
    const [{ data: customer }, { data: logs }, { data: payments }, { data: shipments }, { data: notifications }] =
      await Promise.all([
        order
          ? supabase.from("customers").select("*").eq("id", (order as OrderRow).customer_id).single()
          : Promise.resolve({ data: null }),
        supabase.from("agent_logs").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
        supabase.from("payments").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
        supabase.from("shipments").select("*").eq("order_id", orderId).order("created_at", { ascending: true }),
        supabase
          .from("notifications")
          .select("*")
          .eq("order_id", orderId)
          .order("created_at", { ascending: true }),
      ]);

    return {
      order: (order as OrderRow) ?? null,
      customer: (customer as CustomerRow) ?? null,
      logs: (logs ?? []) as AgentLogRow[],
      payments: (payments ?? []) as PaymentRow[],
      shipments: (shipments ?? []) as ShipmentRow[],
      notifications: (notifications ?? []) as NotificationRow[],
    };
  },

  async deleteAllOrders() {
    // Child tables carry a not-null FK to orders.id with no cascade, so they
    // must be cleared first. `.neq(id, <impossible uuid>)` is used as a
    // "match everything" filter since PostgREST requires an explicit filter
    // on delete. order_seq resets implicitly: createOrder computes the next
    // sequence number from MAX(order_seq), which is null/0 once the table
    // is empty, so the next created order becomes ORD-000001 again.
    const matchAll = "00000000-0000-0000-0000-000000000000";
    const childResults = await Promise.all([
      supabase.from("agent_logs").delete().neq("order_id", matchAll),
      supabase.from("payments").delete().neq("order_id", matchAll),
      supabase.from("shipments").delete().neq("order_id", matchAll),
      supabase.from("notifications").delete().neq("order_id", matchAll),
    ]);
    const childError = childResults.find((r) => r.error)?.error;
    if (childError) throw childError;

    const { error } = await supabase.from("orders").delete().neq("id", matchAll);
    if (error) throw error;
  },

  async deleteOrder(orderId) {
    const childResults = await Promise.all([
      supabase.from("agent_logs").delete().eq("order_id", orderId),
      supabase.from("payments").delete().eq("order_id", orderId),
      supabase.from("shipments").delete().eq("order_id", orderId),
      supabase.from("notifications").delete().eq("order_id", orderId),
    ]);
    const childError = childResults.find((r) => r.error)?.error;
    if (childError) throw childError;

    const { error } = await supabase.from("orders").delete().eq("id", orderId);
    if (error) throw error;
  },

  async getProfile(userId) {
    const { data } = await supabase.from("profiles").select("*").eq("user_id", userId).maybeSingle();
    return (data as ProfileRow) ?? null;
  },

  async createRestockOrder(restockOrder) {
    const { data, error } = await supabase
      .from("restock_orders")
      .insert({
        order_id: restockOrder.orderId,
        sku: restockOrder.sku,
        quantity: restockOrder.quantity,
        unit_price: restockOrder.unitPrice,
        total_cost: restockOrder.totalCost,
        eta_days: restockOrder.etaDays,
        vendor_order_id: restockOrder.vendorOrderId,
        status: "placed",
      })
      .select()
      .single();
    if (error) throw error;
    return data as RestockOrderRow;
  },

  async listRestockOrders() {
    const { data } = await supabase.from("restock_orders").select("*").order("created_at", { ascending: false });
    return (data ?? []) as RestockOrderRow[];
  },

  async getRestockOrder(id) {
    const { data } = await supabase.from("restock_orders").select("*").eq("id", id).maybeSingle();
    return (data as RestockOrderRow) ?? null;
  },

  async updateRestockOrderStatus(id, status) {
    const { error } = await supabase.from("restock_orders").update({ status }).eq("id", id);
    if (error) throw error;
  },

  async approveRestockOrder(restockOrderId, invoiceAmount, note) {
    const { data, error } = await supabase.rpc("approve_restock_order", {
      p_restock_order_id: restockOrderId,
      p_invoice_amount: invoiceAmount,
      p_invoice_note: note,
    });
    if (error) throw error;
    return Array.isArray(data) ? (data[0] as InvoiceRow | undefined) ?? null : null;
  },

  async createInvoice(invoice) {
    const { data, error } = await supabase
      .from("invoices")
      .insert({
        restock_order_id: invoice.restockOrderId,
        amount: invoice.amount,
        currency: invoice.currency ?? "eur",
        status: "submitted",
        note: invoice.note ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return data as InvoiceRow;
  },

  async listInvoices() {
    const { data } = await supabase.from("invoices").select("*").order("created_at", { ascending: false });
    return (data ?? []) as InvoiceRow[];
  },

  async getInvoice(id) {
    const { data } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
    return (data as InvoiceRow) ?? null;
  },

  async updateInvoiceStatus(id, status, providerRef) {
    const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (providerRef !== undefined) patch.provider_ref = providerRef;
    const { error } = await supabase.from("invoices").update(patch).eq("id", id);
    if (error) throw error;
  },

  async updateInvoiceValidation(id, status, note) {
    const { error } = await supabase
      .from("invoices")
      .update({ validation_status: status, validation_note: note, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  },
};

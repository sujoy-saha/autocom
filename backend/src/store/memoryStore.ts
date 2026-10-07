import { v4 as uuid } from "uuid";
import type {
  AddressInfo,
  AgentLogRow,
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

// Simple process-local store used when no real Supabase credentials are
// configured (see config.isDemoMode). Data does not persist across restarts
// and there is no Realtime — the frontend falls back to polling in this mode.
const inventory = new Map<string, InventoryRow>(
  [
    { sku: "SKU-001", name: "Wireless Mouse", quantity_available: 25, unit_price: 19.99 },
    { sku: "SKU-002", name: "Mechanical Keyboard", quantity_available: 10, unit_price: 89.99 },
    { sku: "SKU-003", name: "USB-C Hub", quantity_available: 0, unit_price: 34.5 },
    { sku: "SKU-004", name: '27" Monitor', quantity_available: 5, unit_price: 249.0 },
  ].map((row) => [row.sku, row])
);

const customers = new Map<
  string,
  { id: string; name: string; email: string; billing_address: AddressInfo | null; shipping_address: AddressInfo | null }
>();
const orders = new Map<string, OrderRow>();
let orderSeqCounter = 0;
const agentLogs: AgentLogRow[] = [];
const payments: PaymentRow[] = [];
const shipments: ShipmentRow[] = [];
const notifications: NotificationRow[] = [];
const profiles = new Map<string, ProfileRow>();
const restockOrders: RestockOrderRow[] = [];
const invoices: InvoiceRow[] = [];

function buildInvoiceRow(invoice: { restockOrderId: string; amount: number; currency?: string; note?: string | null }): InvoiceRow {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    restock_order_id: invoice.restockOrderId,
    amount: invoice.amount,
    currency: invoice.currency ?? "eur",
    status: "submitted",
    validation_status: null,
    validation_note: null,
    provider_ref: null,
    note: invoice.note ?? null,
    created_at: now,
    updated_at: now,
  };
}

export const memoryStore: DataStore = {
  async getInventoryCatalog() {
    return [...inventory.values()].sort((a, b) => a.sku.localeCompare(b.sku));
  },

  async getInventoryQuantity(sku) {
    return inventory.get(sku)?.quantity_available ?? null;
  },

  async reserveInventory(sku, quantity) {
    // Single-threaded JS has no true interleaving here (no await between
    // the check and the write), but kept as a conditional check-and-set for
    // parity with the Supabase store's atomic contract and to guard against
    // accidentally going negative if this is ever refactored to await
    // something mid-function.
    const row = inventory.get(sku);
    if (!row || row.quantity_available < quantity) return false;
    row.quantity_available -= quantity;
    return true;
  },

  async releaseInventory(sku, quantity) {
    const row = inventory.get(sku);
    if (row) row.quantity_available += quantity;
  },

  async ensureInventoryItem(sku, name, quantityAvailable, unitPrice) {
    if (inventory.has(sku)) return;
    inventory.set(sku, { sku, name, quantity_available: quantityAvailable, unit_price: unitPrice });
  },

  async upsertInventoryItem(sku, name, quantityAvailable, unitPrice) {
    inventory.set(sku, { sku, name, quantity_available: quantityAvailable, unit_price: unitPrice });
  },

  async deleteInventoryItem(sku) {
    inventory.delete(sku);
  },

  async receiveInventoryStock(sku, quantity) {
    const row = inventory.get(sku);
    if (row) {
      row.quantity_available += quantity;
    } else {
      inventory.set(sku, { sku, name: sku, quantity_available: quantity, unit_price: 0 });
    }
  },

  async getOrCreateCustomer(name, email) {
    const existing = [...customers.values()].find((c) => c.email === email);
    if (existing) return { id: existing.id };
    const id = uuid();
    customers.set(id, { id, name, email, billing_address: null, shipping_address: null });
    return { id };
  },

  async upsertCustomerAddresses(customerId, addresses) {
    const row = customers.get(customerId);
    if (!row) return;
    if (addresses.billing !== undefined) row.billing_address = addresses.billing ?? null;
    if (addresses.shipping !== undefined) row.shipping_address = addresses.shipping ?? null;
  },

  async createOrder(order) {
    const orderSeq = ++orderSeqCounter;
    orders.set(order.id, {
      id: order.id,
      customer_id: order.customerId,
      raw_request: order.rawRequest,
      items: [],
      status: "received",
      total_amount: null,
      order_seq: orderSeq,
      created_at: new Date().toISOString(),
    });
    return { orderSeq };
  },

  async updateOrder(orderId, patch) {
    const row = orders.get(orderId);
    if (row) Object.assign(row, patch);
  },

  async insertPayment(payment) {
    payments.push({
      id: uuid(),
      order_id: payment.orderId,
      amount: payment.amount,
      status: payment.status,
      provider_ref: payment.providerRef ?? null,
      created_at: new Date().toISOString(),
    });
  },

  async insertShipment(shipment) {
    const id = uuid();
    shipments.push({
      id,
      order_id: shipment.orderId,
      carrier: shipment.carrier ?? null,
      tracking_number: shipment.trackingNumber ?? null,
      status: shipment.status,
      created_at: new Date().toISOString(),
    });
    return { id };
  },

  async insertNotification(notification) {
    notifications.push({
      id: uuid(),
      order_id: notification.orderId,
      channel: notification.channel,
      message: notification.message,
      created_at: new Date().toISOString(),
    });
  },

  async logAgentStep(orderId, agent, action, detail) {
    agentLogs.push({
      id: uuid(),
      order_id: orderId,
      agent,
      action,
      detail: detail ?? null,
      created_at: new Date().toISOString(),
    });
  },

  async listOrders() {
    return [...orders.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },

  async getOrderWithLogs(orderId) {
    return {
      order: orders.get(orderId) ?? null,
      logs: agentLogs.filter((log) => log.order_id === orderId),
    };
  },

  async getOrderDetails(orderId) {
    const order = orders.get(orderId) ?? null;
    const customer = order ? customers.get(order.customer_id) ?? null : null;
    return {
      order,
      customer,
      logs: agentLogs.filter((log) => log.order_id === orderId),
      payments: payments.filter((p) => p.order_id === orderId),
      shipments: shipments.filter((s) => s.order_id === orderId),
      notifications: notifications.filter((n) => n.order_id === orderId),
    };
  },

  async deleteAllOrders() {
    orders.clear();
    orderSeqCounter = 0;
    agentLogs.length = 0;
    payments.length = 0;
    shipments.length = 0;
    notifications.length = 0;
  },

  async deleteOrder(orderId) {
    orders.delete(orderId);
    for (let i = agentLogs.length - 1; i >= 0; i--) if (agentLogs[i].order_id === orderId) agentLogs.splice(i, 1);
    for (let i = payments.length - 1; i >= 0; i--) if (payments[i].order_id === orderId) payments.splice(i, 1);
    for (let i = shipments.length - 1; i >= 0; i--) if (shipments[i].order_id === orderId) shipments.splice(i, 1);
    for (let i = notifications.length - 1; i >= 0; i--)
      if (notifications[i].order_id === orderId) notifications.splice(i, 1);
  },

  async getProfile(userId) {
    return profiles.get(userId) ?? null;
  },

  async createRestockOrder(restockOrder) {
    const row: RestockOrderRow = {
      id: uuid(),
      order_id: restockOrder.orderId,
      sku: restockOrder.sku,
      quantity: restockOrder.quantity,
      unit_price: restockOrder.unitPrice,
      total_cost: restockOrder.totalCost,
      eta_days: restockOrder.etaDays,
      vendor_order_id: restockOrder.vendorOrderId,
      status: "placed",
      created_at: new Date().toISOString(),
    };
    restockOrders.push(row);
    return row;
  },

  async listRestockOrders() {
    return [...restockOrders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },

  async getRestockOrder(id) {
    return restockOrders.find((r) => r.id === id) ?? null;
  },

  async updateRestockOrderStatus(id, status) {
    const row = restockOrders.find((r) => r.id === id);
    if (row) row.status = status;
  },

  async approveRestockOrder(restockOrderId, invoiceAmount, note) {
    const restockOrder = restockOrders.find((row) => row.id === restockOrderId);
    if (!restockOrder || restockOrder.status !== "placed") return null;

    const inventoryRow = inventory.get(restockOrder.sku);
    if (inventoryRow) {
      inventoryRow.quantity_available += restockOrder.quantity;
    } else {
      inventory.set(restockOrder.sku, {
        sku: restockOrder.sku,
        name: restockOrder.sku,
        quantity_available: restockOrder.quantity,
        unit_price: 0,
      });
    }

    restockOrder.status = "invoiced";
    const invoice = buildInvoiceRow({ restockOrderId, amount: invoiceAmount, note });
    invoices.push(invoice);
    return invoice;
  },

  async createInvoice(invoice) {
    const row = buildInvoiceRow(invoice);
    invoices.push(row);
    return row;
  },

  async listInvoices() {
    return [...invoices].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },

  async getInvoice(id) {
    return invoices.find((i) => i.id === id) ?? null;
  },

  async updateInvoiceStatus(id, status, providerRef) {
    const row = invoices.find((i) => i.id === id);
    if (row) {
      row.status = status;
      if (providerRef !== undefined) row.provider_ref = providerRef;
      row.updated_at = new Date().toISOString();
    }
  },

  async updateInvoiceValidation(id, status, note) {
    const row = invoices.find((i) => i.id === id);
    if (row) {
      row.validation_status = status;
      row.validation_note = note;
      row.updated_at = new Date().toISOString();
    }
  },
};

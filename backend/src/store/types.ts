export interface InventoryRow {
  sku: string;
  name: string;
  quantity_available: number;
  unit_price: number;
}

export interface OrderRow {
  id: string;
  customer_id: string;
  raw_request: string;
  items: unknown;
  status: string;
  total_amount: number | null;
  po_number?: string | null;
  po_date?: string | null;
  customer_account_number?: string | null;
  /** Human-readable sequential order number (see utils/orderId.ts's formatOrderNumber). Nullable only for pre-migration legacy rows. */
  order_seq?: number | null;
  created_at: string;
}

export interface AgentLogRow {
  id: string;
  order_id: string;
  agent: string;
  action: string;
  detail: string | null;
  created_at: string;
}

/** A billing or shipping address captured on a customer record (e.g. from
 * an uploaded PO's address blocks — see poParser.ts's ParsedAddress). */
export interface AddressInfo {
  companyName: string | null;
  street: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
}

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  billing_address?: AddressInfo | null;
  shipping_address?: AddressInfo | null;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  amount: number;
  status: string;
  provider_ref: string | null;
  created_at: string;
}

export interface ShipmentRow {
  id: string;
  order_id: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  order_id: string;
  channel: string;
  message: string;
  created_at: string;
}

export interface OrderDetails {
  order: OrderRow | null;
  customer: CustomerRow | null;
  logs: AgentLogRow[];
  payments: PaymentRow[];
  shipments: ShipmentRow[];
  notifications: NotificationRow[];
}

/** Persona role for the current user — see backend/src/middleware/auth.ts's
 * requireRole and the `profiles` table (supabase/migrations/0005_personas.sql). */
export type UserRole = "buyer" | "seller" | "supplier";

export interface ProfileRow {
  user_id: string;
  email: string | null;
  role: UserRole;
  created_at: string;
}

/** A vendor/backfill restock order placed by the Replenishment Agent
 * (agents/replenishmentAgent.ts) against the (simulated) external vendor —
 * persisted so a logged-in Supplier user can see and invoice it. */
export interface RestockOrderRow {
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

/** An invoice a Supplier submits against a restock order for a Seller to
 * review/approve/pay (see services/stripePayment.ts for the Stripe
 * test-mode charge on approval). */
export interface InvoiceRow {
  id: string;
  restock_order_id: string;
  amount: number;
  currency: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paid";
  /** Invoice Validator Agent's verdict (see agents/invoiceValidatorAgent.ts)
   * -- runs automatically the moment an invoice is created, cross-checking
   * its amount against the restock order it's billed against. Null until
   * the validator has run. */
  validation_status: "validated" | "flagged" | null;
  validation_note: string | null;
  provider_ref: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Storage abstraction implemented by both a real Supabase-backed store and
 * an in-memory demo store, so every agent/route works identically in either
 * mode (see config.isDemoMode).
 */
export interface DataStore {
  getInventoryCatalog(): Promise<InventoryRow[]>;
  getInventoryQuantity(sku: string): Promise<number | null>;
  /** Atomically attempts to decrement `sku`'s quantity_available by
   * `quantity` -- the check (enough stock available) and the decrement
   * happen as a single database operation (a conditional UPDATE / Postgres
   * function, see supabase/migrations/0007_atomic_inventory_reservation.sql),
   * so two concurrent reservations for the same SKU can never both read
   * sufficient stock and both succeed. Returns true if the reservation
   * succeeded, false if there wasn't enough stock (the SKU should be
   * treated as backordered; nothing is decremented in that case). */
  reserveInventory(sku: string, quantity: number): Promise<boolean>;
  /** Inverse of reserveInventory -- increments `sku`'s quantity_available
   * back by `quantity`. Used to roll back a reservation made earlier in the
   * same order when a different line item turns out to be short (see
   * agents/inventoryAgent.ts), so a partial shortfall never leaves other
   * SKUs silently held while the order as a whole is backordered. */
  releaseInventory(sku: string, quantity: number): Promise<void>;
  /** Registers a new SKU (e.g. discovered from an uploaded PO) if it doesn't
   * already exist; no-op if the SKU is already known. */
  ensureInventoryItem(sku: string, name: string, quantityAvailable: number, unitPrice: number): Promise<void>;
  /** Creates or fully updates a catalog entry (name/quantity/price) — unlike
   * ensureInventoryItem, this overwrites an existing row. Used by manual
   * inventory management (see routes/inventory.ts). */
  upsertInventoryItem(sku: string, name: string, quantityAvailable: number, unitPrice: number): Promise<void>;
  /** Removes a catalog entry entirely (manual inventory management). No-op
   * if the SKU doesn't exist. Does not touch any past order's own item
   * snapshot (orders.items), only the live catalog. */
  deleteInventoryItem(sku: string): Promise<void>;
  /** Goods receipt: increases a SKU's live `quantity_available` by
   * `quantity` — creates the catalog entry (name defaults to the SKU,
   * price 0) if it doesn't exist yet. Called the moment a Supplier approves
   * a restock ("backfill") request (see routes/restock.ts's `:id/approve`),
   * so the seller's own inventory reflects the incoming stock as soon as
   * it's confirmed shipped — independent of and ahead of the Seller
   * reviewing/paying the invoice, which is a separate billing decision. */
  receiveInventoryStock(sku: string, quantity: number): Promise<void>;

  getOrCreateCustomer(name: string, email: string): Promise<{ id: string }>;
  /** Persists billing/shipping address blocks (e.g. extracted from an
   * uploaded PO) onto an existing customer record. Pass null/undefined for
   * whichever side wasn't found; only the provided sides are updated. */
  upsertCustomerAddresses(
    customerId: string,
    addresses: { billing?: AddressInfo | null; shipping?: AddressInfo | null }
  ): Promise<void>;

  createOrder(order: { id: string; customerId: string; rawRequest: string }): Promise<{ orderSeq: number | null }>;
  updateOrder(
    orderId: string,
    patch: Partial<{
      items: unknown;
      total_amount: number;
      status: string;
      po_number: string | null;
      po_date: string | null;
      customer_account_number: string | null;
    }>
  ): Promise<void>;

  insertPayment(payment: {
    orderId: string;
    amount: number;
    status: string;
    providerRef: string;
  }): Promise<void>;

  insertShipment(shipment: {
    orderId: string;
    carrier: string;
    trackingNumber: string;
    status: string;
  }): Promise<{ id: string }>;

  insertNotification(notification: {
    orderId: string;
    channel: string;
    message: string;
  }): Promise<void>;

  logAgentStep(orderId: string, agent: string, action: string, detail?: string): Promise<void>;

  listOrders(): Promise<OrderRow[]>;
  getOrderWithLogs(orderId: string): Promise<{ order: OrderRow | null; logs: AgentLogRow[] }>;
  /** Full order dashboard view: order + customer + payment/shipment/notification records + agent logs. */
  getOrderDetails(orderId: string): Promise<OrderDetails>;
  /** Deletes every order (and its dependent payments/shipments/notifications/
   * agent_logs rows) and resets order numbering so the next created order
   * starts again at ORD-000001. Customers and inventory are left untouched. */
  deleteAllOrders(): Promise<void>;
  /** Deletes a single order (and its dependent payments/shipments/
   * notifications/agent_logs rows) — used to roll back an order created for
   * intake that ultimately matched no items (see orderService.ts's
   * createOrderFromText), so a message that isn't really an order request
   * never leaves a stray "intake_failed" row behind. Customer/inventory
   * records are left untouched. */
  deleteOrder(orderId: string): Promise<void>;

  /** Looks up a user's persona role by their Supabase Auth user id. Returns
   * null if no profile row exists yet (caller should treat as unassigned/
   * default). */
  getProfile(userId: string): Promise<ProfileRow | null>;

  /** Persists a vendor restock order placed by the Replenishment Agent so a
   * Supplier user can see and invoice it. */
  createRestockOrder(restockOrder: {
    orderId: string | null;
    sku: string;
    quantity: number;
    unitPrice: number;
    totalCost: number;
    etaDays: number | null;
    vendorOrderId: string | null;
  }): Promise<RestockOrderRow>;
  listRestockOrders(): Promise<RestockOrderRow[]>;
  getRestockOrder(id: string): Promise<RestockOrderRow | null>;
  updateRestockOrderStatus(id: string, status: RestockOrderRow["status"]): Promise<void>;
  /** Atomically confirms a Supplier-approved restock, credits its stock, and
   * creates the invoice exactly once. Returns null if it was already handled. */
  approveRestockOrder(restockOrderId: string, invoiceAmount: number, note: string | null): Promise<InvoiceRow | null>;

  /** Creates a Supplier-submitted invoice against a restock order. */
  createInvoice(invoice: { restockOrderId: string; amount: number; currency?: string; note?: string | null }): Promise<InvoiceRow>;
  listInvoices(): Promise<InvoiceRow[]>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  updateInvoiceStatus(id: string, status: InvoiceRow["status"], providerRef?: string | null): Promise<void>;
  /** Records the Invoice Validator Agent's verdict on a just-created invoice. */
  updateInvoiceValidation(id: string, status: InvoiceRow["validation_status"], note: string | null): Promise<void>;
}

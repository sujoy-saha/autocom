"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hasSupabase, supabaseBrowser } from "../lib/supabaseClient";
import { apiFetch } from "../lib/apiClient";
import { useTopbarState } from "../lib/useTopbarState";
import { formatCurrency } from "../lib/format";
import { NavBar } from "../components/NavBar";

interface InventoryItem {
  sku: string;
  name: string;
  quantity_available: number;
  unit_price: number;
}

interface ItemEdit {
  name: string;
  quantity: string;
  price: string;
}

/** Small visual cue next to the stock input so low/zero-stock SKUs stand
 * out at a glance in the catalog table (helps spot what needs restocking
 * without reading every row's number). */
function StockBadge({ quantity }: { quantity: number }) {
  if (quantity <= 0) {
    return (
      <span className="status" data-tone="danger">
        out of stock
      </span>
    );
  }
  if (quantity <= 5) {
    return (
      <span className="status" data-tone="warning">
        low stock
      </span>
    );
  }
  return null;
}

export default function InventoryPage() {
  const router = useRouter();
  const { demoMode, userEmail, signOut, role, roleLoading } = useTopbarState();
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [edits, setEdits] = useState<Record<string, ItemEdit>>({});
  const [savingSku, setSavingSku] = useState<string | null>(null);
  const [newItem, setNewItem] = useState({ sku: "", name: "", quantity: "", price: "" });
  const [creating, setCreating] = useState(false);
  const [deletingSku, setDeletingSku] = useState<string | null>(null);

  // Inventory is Seller-only — Buyers never see it at all and Suppliers get
  // their own dedicated screen. The backend enforces this too (see
  // backend/src/routes/inventory.ts's requireRole("seller")); this is just
  // the UI-side redirect so a buyer/supplier never lands on a page that
  // would just 403 on every request.
  useEffect(() => {
    if (!roleLoading && role !== "seller") {
      router.replace(role === "supplier" ? "/supplier" : "/dashboard");
    }
  }, [roleLoading, role, router]);

  async function refreshInventory() {
    const res = await apiFetch(`/api/inventory`);
    if (res.ok) setInventory(await res.json());
    setInventoryLoading(false);
  }

  useEffect(() => {
    refreshInventory();

    if (!hasSupabase || !supabaseBrowser) {
      // No Supabase project configured — poll instead of subscribing to Realtime.
      const interval = setInterval(refreshInventory, 2000);
      return () => clearInterval(interval);
    }

    const client = supabaseBrowser;
    const channel = client
      .channel("inventory-page")
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory" }, () => refreshInventory())
      .subscribe();

    return () => {
      client.removeChannel(channel);
    };
  }, []);

  function fieldValue(item: InventoryItem, field: keyof ItemEdit): string {
    const edit = edits[item.sku];
    if (edit) return edit[field];
    if (field === "name") return item.name;
    if (field === "quantity") return String(item.quantity_available);
    return String(item.unit_price);
  }

  function setFieldValue(item: InventoryItem, field: keyof ItemEdit, value: string) {
    setEdits((prev) => {
      const current = prev[item.sku] ?? {
        name: item.name,
        quantity: String(item.quantity_available),
        price: String(item.unit_price),
      };
      return { ...prev, [item.sku]: { ...current, [field]: value } };
    });
  }

  async function saveItem(item: InventoryItem) {
    const edit = edits[item.sku];
    const name = edit?.name?.trim() || item.name;
    const quantityAvailable = Number(edit?.quantity ?? item.quantity_available);
    const unitPrice = Number(edit?.price ?? item.unit_price);

    if (Number.isNaN(quantityAvailable) || quantityAvailable < 0) {
      alert("Enter a valid non-negative quantity");
      return;
    }
    if (Number.isNaN(unitPrice) || unitPrice < 0) {
      alert("Enter a valid non-negative unit price");
      return;
    }

    setSavingSku(item.sku);
    try {
      const res = await apiFetch(`/api/inventory/${encodeURIComponent(item.sku)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, quantityAvailable, unitPrice }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Failed to update item");
        return;
      }
      await refreshInventory();
      setEdits((prev) => {
        const next = { ...prev };
        delete next[item.sku];
        return next;
      });
    } finally {
      setSavingSku(null);
    }
  }

  async function createItem(e: React.FormEvent) {
    e.preventDefault();
    const sku = newItem.sku.trim();
    if (!sku) {
      alert("SKU is required");
      return;
    }
    if (inventory.some((i) => i.sku === sku)) {
      alert("That SKU already exists — edit it in the table below instead.");
      return;
    }

    const quantityAvailable = Number(newItem.quantity || "0");
    const unitPrice = Number(newItem.price || "0");
    if (Number.isNaN(quantityAvailable) || quantityAvailable < 0) {
      alert("Enter a valid non-negative quantity");
      return;
    }
    if (Number.isNaN(unitPrice) || unitPrice < 0) {
      alert("Enter a valid non-negative unit price");
      return;
    }

    setCreating(true);
    try {
      const res = await apiFetch(`/api/inventory/${encodeURIComponent(sku)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newItem.name.trim() || sku, quantityAvailable, unitPrice }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Failed to create item");
        return;
      }
      setNewItem({ sku: "", name: "", quantity: "", price: "" });
      await refreshInventory();
    } finally {
      setCreating(false);
    }
  }

  async function deleteItem(item: InventoryItem) {
    if (!confirm(`Remove SKU "${item.sku}" (${item.name}) from the catalog? This can't be undone.`)) return;
    setDeletingSku(item.sku);
    try {
      const res = await apiFetch(`/api/inventory/${encodeURIComponent(item.sku)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error ?? "Failed to remove item");
        return;
      }
      await refreshInventory();
    } finally {
      setDeletingSku(null);
    }
  }

  return (
    <>
      <NavBar demoMode={demoMode} userEmail={userEmail} onSignOut={signOut} role={role} />

      <main className="container">
        <div className="page-heading">
          <h2>Inventory management</h2>
          <p>
            View and update stock levels and prices, or register a brand-new catalog SKU by hand —
            the same catalog the Inventory Agent checks and auto-provisions against.
          </p>
        </div>

        {demoMode && (
          <p className="demo-banner">
            <strong>Demo mode:</strong> no Supabase credentials configured on the backend. Using an
            in-memory catalog that resets on backend restart.
          </p>
        )}

        <div className="card upload-card">
          <div className="card-header">
            <h3>Add new SKU</h3>
          </div>
          <form onSubmit={createItem}>
            <div className="upload-row" style={{ flexWrap: "wrap" }}>
              <input
                placeholder="SKU"
                value={newItem.sku}
                onChange={(e) => setNewItem((p) => ({ ...p, sku: e.target.value }))}
              />
              <input
                placeholder="Name"
                value={newItem.name}
                onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
              />
              <input
                type="number"
                min={0}
                placeholder="Quantity"
                style={{ width: "7rem" }}
                value={newItem.quantity}
                onChange={(e) => setNewItem((p) => ({ ...p, quantity: e.target.value }))}
              />
              <label className="input-prefix">
                <span>€</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Unit price"
                  style={{ width: "7rem" }}
                  value={newItem.price}
                  onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))}
                />
              </label>
              <button type="submit" disabled={creating}>
                {creating ? "Adding…" : "Add SKU"}
              </button>
            </div>
          </form>
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Catalog</h3>
            <p className="card-subtext">
              {inventory.length} SKUs · Total value:{" "}
              {formatCurrency(inventory.reduce((sum, i) => sum + i.quantity_available * i.unit_price, 0))}
            </p>
          </div>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Name</th>
                <th>Unit price</th>
                <th>Stock</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((item) => (
                <tr key={item.sku}>
                  <td>{item.sku}</td>
                  <td>
                    <input
                      value={fieldValue(item, "name")}
                      onChange={(e) => setFieldValue(item, "name", e.target.value)}
                    />
                  </td>
                  <td>
                    <label className="input-prefix">
                      <span>€</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        style={{ width: "6rem" }}
                        value={fieldValue(item, "price")}
                        onChange={(e) => setFieldValue(item, "price", e.target.value)}
                      />
                    </label>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      style={{ width: "5rem" }}
                      value={fieldValue(item, "quantity")}
                      onChange={(e) => setFieldValue(item, "quantity", e.target.value)}
                    />{" "}
                    <StockBadge quantity={item.quantity_available} />
                  </td>
                  <td>
                    <button type="button" onClick={() => saveItem(item)} disabled={savingSku === item.sku}>
                      {savingSku === item.sku ? "Saving…" : "Save"}
                    </button>{" "}
                    <button
                      type="button"
                      className="danger-link"
                      onClick={() => deleteItem(item)}
                      disabled={deletingSku === item.sku}
                    >
                      {deletingSku === item.sku ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
              {inventoryLoading && inventory.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-state">
                    Loading catalog…
                  </td>
                </tr>
              )}
              {!inventoryLoading && inventory.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-state">
                    No inventory items yet — add one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}

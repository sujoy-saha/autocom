import { Router } from "express";
import { db } from "../store/index.js";
import { requireRole } from "../middleware/auth.js";

export const inventoryRouter = Router();

// Full catalog — SKU, name, quantity available, unit price. Seller-only:
// buyers can't see inventory at all (see routes/orders.ts for the same
// requireRole gate on mutating order actions).
inventoryRouter.get("/", requireRole("seller"), async (_req, res) => {
  try {
    const items = await db.getInventoryCatalog();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Creates a SKU (if new) or fully updates it (if it already exists) —
// manual counterpart to the agents' auto-provisioning, for restocking after
// a backorder or registering a brand-new catalog item by hand.
inventoryRouter.put("/:sku", requireRole("seller"), async (req, res) => {
  const { sku } = req.params;
  const { name, quantityAvailable, unitPrice } = req.body ?? {};

  if (typeof quantityAvailable !== "number" || Number.isNaN(quantityAvailable) || quantityAvailable < 0) {
    return res.status(400).json({ error: "quantityAvailable must be a non-negative number" });
  }

  try {
    const existing = (await db.getInventoryCatalog()).find((item) => item.sku === sku);
    const resolvedName = typeof name === "string" && name.trim() ? name : (existing?.name ?? sku);
    const resolvedUnitPrice = typeof unitPrice === "number" && !Number.isNaN(unitPrice) ? unitPrice : (existing?.unit_price ?? 0);

    await db.upsertInventoryItem(sku, resolvedName, quantityAvailable, resolvedUnitPrice);
    res.json({ sku, name: resolvedName, quantity_available: quantityAvailable, unit_price: resolvedUnitPrice });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Removes a catalog entry entirely. Doesn't touch any past order's own
// item snapshot — only the live catalog the Inventory Agent checks against.
inventoryRouter.delete("/:sku", requireRole("seller"), async (req, res) => {
  try {
    await db.deleteInventoryItem(req.params.sku);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuid } from "uuid";

interface VendorCatalogItem {
  sku: string;
  vendorStock: number;
  wholesaleUnitCost: number;
  leadTimeDays: number;
}

/**
 * A separate, external-looking system: an independent supplier's own stock
 * and pricing, deliberately kept in a completely separate in-memory store
 * from our own `inventory` table (backend/src/store). We have no direct
 * database access into this "company" — only the tools its MCP server
 * chooses to expose, the same as we'd have with a real third-party vendor's
 * API. This is what makes the Replenishment Agent (agents/replenishmentAgent.ts)
 * a genuine agent-to-agent commerce interaction rather than another view onto
 * our own data.
 */
const vendorCatalog = new Map<string, VendorCatalogItem>(
  [
    { sku: "SKU-001", vendorStock: 200, wholesaleUnitCost: 11.5, leadTimeDays: 2 },
    { sku: "SKU-002", vendorStock: 40, wholesaleUnitCost: 52.0, leadTimeDays: 3 },
    { sku: "SKU-003", vendorStock: 15, wholesaleUnitCost: 19.75, leadTimeDays: 5 },
    { sku: "SKU-004", vendorStock: 8, wholesaleUnitCost: 165.0, leadTimeDays: 7 },
    { sku: "23423423", vendorStock: 100, wholesaleUnitCost: 115.0, leadTimeDays: 7 },
    { sku: "45645645", vendorStock: 15, wholesaleUnitCost: 52.0, leadTimeDays: 7 },
  ].map((item) => [item.sku, item])
);

interface VendorRestockOrder {
  vendorOrderId: string;
  sku: string;
  quantity: number;
  /** Unit price actually charged — the vendor's list price for orders
   * placed via `place_restock_order`, or a negotiated price for orders
   * placed via `finalize_restock_order` (see negotiateFloorUnitPrice). */
  unitPrice: number;
  totalCost: number;
  etaDays: number;
  placedAt: string;
}

/**
 * Computes this vendor's hidden bulk-discount floor unit price for a given
 * quantity — the most it will ever come down off `wholesaleUnitCost` (its
 * list price) in a negotiation, however low the buyer's opening offer is.
 * Bigger orders unlock a bigger discount, mirroring real wholesale
 * bulk-pricing tiers. Purely deterministic/stateless so `propose_restock_order`
 * needs no server-side negotiation session state.
 */
function negotiateFloorUnitPrice(listUnitPrice: number, quantity: number): number {
  const maxDiscountPct = quantity >= 50 ? 0.15 : quantity >= 20 ? 0.1 : quantity >= 10 ? 0.05 : 0.02;
  return Math.round(listUnitPrice * (1 - maxDiscountPct) * 100) / 100;
}

/** Rush-surcharge multiplier applied to the negotiated unit price when the
 * buyer asks for a faster-than-standard lead time (still within what the
 * vendor can accommodate — see `resolveLeadTime`). */
const RUSH_SURCHARGE_MULTIPLIER = 1.08;

/**
 * Resolves the actual lead time (and whether a rush surcharge applies) for
 * a requested `targetLeadTimeDays` against this SKU's standard lead time.
 * The vendor will rush an order down to (standard − 2 days, floor 1 day)
 * for a surcharge; anything faster than that gets capped at that minimum
 * instead of refused outright, so negotiation always converges.
 */
function resolveLeadTime(
  standardLeadTimeDays: number,
  targetLeadTimeDays: number | undefined
): { leadTimeDays: number; rushSurcharge: boolean } {
  if (targetLeadTimeDays === undefined || targetLeadTimeDays >= standardLeadTimeDays) {
    return { leadTimeDays: standardLeadTimeDays, rushSurcharge: false };
  }
  const minLeadTimeDays = Math.max(1, standardLeadTimeDays - 2);
  return { leadTimeDays: Math.max(targetLeadTimeDays, minLeadTimeDays), rushSurcharge: true };
}

/** Every restock order this vendor has accepted from us, purely for
 * `get_vendor_order_status` lookups — an audit trail on the vendor's side,
 * separate from our own `agent_logs`. */
const vendorOrders: VendorRestockOrder[] = [];

/**
 * The vendor/supplier's own MCP server — a standalone system a real
 * external company would run and expose to its buyers, wired up here as a
 * second, independent MCP server (see mcp/vendorClient.ts) alongside our
 * own catalog server (mcp/server.ts). Buyer-side agents (Replenishment
 * Agent) only ever see this system through these tools, never through
 * direct database access, mirroring how a real B2B integration would work.
 */
export function createVendorMcpServer(): McpServer {
  const server = new McpServer({ name: "acme-vendor-supplier", version: "0.1.0" });

  server.registerTool(
    "get_vendor_catalog",
    {
      title: "List vendor catalog",
      description: "Returns every SKU this vendor can supply, with their stock level, wholesale unit cost, and lead time in days.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: JSON.stringify([...vendorCatalog.values()]) }] })
  );

  server.registerTool(
    "check_vendor_stock",
    {
      title: "Check vendor stock for a SKU",
      description: "Looks up a single SKU in the vendor's own stock system. Returns null if the vendor doesn't carry that SKU at all.",
      inputSchema: { sku: z.string() },
    },
    async ({ sku }) => {
      const item = vendorCatalog.get(sku);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              item
                ? { sku, vendorStock: item.vendorStock, wholesaleUnitCost: item.wholesaleUnitCost, leadTimeDays: item.leadTimeDays }
                : { sku, vendorStock: null }
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "place_restock_order",
    {
      title: "Place a restock order with the vendor",
      description:
        "Autonomously places a purchase order against the vendor for the given SKU/quantity. Fulfills as much as the " +
        "vendor's current stock allows (may be a partial fill) and returns a vendor order id, total cost, and lead " +
        "time in days. Returns an error if the vendor doesn't carry this SKU at all.",
      inputSchema: { sku: z.string(), quantity: z.number().int().positive() },
    },
    async ({ sku, quantity }) => {
      const item = vendorCatalog.get(sku);
      if (!item) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Vendor does not carry SKU ${sku}` }) }] };
      }

      const fulfilledQuantity = Math.min(item.vendorStock, quantity);
      item.vendorStock -= fulfilledQuantity;

      const order: VendorRestockOrder = {
        vendorOrderId: `V-${uuid().slice(0, 8)}`,
        sku,
        quantity: fulfilledQuantity,
        unitPrice: item.wholesaleUnitCost,
        totalCost: fulfilledQuantity * item.wholesaleUnitCost,
        etaDays: item.leadTimeDays,
        placedAt: new Date().toISOString(),
      };
      vendorOrders.push(order);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              ...order,
              requestedQuantity: quantity,
              shortBy: quantity - fulfilledQuantity,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "propose_restock_order",
    {
      title: "Propose/negotiate a restock order with the vendor (non-binding)",
      description:
        "Negotiation step, not a commitment: without targetUnitPrice/targetLeadTimeDays, returns a non-binding quote " +
        "(list price, available quantity, standard lead time). With a targetUnitPrice, the vendor either accepts it " +
        "(status 'accepted') or counters with its best price for this quantity (status 'countered') — bigger " +
        "quantities unlock a bigger discount off list price, so it's worth negotiating harder on large orders. With " +
        "a targetLeadTimeDays faster than standard, the vendor accommodates it down to a minimum (with a rush " +
        "surcharge on the price) or counters with that minimum lead time. Call this as many times as needed, then " +
        "commit with finalize_restock_order once terms are agreed.",
      inputSchema: {
        sku: z.string(),
        quantity: z.number().int().positive(),
        targetUnitPrice: z.number().positive().optional(),
        targetLeadTimeDays: z.number().int().positive().optional(),
      },
    },
    async ({ sku, quantity, targetUnitPrice, targetLeadTimeDays }) => {
      const item = vendorCatalog.get(sku);
      if (!item) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Vendor does not carry SKU ${sku}` }) }] };
      }

      const availableQty = Math.min(item.vendorStock, quantity);
      const shortBy = quantity - availableQty;
      const { leadTimeDays, rushSurcharge } = resolveLeadTime(item.leadTimeDays, targetLeadTimeDays);

      if (targetUnitPrice === undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                status: "quote",
                sku,
                availableQty,
                shortBy,
                listUnitPrice: item.wholesaleUnitCost,
                leadTimeDays,
              }),
            },
          ],
        };
      }

      const floorUnitPrice = negotiateFloorUnitPrice(item.wholesaleUnitCost, quantity);
      const effectiveFloor = rushSurcharge ? Math.round(floorUnitPrice * RUSH_SURCHARGE_MULTIPLIER * 100) / 100 : floorUnitPrice;

      if (targetUnitPrice >= effectiveFloor) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                status: "accepted",
                sku,
                unitPrice: targetUnitPrice,
                availableQty,
                shortBy,
                leadTimeDays,
                rushSurcharge,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              status: "countered",
              sku,
              counterUnitPrice: effectiveFloor,
              availableQty,
              shortBy,
              leadTimeDays,
              rushSurcharge,
              note: "This is our best price for this quantity.",
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "finalize_restock_order",
    {
      title: "Finalize a negotiated restock order",
      description:
        "Commits a restock order at previously negotiated terms (see propose_restock_order) — decrements vendor " +
        "stock and records the order at the agreed unit price and lead time, rather than list price. Call exactly " +
        "once per SKU, after negotiation has converged.",
      inputSchema: {
        sku: z.string(),
        quantity: z.number().int().positive(),
        agreedUnitPrice: z.number().positive(),
        agreedLeadTimeDays: z.number().int().positive(),
      },
    },
    async ({ sku, quantity, agreedUnitPrice, agreedLeadTimeDays }) => {
      const item = vendorCatalog.get(sku);
      if (!item) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Vendor does not carry SKU ${sku}` }) }] };
      }

      const fulfilledQuantity = Math.min(item.vendorStock, quantity);
      item.vendorStock -= fulfilledQuantity;

      const order: VendorRestockOrder = {
        vendorOrderId: `V-${uuid().slice(0, 8)}`,
        sku,
        quantity: fulfilledQuantity,
        unitPrice: agreedUnitPrice,
        totalCost: fulfilledQuantity * agreedUnitPrice,
        etaDays: agreedLeadTimeDays,
        placedAt: new Date().toISOString(),
      };
      vendorOrders.push(order);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              ...order,
              requestedQuantity: quantity,
              shortBy: quantity - fulfilledQuantity,
            }),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_vendor_order_status",
    {
      title: "Get vendor restock order status",
      description: "Looks up a previously placed vendor restock order by its vendor order id.",
      inputSchema: { vendorOrderId: z.string() },
    },
    async ({ vendorOrderId }) => {
      const order = vendorOrders.find((o) => o.vendorOrderId === vendorOrderId);
      return { content: [{ type: "text", text: JSON.stringify(order ?? { error: "Unknown vendor order id" }) }] };
    }
  );

  return server;
}

import { db } from "../store/index.js";
import { config } from "../config.js";
import { callVendorTool } from "../mcp/vendorClient.js";
import { callMcpTool } from "../mcp/client.js";
import { completeJsonWithVendorMcpTools } from "../llm/nebiusClient.js";
import { supplierAgentReceiveRestockOrder } from "./supplierAgent.js";
import type { OrderState } from "../graph/state.js";

interface VendorRestockResult {
  ok: boolean;
  error?: string;
  vendorOrderId?: string;
  sku?: string;
  quantity?: number;
  unitPrice?: number;
  totalCost?: number;
  etaDays?: number;
  requestedQuantity?: number;
  shortBy?: number;
}

/** Nemotron's final negotiated-order summary — see negotiateRestockOrder. */
interface NegotiatedRestockResult extends VendorRestockResult {
  listUnitPrice?: number;
  savingsPct?: number;
}

/**
 * Runs a bounded Nemotron negotiation against the vendor's MCP tools
 * (propose_restock_order / finalize_restock_order) for a single short SKU:
 * check the vendor's standing quote, haggle toward the vendor's best
 * quantity-tiered price without accepting a slower-than-standard lead
 * time, then commit exactly once with finalize_restock_order. Throws if
 * Nemotron exhausts its round budget without finalizing, or returns
 * malformed JSON — callers should catch and fall back to the deterministic
 * `place_restock_order` path (a negotiation hiccup must never block
 * sourcing stock).
 */
async function negotiateRestockOrder(
  orderId: string,
  sku: string,
  quantity: number
): Promise<{ result: NegotiatedRestockResult; toolCallsMade: string[] }> {
  const { result, toolCallsMade } = await completeJsonWithVendorMcpTools<NegotiatedRestockResult>(
    `Negotiate and place a restock order with the vendor for SKU "${sku}", quantity ${quantity}.\n\n` +
      `Steps:\n` +
      `1. Call propose_restock_order with just sku/quantity (no targetUnitPrice) to see the vendor's ` +
      `standing list price, standard lead time, and available quantity.\n` +
      `2. Negotiate by calling propose_restock_order again with a targetUnitPrice below list price. If the ` +
      `vendor counters, you may try again with a price between your last offer and its counter, but never ` +
      `exceed ${config.replenishmentMaxNegotiationRounds} total propose_restock_order calls. Larger quantities ` +
      `tend to unlock bigger discounts, so don't be shy about asking for a meaningful discount on bulk orders — ` +
      `but never demand a lead time faster than the vendor's standard lead time unless you're willing to accept ` +
      `the rush surcharge that comes with it.\n` +
      `3. Once you and the vendor have converged on a price and lead time (either the vendor accepted your ` +
      `offer, or you accept its counter), call finalize_restock_order exactly once with those agreed terms to ` +
      `commit the order. Never call finalize_restock_order before you have an agreed price from a propose_restock_order response.\n` +
      `4. Return strict JSON only, matching finalize_restock_order's result plus two extra fields: ` +
      `{"ok": boolean, "vendorOrderId": string, "sku": string, "quantity": number, "unitPrice": number, ` +
      `"totalCost": number, "etaDays": number, "requestedQuantity": number, "shortBy": number, ` +
      `"listUnitPrice": number, "savingsPct": number}, where listUnitPrice is the vendor's original list price ` +
      `from step 1 and savingsPct is the percentage saved off it ((listUnitPrice - unitPrice) / listUnitPrice * 100). ` +
      `If the vendor can't supply the SKU at all, return {"ok": false, "error": string} instead.`,
    {
      system:
        "You are the Replenishment Agent's negotiation module for a multi-agent order management system. " +
        "You negotiate restock orders with an external vendor's MCP tools on behalf of our company, trying to " +
        "minimize cost without accepting worse delivery terms than standard. Always respond with strict JSON only.",
    },
    config.replenishmentMaxNegotiationRounds
  );

  if (!toolCallsMade.includes("finalize_restock_order")) {
    throw new Error("Negotiation ended without finalizing an order");
  }

  return { result, toolCallsMade };
}

interface WebSearchToolResult {
  results?: { title: string; url: string; content: string }[];
}

/**
 * When our simulated vendor can't fully cover a SKU, searches the web for a
 * real alternative supplier as a sourcing lead for a human to follow up on.
 * Purely additive — returns an empty string (no lead found/search
 * unconfigured) rather than failing the agent step.
 */
async function findAlternativeSupplierLead(sku: string, itemName: string | undefined): Promise<string> {
  try {
    const raw = await callMcpTool("web_search", {
      query: `buy ${itemName ?? sku} (SKU ${sku}) supplier wholesale`,
      maxResults: 2,
    });
    const { results } = JSON.parse(raw) as WebSearchToolResult;
    if (!results || results.length === 0) return "";
    const leads = results.map((r) => `${r.title} (${r.url})`).join("; ");
    return ` Alternative supplier leads: ${leads}.`;
  } catch {
    return "";
  }
}

/**
 * Replenishment Agent: runs whenever Inventory finds a shortfall, instead of
 * leaving the order as a silent dead-end backorder. Acts as a genuine
 * buyer-side agent: for each short SKU, it calls an *external* vendor's own
 * MCP server (mcp/vendorServer.ts, reached via the separate
 * mcp/vendorClient.ts client/server boundary — a different "company's"
 * system from our own catalog tools) to autonomously place a restock order.
 *
 * When Nemotron is configured (!config.isDemoLlm), it doesn't just accept
 * the vendor's list price — it runs a bounded multi-round negotiation
 * (see negotiateRestockOrder) against the vendor's propose_restock_order /
 * finalize_restock_order tools, aiming for a lower unit price without
 * trading away lead time. In demo mode (or if the negotiation loop fails
 * for any reason — exhausted rounds, malformed output, network error), it
 * falls back to the original deterministic one-shot `place_restock_order`
 * call, which always pays list price — a negotiation hiccup must never
 * block sourcing stock.
 *
 * This does not fulfill the *current* order — the vendor's stock still has
 * to physically arrive, so the order stays `backordered` and a human uses
 * the existing inventory admin page + "Retry now" once it does. What it
 * replaces is the silent gap in the manual process: today, sourcing more
 * stock from a vendor after a shortfall is a phone call or email nobody is
 * guaranteed to make. Here, it's automatic and logged the moment the
 * shortfall is detected.
 *
 * When the vendor can't fully cover a SKU (outright failure, or a partial
 * fulfillment that's still short), it also runs a live web search (Tavily,
 * via the `web_search` MCP tool) for a real alternative supplier and logs
 * the lead alongside the vendor outcome — a human sourcing gap that
 * previously had no automated fallback at all.
 */
export async function replenishmentAgent(state: OrderState): Promise<Partial<OrderState>> {
  const notes: string[] = [];

  for (const sku of state.backorderedSkus) {
    const item = state.items.find((i) => i.sku === sku);
    const quantity = item?.quantity ?? 1;

    let result: NegotiatedRestockResult | undefined;
    let negotiated = false;

    if (!config.isDemoLlm) {
      try {
        const negotiation = await negotiateRestockOrder(state.orderId, sku, quantity);
        result = negotiation.result;
        negotiated = true;
        await db.logAgentStep(
          state.orderId,
          "replenishment",
          "negotiation_tool_calls",
          `${sku}: Nemotron negotiated with the vendor using ${negotiation.toolCallsMade.join(", ")}.`
        );
      } catch (err) {
        await db.logAgentStep(
          state.orderId,
          "replenishment",
          "negotiation_failed",
          `${sku}: Nemotron negotiation failed (${(err as Error).message}) — falling back to list-price restock order.`
        );
      }
    }

    try {
      if (!result) {
        const raw = await callVendorTool("place_restock_order", { sku, quantity });
        result = JSON.parse(raw) as NegotiatedRestockResult;
      }

      if (!result.ok) {
        const lead = await findAlternativeSupplierLead(sku, item?.name);
        notes.push(`${sku}: vendor could not fulfill (${result.error ?? "unknown error"}).${lead}`);
        continue;
      }

      const shortBy = result.shortBy && result.shortBy > 0 ? result.shortBy : 0;
      const shortfallNote = shortBy > 0
        ? ` — vendor could only supply ${result.quantity}/${result.requestedQuantity}, still ${shortBy} short`
        : "";
      const savingsNote =
        negotiated && result.savingsPct && result.savingsPct > 0
          ? ` (negotiated ${result.savingsPct.toFixed(1)}% off list price €${result.listUnitPrice?.toFixed(2)}/unit)`
          : "";
      // Even on a partial fulfillment, a real alternative supplier could
      // cover the remaining shortfall, so search for one too.
      const lead = shortBy > 0 ? await findAlternativeSupplierLead(sku, item?.name) : "";
      notes.push(
        `${sku}: placed vendor restock order ${result.vendorOrderId} for ${result.quantity} unit(s) ` +
          `(€${(result.totalCost ?? 0).toFixed(2)}${savingsNote}), ETA ${result.etaDays} day(s)${shortfallNote}.${lead}`
      );

      // Persist the restock order so a logged-in Supplier persona can see
      // this "backfill" order and submit an invoice against it (see
      // routes/restock.ts, routes/invoices.ts) — purely additive, never
      // blocks the replenishment flow itself.
      try {
        const restockOrder = await db.createRestockOrder({
          orderId: state.orderId,
          sku,
          quantity: result.quantity ?? quantity,
          unitPrice: result.unitPrice ?? 0,
          totalCost: result.totalCost ?? 0,
          etaDays: result.etaDays ?? null,
          vendorOrderId: result.vendorOrderId ?? null,
        });
        // Hand off to the Supplier Agent, which registers the request and
        // waits for a human Supplier to approve/reject it (see
        // routes/restock.ts) before any invoice can be generated.
        await supplierAgentReceiveRestockOrder(restockOrder);
      } catch (err) {
        console.error(`Failed to persist restock order for ${sku}:`, (err as Error).message);
      }
    } catch (err) {
      const lead = await findAlternativeSupplierLead(sku, item?.name);
      notes.push(`${sku}: vendor restock request failed (${(err as Error).message}).${lead}`);
    }
  }

  await db.logAgentStep(
    state.orderId,
    "replenishment",
    "vendor_restock_requested",
    notes.length > 0
      ? notes.join(" ")
      : "No backordered SKUs to source from the vendor."
  );

  return {};
}

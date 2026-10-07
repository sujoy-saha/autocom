import { db } from "../store/index.js";
import { config } from "../config.js";
import { completeJson } from "../llm/nemotron.js";
import type { OrderLineItem } from "../graph/state.js";
import type { InventoryRow } from "../store/types.js";

export interface ChatExtractionResult {
  items: OrderLineItem[];
  totalAmount: number;
  extractionMethod: "nemotron" | "regex-fallback";
  /** Fragments of the message that couldn't be matched to any catalog item, surfaced back to the caller/bot. */
  unmatchedText: string[];
}

interface RawMatch {
  sku: string;
  quantity: number;
}

/**
 * Deterministic fallback: splits the message into comma/"and"/newline/semicolon
 * separated segments, pulls a leading quantity (defaulting to 1) off each, and
 * matches the remainder against the catalog by case-insensitive substring on
 * name or exact SKU. Segments that don't match anything are reported back as
 * unmatched rather than silently dropped.
 */
function fallbackParse(message: string, catalog: InventoryRow[]): { matches: RawMatch[]; unmatchedText: string[] } {
  const segments = message
    .split(/,|\band\b|\n|;/gi)
    .map((s) => s.trim())
    .filter(Boolean);

  const matches: RawMatch[] = [];
  const unmatchedText: string[] = [];

  for (const segment of segments) {
    const qtyMatch = segment.match(/^(\d+)\s*(?:x|×)?\s*/i);
    const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    const remainder = segment.slice(qtyMatch?.[0]?.length ?? 0).trim().toLowerCase();

    const found = catalog.find(
      (item) =>
        remainder.length > 0 &&
        (item.sku.toLowerCase() === remainder ||
          item.name.toLowerCase().includes(remainder) ||
          remainder.includes(item.name.toLowerCase()))
    );

    if (found) {
      matches.push({ sku: found.sku, quantity });
    } else if (remainder.length > 0) {
      unmatchedText.push(segment);
    }
  }

  return { matches, unmatchedText };
}

/**
 * Asks Nemotron to match the message's requested items against the live
 * catalog, embedded directly in the prompt as plain text. Deliberately does
 * NOT use the MCP tool-calling loop (unlike poIntakeAgent) — this function is
 * reachable from the `place_order` MCP tool itself (see mcp/server.ts), so
 * looping back through the MCP client here would mean an MCP tool handler
 * recursively driving MCP tool calls against its own server. Passing the
 * (small) catalog inline keeps this intake path simple and self-contained.
 * Returns null (letting the caller fall back to the deterministic parser) if
 * the model call fails or matches nothing.
 */
async function llmExtract(message: string, catalog: InventoryRow[]): Promise<RawMatch[] | null> {
  try {
    const catalogText = catalog
      .map((c) => `${c.sku}: ${c.name} — €${c.unit_price} (available: ${c.quantity_available})`)
      .join("\n");
    const parsed = await completeJson<{ items: { sku: string; quantity: number }[] }>(
      `Live product catalog:\n${catalogText}\n\n` +
        `Customer message: "${message}"\n\n` +
        `First, decide whether this message actually expresses intent to purchase/order items — as opposed to ` +
        `a general question (e.g. asking about price, availability, or policy) that merely mentions a product ` +
        `by name without asking to buy it. If there is no genuine purchase intent, return {"items": []}. ` +
        `Otherwise, match the items the customer is asking to order against the catalog above by SKU or name. ` +
        `Only return SKUs that exist in the catalog above — never invent a SKU. Infer a reasonable quantity ` +
        `for each item (default 1 if unstated). Return strict JSON matching this shape: ` +
        `{"items": [{"sku": string, "quantity": number}]}. No markdown, no commentary — JSON only.`,
      {
        system:
          "You are the chat order-intake agent for AutoCom, a B2B order-automation platform. You match a customer's " +
          "plain-English order request against the live product catalog. Always respond with strict JSON only.",
      }
    );
    return parsed.items?.length ? parsed.items : null;
  } catch {
    return null;
  }
}

/**
 * Extracts requested items from a free-text order message (e.g. a web chat
 * bot request), matched against the *live* inventory catalog. Unlike PO
 * intake, unknown SKUs are never auto-provisioned here — this channel orders
 * against our own catalog rather than parsing an externally authored
 * document, so an unmatched request is reported back rather than invented.
 * Prefers Nemotron, falling back to a deterministic keyword matcher in
 * DEMO_MODE or if the model call fails/returns nothing.
 */
export async function extractOrderFromText(orderId: string, message: string): Promise<ChatExtractionResult> {
  const catalog = await db.getInventoryCatalog();

  const llmMatches = config.isDemoLlm ? null : await llmExtract(message, catalog);
  const usedLlm = llmMatches !== null;
  const { matches, unmatchedText } = usedLlm
    ? { matches: llmMatches!.filter((m) => catalog.some((c) => c.sku === m.sku)), unmatchedText: [] as string[] }
    : fallbackParse(message, catalog);

  const items: OrderLineItem[] = matches
    .map((m): OrderLineItem | null => {
      const catalogItem = catalog.find((c) => c.sku === m.sku);
      if (!catalogItem) return null;
      return {
        sku: catalogItem.sku,
        name: catalogItem.name,
        quantity: m.quantity,
        unitPrice: catalogItem.unit_price,
      };
    })
    .filter((item): item is OrderLineItem => item !== null);

  const totalAmount = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const extractionMethod: ChatExtractionResult["extractionMethod"] = usedLlm ? "nemotron" : "regex-fallback";

  await db.logAgentStep(
    orderId,
    "intake",
    "chat_order_parsed",
    `Parsed chat order via ${extractionMethod}: ${items.length} item(s) matched` +
      `${unmatchedText.length > 0 ? `, ${unmatchedText.length} fragment(s) unmatched (${unmatchedText.join("; ")})` : ""}, ` +
      `total €${totalAmount.toFixed(2)}.`
  );

  return { items, totalAmount, extractionMethod, unmatchedText };
}

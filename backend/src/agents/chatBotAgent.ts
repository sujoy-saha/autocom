import { db } from "../store/index.js";
import { callMcpTool } from "../mcp/client.js";
import { completeText } from "../llm/nemotron.js";
import { createOrderFromPdf } from "../services/orderService.js";
import { formatOrderNumber } from "../utils/orderId.js";
import type { OrderDetails } from "../store/types.js";

export interface ChatBotInput {
  message: string;
  customerEmail?: string;
  customerName?: string;
  file?: { buffer: Buffer; name: string };
}

export interface ChatBotReply {
  message: string;
  orderId?: string;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ORDER_NUMBER_RE = /\bORD-?0*(\d{1,10})\b/i;
const SHORT_ID_RE = /#?([0-9a-f]{6,8})\b/i;
const STATUS_KEYWORDS = /\b(status|track|tracking|where.?s|shipped|shipment|delivered|arrive)\b/i;

// Phrased as a question (interrogative) rather than a request/statement —
// "What's the price of the Wireless Mouse?" or "Do you have USB-C hubs in
// stock?" should never place an order, even though they mention a catalog
// item by name (see looksLikeOrderRequest's doc comment for why that used
// to happen).
const QUESTION_RE =
  /^(what|which|how|why|when|where|who|whom|is|are|am|can|could|do|does|did|would|will|shall|should|may|might)\b/i;

// Explicit purchase intent — if present, treat the message as an order
// request even if it's phrased as a question ("can I order 2 mice?" should
// still place an order).
const ORDER_INTENT_RE =
  /\b(order|buy|purchase|i'?d like|i would like|i want|i need|get me|send me|ship me|add .* to (?:my )?(?:cart|order))\b/i;

// A quantity immediately followed by a word — "2 wireless mice", "3x
// keyboards" — the clearest possible signal of actual order content.
const QUANTITY_ITEM_RE = /\b\d+\s*(?:x|×)?\s*[a-z]/i;

const CATALOG_KEYWORDS = /\b(catalog|inventory|in stock|available|price|cost|how much|what do you (?:sell|have|carry))\b/i;

/** True if any catalog item is plausibly referenced by name/SKU/significant
 * word (e.g. "monitor" for '27" Monitor', not just an exact full-name
 * substring match) — used to detect actual item content in a message. */
function mentionsCatalogItem(message: string, catalog: { sku: string; name: string }[]): boolean {
  const lower = message.toLowerCase();
  return catalog.some((item) => {
    if (lower.includes(item.sku.toLowerCase())) return true;
    if (lower.includes(item.name.toLowerCase())) return true;
    // Also match on any single significant word from the item's name (e.g.
    // "monitor", "keyboard") so "I'd like to buy a monitor" still counts,
    // even though it doesn't contain the catalog's exact '27" Monitor' string.
    const words = item.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    return words.some((w) => new RegExp(`\\b${w}\\b`, "i").test(lower));
  });
}

/**
 * Distinguishes an actual order request ("2 wireless mice and a keyboard",
 * "I'd like to buy a monitor") from anything else — a general question that
 * merely mentions a product ("what's the price of the wireless mouse?",
 * "do you have any USB-C hubs?"), an imperative info request with no order
 * verb ("show me the catalog"), or a bare capability question with no item
 * content at all ("can I place an order now?"). Previously *every*
 * non-status, non-greeting message was routed straight to the `place_order`
 * MCP tool, which just matches any catalog item name/SKU mentioned in the
 * text with no notion of purchase intent — so any of the above silently
 * created an order (successfully, or as an empty "intake_failed" row).
 *
 * Requires actual item content (a quantity+word pattern, or a plausible
 * catalog item mention) as a baseline — a bare order verb with nothing else
 * ("can I place an order now?") is *not* enough on its own, since there's
 * nothing yet to actually order. Once item content is present, a question
 * with no explicit purchase-intent verb ("what's the price of X?") is still
 * excluded, so mentioning a product to ask about it doesn't order it.
 */
function looksLikeOrderRequest(message: string, catalog: { sku: string; name: string }[]): boolean {
  const hasItemContent = QUANTITY_ITEM_RE.test(message) || mentionsCatalogItem(message, catalog);
  if (!hasItemContent) return false;

  const isQuestion = QUESTION_RE.test(message) || message.trim().endsWith("?");
  if (isQuestion && !ORDER_INTENT_RE.test(message)) return false;

  return true;
}

/**
 * Answers a general question instead of placing an order: looks for any
 * catalog item mentioned by name/SKU and reports its price/availability: if
 * the message is asking about the catalog in general (or nothing matched),
 * falls back to a short catalog summary or the help message.
 */
async function respondToQuestion(message: string, catalog: { sku: string; name: string; unit_price: number; quantity_available: number }[]): Promise<string> {
  const lower = message.toLowerCase();

  if (ORDER_INTENT_RE.test(message)) {
    // Order-intent verb present ("can I place an order now?") but no actual
    // item content — prompt for specifics instead of attempting an empty order.
    return 'Sure! Tell me what you\'d like to order, e.g. "2 wireless mice and a mechanical keyboard".';
  }

  const matches = catalog.filter(
    (item) => lower.includes(item.name.toLowerCase()) || lower.includes(item.sku.toLowerCase())
  );

  if (matches.length > 0) {
    return matches
      .map(
        (item) =>
          `**${item.name}** (${item.sku}): €${item.unit_price}, ${item.quantity_available > 0 ? `${item.quantity_available} in stock` : "currently out of stock"}.`
      )
      .join(" ");
  }

  if (CATALOG_KEYWORDS.test(message)) {
    const summary = catalog
      .slice(0, 10)
      .map((item) => `${item.name} (€${item.unit_price}, ${item.quantity_available} in stock)`)
      .join(", ");
    return `Here's what we currently have: ${summary}${catalog.length > 10 ? ", and more" : ""}. Ask me to order any of these, or ask about a specific item.`;
  }

  const webAnswer = await answerFromWebSearch(message);
  if (webAnswer) return webAnswer;

  return (
    "I'm not sure how to answer that — I can tell you about our catalog (prices/stock), place an order, " +
    'or check on an existing order\'s status. Try something like "how much is the Wireless Mouse?" or ' +
    '"2 wireless mice and a mechanical keyboard".'
  );
}

interface WebSearchToolResult {
  results?: { title: string; url: string; content: string }[];
}

/**
 * Last-resort fallback for a general question the catalog/order tools have
 * no answer for (shipping policy, carrier info, product questions, etc.):
 * searches the live web via the `web_search` MCP tool and asks Nemotron to
 * synthesize a short, cited reply from the results. Returns null (falls
 * through to the generic help message) if search is unconfigured or turns
 * up nothing usable.
 */
async function answerFromWebSearch(message: string): Promise<string | null> {
  const raw = await callMcpTool("web_search", { query: message, maxResults: 3 }).catch(() => null);
  if (!raw) return null;

  const { results } = JSON.parse(raw) as WebSearchToolResult;
  if (!results || results.length === 0) return null;

  const sources = results.map((r, i) => `[${i + 1}] ${r.title} (${r.url}): ${r.content}`).join("\n");
  const answer = await completeText(
    `Customer question: "${message}"\n\nWeb search results:\n${sources}\n\n` +
      "Using only the information above, write a short (2-3 sentence) helpful answer for the customer. " +
      "If the results don't actually answer the question, say you're not sure rather than guessing.",
    {
      system:
        "You are Ace, AutoCom's customer support chat assistant. Be concise, friendly, and only state facts " +
        "supported by the provided search results.",
      temperature: 0.3,
    }
  );

  return answer.trim() || null;
}

/** Finds an order id mentioned in the message: preferably the human-readable
 * order number (e.g. "ORD-000042" or just "#42"), falling back to a full
 * UUID or its short "#a1b2c3d4" prefix form for backwards compatibility. */
async function findOrderId(message: string): Promise<string | null> {
  const uuidMatch = message.match(UUID_RE);
  if (uuidMatch) return uuidMatch[0];

  const orderNumberMatch = message.match(ORDER_NUMBER_RE);
  if (orderNumberMatch) {
    const seq = Number(orderNumberMatch[1]);
    const orders = await db.listOrders();
    const found = orders.find((o) => o.order_seq === seq);
    if (found) return found.id;
  }

  const shortMatch = message.match(SHORT_ID_RE);
  if (shortMatch) {
    const prefix = shortMatch[1].toLowerCase();
    const orders = await db.listOrders();
    const found = orders.find((o) => o.id.toLowerCase().startsWith(prefix));
    if (found) return found.id;
  }
  return null;
}

function formatStatusReply(details: OrderDetails): string {
  if (!details.order) {
    return "I couldn't find an order with that ID — could you double check it? It looks like `ORD-000042` (or, for older orders, the first few characters of the order ID, e.g. `#a1b2c3d4`).";
  }
  const { order, payments, shipments, notifications } = details;
  const orderNumber = formatOrderNumber(order.order_seq, order.id);
  const payment = payments[payments.length - 1];
  const shipment = shipments[shipments.length - 1];

  let reply = `Order ${orderNumber} is currently **${order.status.replace(/_/g, " ")}**`;
  reply += order.total_amount != null ? ` (total €${order.total_amount}).` : ".";

  if (payment) {
    reply += ` Payment ${payment.status}${payment.provider_ref ? ` (ref ${payment.provider_ref})` : ""}.`;
  }
  if (shipment) {
    reply +=
      ` Shipment ${shipment.status}` +
      `${shipment.carrier ? ` via ${shipment.carrier}` : ""}` +
      `${shipment.tracking_number ? `, tracking number **${shipment.tracking_number}**` : ""}.`;
  } else if (order.status === "backordered") {
    reply += " It's currently backordered — we'll ship as soon as stock is replenished.";
  } else {
    reply += " Not shipped yet.";
  }

  if (notifications.length > 0) {
    reply += ` Latest update sent to the customer: "${notifications[notifications.length - 1].message.slice(0, 180)}${notifications[notifications.length - 1].message.length > 180 ? "…" : ""}"`;
  }

  return reply;
}

interface PlaceOrderToolResult {
  orderId: string;
  orderNumber: string;
  items: { sku: string; name?: string; quantity: number; unitPrice: number }[];
  totalAmount: number;
  extractionMethod: "nemotron" | "regex-fallback";
  unmatchedText: string[];
  status: string;
}

function formatPlaceOrderReply(order: PlaceOrderToolResult): string {
  if (order.items.length === 0) {
    return (
      "I couldn't match any items in that request to our catalog" +
      (order.unmatchedText.length > 0 ? ` (didn't recognize: ${order.unmatchedText.join(", ")})` : "") +
      `. Could you rephrase, e.g. "2 Wireless Mouse"? No order was placed.`
    );
  }
  const itemsText = order.items.map((i) => `${i.quantity}× ${i.name ?? i.sku} (€${i.unitPrice})`).join(", ");
  return (
    `Order ${order.orderNumber} placed: ${itemsText} — total €${order.totalAmount.toFixed(2)}. ` +
    `Status: **${order.status.replace(/_/g, " ")}**. Ask me for "status of ${order.orderNumber}" any time to check on it.`
  );
}

function formatPdfReply(outcome: Awaited<ReturnType<typeof createOrderFromPdf>>): string {
  if ("error" in outcome) return `I couldn't process that PDF: ${outcome.error}`;
  const status = (outcome.result.status as string | undefined) ?? "received";
  return (
    `Got your purchase order${outcome.parsed.poNumber ? ` #${outcome.parsed.poNumber}` : ""}` +
    `${outcome.parsed.vendorName ? ` from ${outcome.parsed.vendorName}` : ""}. ` +
    `Created order ${outcome.orderNumber} (parsed via ${outcome.extractionMethod}), status: **${status.replace(/_/g, " ")}**. ` +
    `Ask me for "status of ${outcome.orderNumber}" any time to check on it.`
  );
}

const HELP_MESSAGE =
  "Hi, I'm Ace, your AutoCom assistant. I can help with a few things:\n" +
  "• Upload a purchase-order PDF and I'll extract it and place the order.\n" +
  '• Tell me what to order in plain English, e.g. "2 wireless mice and a mechanical keyboard".\n' +
  '• Ask about an existing order, e.g. "status of ORD-000042" or "where is my order".';

/**
 * The web chat bot's single entry point. Routes each turn to one of three
 * intake channels — all backed by the same agents/pipeline used elsewhere
 * in the app:
 *   - PDF attached            -> createOrderFromPdf (services/orderService)
 *   - order-status/tracking   -> `get_order_status` MCP tool
 *   - anything else           -> `place_order` MCP tool (free-text intake)
 * The two MCP tool calls go through the real MCP client (mcp/client.ts) —
 * the same in-process client/server boundary the PO Intake Agent uses —
 * rather than calling the underlying service functions directly, so the
 * bot is a genuine MCP client of this app's own tool surface.
 */
export async function respondToChat(input: ChatBotInput): Promise<ChatBotReply> {
  const { message, customerEmail, customerName, file } = input;

  if (file) {
    const outcome = await createOrderFromPdf({
      fileBuffer: file.buffer,
      fileName: file.name,
      customerName,
      customerEmail,
    });
    return {
      message: formatPdfReply(outcome),
      orderId: "error" in outcome ? undefined : outcome.orderId,
    };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { message: HELP_MESSAGE };
  }

  const mentionedOrderId = await findOrderId(trimmed);
  if (mentionedOrderId || STATUS_KEYWORDS.test(trimmed)) {
    if (!mentionedOrderId) {
      return {
        message:
          "Sure — which order? Give me the order ID (or its short form, e.g. `#a1b2c3d4`) and I'll look it up.",
      };
    }
    const raw = await callMcpTool("get_order_status", { orderId: mentionedOrderId });
    const details = JSON.parse(raw) as OrderDetails;
    return { message: formatStatusReply(details), orderId: mentionedOrderId };
  }

  if (/^(hi|hello|hey|help)\b/i.test(trimmed)) {
    return { message: HELP_MESSAGE };
  }

  const catalog = await db.getInventoryCatalog();
  if (!looksLikeOrderRequest(trimmed, catalog)) {
    return { message: await respondToQuestion(trimmed, catalog) };
  }

  if (!customerEmail) {
    return {
      message: "Sure — what's your email address, so I can attach this order to your account?",
    };
  }

  const raw = await callMcpTool("place_order", { customerEmail, customerName, message: trimmed });
  const order = JSON.parse(raw) as PlaceOrderToolResult;
  return { message: formatPlaceOrderReply(order), orderId: order.items.length > 0 ? order.orderId : undefined };
}

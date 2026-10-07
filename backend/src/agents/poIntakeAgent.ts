import pdfParse from "pdf-parse";
import { db } from "../store/index.js";
import { config } from "../config.js";
import { completeJsonWithMcpTools } from "../llm/nebiusClient.js";
import {
  parsePurchaseOrderText,
  extractItemsFromPositions,
  extractAddressesFromPositions,
  type ParsedPurchaseOrder,
  type ParsedPoItem,
  type PositionedTextItem,
} from "./poParser.js";
import type { OrderLineItem } from "../graph/state.js";

export interface PoIntakeResult {
  items: OrderLineItem[];
  totalAmount: number;
  parsed: ParsedPurchaseOrder;
  extractionMethod: "nemotron" | "regex-fallback";
}

/**
 * Re-implements pdf-parse's default `render_page` text-joining (join text
 * items with "\n" whenever the y-transform changes from the previous item,
 * otherwise concatenate directly — see node_modules/pdf-parse/lib/pdf-parse.js)
 * so the existing plain-text regexes (item table, vendor name, subtotal/total)
 * keep working unmodified, while *also* collecting each item's raw (x, y)
 * position into `positionedItems`. Needed because this PO template's
 * billing/shipping address blocks are drawn in an order that doesn't match
 * visual reading order in the content stream — plain joined text jumbles
 * labels and values across columns, but x/y position reliably reconstructs
 * the true two-column layout (see poParser.ts's extractAddressesFromPositions).
 */
function makePageRenderer(positionedItems: PositionedTextItem[]) {
  return async (pageData: any) => {
    const textContent = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let lastY: number | undefined;
    let text = "";
    for (const item of textContent.items) {
      if (typeof item.str !== "string") continue;
      const x = item.transform[4];
      const y = item.transform[5];
      if (item.str.trim().length > 0) positionedItems.push({ str: item.str, x, y });
      if (lastY === undefined || lastY === y) {
        text += item.str;
      } else {
        text += "\n" + item.str;
      }
      lastY = y;
    }
    return text;
  };
}

/**
 * Asks Nemotron (via Nebius Token Factory) to extract structured PO data
 * straight from the raw PDF text, with access to our MCP server's
 * `check_inventory`/`list_inventory` tools so it can cross-reference each
 * line item's SKU against the live catalog while it works, rather than
 * extracting blind. More robust than the regex parser to PO layouts other
 * than the specific template it was tuned against. Returns null (letting
 * the caller fall back to regex) if the model call fails or returns no
 * usable line items.
 */
async function llmExtractPurchaseOrder(
  orderId: string,
  text: string
): Promise<ParsedPurchaseOrder | null> {
  try {
    const { result, toolCallsMade } = await completeJsonWithMcpTools<ParsedPurchaseOrder>(
      `Raw text extracted from a purchase order PDF:\n\n${text}\n\n` +
        `You may use the check_inventory/list_inventory MCP tools to see whether an item number ` +
        `already exists in our catalog (useful context, but still extract whatever items/prices ` +
        `the PO itself states — trust the document, not the catalog, for pricing and quantities). ` +
        `Note the raw text may interleave/reorder labels and values from a two-column billing/shipping ` +
        `address layout (e.g. "IMPORTER OF RECORD / INVOICE TO ADDRESS" on the left, "DELIVERY TO / PLACE ` +
        `OF COLLECTION" on the right) — use context and field labels (Company name, Street with number, ` +
        `City, Zip code, Country, Contact phone number, Contact mail) to correctly assign each value to the ` +
        `right address block. ` +
        `Return strict JSON matching this shape: {"poNumber": string|null, "poDate": string|null, ` +
        `"vendorName": string|null, "customerAccountNumber": string|null, ` +
        `"billingAddress": {"companyName": string|null, "street": string|null, "city": string|null, ` +
        `"zipCode": string|null, "country": string|null, "contactPhone": string|null, "contactEmail": string|null}|null, ` +
        `"shippingAddress": {"companyName": string|null, "street": string|null, "city": string|null, ` +
        `"zipCode": string|null, "country": string|null, "contactPhone": string|null, "contactEmail": string|null}|null, ` +
        `"items": [{"itemNumber": string|null, "description": string, ` +
        `"quantity": number, "unitPrice": number, "total": number}], "subtotal": number|null, "total": number|null}. ` +
        `Use null for anything you can't find. For "itemNumber" specifically: only use a value that appears ` +
        `directly next to/associated with that line item's description in the ITEM#/DESCRIPTION table — never ` +
        `guess, invent, or reuse a number from an unrelated part of the document (e.g. a phone number, account ` +
        `number, or another line item's own item number) just to fill the field. If a line item has no item ` +
        `number printed for it, return null rather than fabricating one — a stable placeholder will be derived ` +
        `from its description instead. No markdown, no commentary — JSON only.`,
      {
        system:
          "You are the PO Intake Agent for a multi-agent order management system. " +
          "You extract structured purchase-order data (vendor, PO number, date, billing/shipping " +
          "addresses, priced line items) from noisy raw text extracted from a PDF. Always respond with strict JSON only.",
      }
    );
    if (toolCallsMade.length > 0) {
      await db.logAgentStep(orderId, "intake", "mcp_tool_calls", `Nemotron used MCP tools: ${toolCallsMade.join(", ")}`);
    }
    return result.items?.length ? result : null;
  } catch {
    return null;
  }
}

/**
 * Derives a stable, deterministic fallback SKU from a line item's
 * description when no item number can be established for that line at all
 * (neither the LLM nor the positionally-verified layout extraction found
 * one — see reconcileItemsWithPositions). Deterministic so re-uploading the same
 * PO (or any PO with the same product description) always maps to the
 * *same* catalog SKU instead of auto-provisioning a fresh, ever-growing
 * pile of near-duplicate SKUs for what is really the same product.
 */
function stableFallbackSku(description: string): string {
  const slug = description
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "MISC-ITEM";
}

/**
 * Overrides the LLM's extracted item numbers with the ones found by the
 * deterministic positional/layout extractor (see poParser.ts's
 * extractItemsFromPositions), matched by description. The LLM is reliable
 * for parsing loosely-structured fields (addresses, vendor, dates) but has
 * been observed to hallucinate a plausible-looking item number (borrowed
 * from an unrelated field elsewhere in the document, or invented outright)
 * when it's uncertain — inconsistently, across otherwise-identical runs on
 * the exact same PDF. The positional extractor reads the same printed
 * ITEM#/DESCRIPTION table directly from PDF layout coordinates, so it's
 * 100% deterministic for a given document, and is trusted over the LLM
 * whenever it identifies a matching row.
 *
 * Also overrides quantity/unitPrice/total the same way, for the same
 * reason: this template often renders adjacent QTY/UNIT PRICE/TOTAL cells
 * with no separating whitespace in the raw text stream (e.g. "15" and
 * "150.00" become "15150.00"), which has been observed to make the LLM
 * misread a single merged number as the quantity (with a garbage unit
 * price) instead of the correct qty/price pair. The positional extractor
 * reads each cell from its own distinct (x, y) text run, so it never
 * merges columns this way and is trusted over the LLM here too.
 */
function reconcileItemsWithPositions(items: ParsedPoItem[], positionedItems: PositionedTextItem[]): ParsedPoItem[] {
  if (!positionedItems.length) return items;

  const groundTruth = extractItemsFromPositions(positionedItems).items;
  if (groundTruth.length === 0) return items;

  const normalize = (s: string) => s.trim().toLowerCase();
  const byDescription = new Map(groundTruth.map((g) => [normalize(g.description), g]));

  const applyGroundTruth = (item: ParsedPoItem, truth: ParsedPoItem): ParsedPoItem => ({
    ...item,
    itemNumber: truth.itemNumber,
    quantity: truth.quantity,
    unitPrice: truth.unitPrice,
    total: truth.total,
  });

  return items.map((item, i) => {
    const matched = byDescription.get(normalize(item.description));
    if (matched) return applyGroundTruth(item, matched);
    // Descriptions didn't line up exactly (e.g. the LLM paraphrased one),
    // but the row counts match — fall back to matching by position.
    if (groundTruth.length === items.length && groundTruth[i]) {
      return applyGroundTruth(item, groundTruth[i]);
    }
    return item;
  });
}

/**
 * Extracts structured data (vendor, PO #, billing/shipping addresses, and
 * priced line items) from an uploaded purchase-order PDF, preferring
 * Nemotron (falling back to a deterministic regex/positional parser in
 * DEMO_MODE or if the model call fails). Pure extraction only — does not
 * touch the order/customer records, since the caller needs this data
 * *before* it knows which customer to attach the order to (the billing
 * address's company name/email are used as the customer's identity — see
 * routes/orders.ts).
 */
export async function extractPurchaseOrder(orderId: string, pdfBuffer: Buffer): Promise<PoIntakeResult> {
  const positionedItems: PositionedTextItem[] = [];
  const { text } = await pdfParse(pdfBuffer, { pagerender: makePageRenderer(positionedItems) });

  const llmParsed = config.isDemoLlm ? null : await llmExtractPurchaseOrder(orderId, text);
  // Like item numbers/quantities/prices (see reconcileItemsWithPositions), the Customer Account
  // Number is a literal header field the LLM has been observed to
  // hallucinate (borrowing a plausible-looking number from elsewhere in the
  // document) rather than extract verbatim. The positional layout extractor
  // reads this field directly off its printed "Customer Account Number:"
  // label, so it's trusted over the LLM whenever it finds one.
  const positionalAddresses = positionedItems.length ? extractAddressesFromPositions(positionedItems) : null;
  const reconciledLlmParsed = llmParsed
    ? {
        ...llmParsed,
        items: reconcileItemsWithPositions(llmParsed.items, positionedItems),
        customerAccountNumber: positionalAddresses?.customerAccountNumber ?? llmParsed.customerAccountNumber,
      }
    : null;
  const parsed = reconciledLlmParsed ?? parsePurchaseOrderText(text, positionedItems);
  const extractionMethod: PoIntakeResult["extractionMethod"] = llmParsed ? "nemotron" : "regex-fallback";

  const items: OrderLineItem[] = parsed.items.map((item) => ({
    sku: item.itemNumber?.trim() || stableFallbackSku(item.description),
    name: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
  }));

  const totalAmount =
    parsed.total ?? parsed.subtotal ?? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  return { items, totalAmount, parsed, extractionMethod };
}

/**
 * Persists a previously-extracted PO result (see `extractPurchaseOrder`)
 * onto the order (items, total, PO #/date/customer account number) and the
 * given customer record (billing/shipping addresses), and logs both steps
 * to the agent timeline.
 */
export async function persistPurchaseOrder(
  orderId: string,
  customerId: string,
  result: PoIntakeResult
): Promise<void> {
  const { parsed, items, totalAmount, extractionMethod } = result;

  await db.updateOrder(orderId, {
    items,
    total_amount: totalAmount,
    status: "inventory_pending",
    po_number: parsed.poNumber,
    po_date: parsed.poDate,
    customer_account_number: parsed.customerAccountNumber,
  });

  if (parsed.billingAddress || parsed.shippingAddress) {
    const toAddressInfo = (addr: ParsedPurchaseOrder["billingAddress"]) =>
      addr && {
        companyName: addr.companyName,
        street: addr.street,
        city: addr.city,
        zipCode: addr.zipCode,
        country: addr.country,
        phone: addr.contactPhone,
        email: addr.contactEmail,
      };
    await db.upsertCustomerAddresses(customerId, {
      billing: toAddressInfo(parsed.billingAddress),
      shipping: toAddressInfo(parsed.shippingAddress),
    });
    await db.logAgentStep(
      orderId,
      "intake",
      "customer_addresses_updated",
      `Updated customer record with${parsed.billingAddress ? ` billing (${parsed.billingAddress.companyName ?? "unknown company"})` : ""}` +
        `${parsed.billingAddress && parsed.shippingAddress ? " and" : ""}` +
        `${parsed.shippingAddress ? ` shipping (${parsed.shippingAddress.companyName ?? "unknown company"})` : ""} address(es) extracted from the PO.`
    );
  }

  await db.logAgentStep(
    orderId,
    "intake",
    "po_parsed",
    `Parsed uploaded PO${parsed.poNumber ? ` #${parsed.poNumber}` : ""}` +
      `${parsed.vendorName ? ` from ${parsed.vendorName}` : ""} via ${extractionMethod}: ` +
      `${items.length} line item(s), total €${totalAmount.toFixed(2)}.`
  );
}


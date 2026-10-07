export interface ParsedPoItem {
  /** The item's own catalog/SKU number as printed on the PO — null if the
   * document genuinely doesn't state one for this line (see
   * poIntakeAgent.ts's stableFallbackSku for how that's then handled). */
  itemNumber: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** A billing or shipping address block, as extracted from a PO's "Company
 * name / Street with number / City / Zip code / Country / Contact phone
 * number / Contact mail" form fields. */
export interface ParsedAddress {
  companyName: string | null;
  street: string | null;
  city: string | null;
  zipCode: string | null;
  country: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

export interface ParsedPurchaseOrder {
  poNumber: string | null;
  poDate: string | null;
  vendorName: string | null;
  customerAccountNumber: string | null;
  billingAddress: ParsedAddress | null;
  shippingAddress: ParsedAddress | null;
  items: ParsedPoItem[];
  subtotal: number | null;
  total: number | null;
}

/** A single piece of text extracted from a PDF page, with its position
 * (PDF user-space coordinates, origin bottom-left) so two-column form
 * layouts (billing vs. shipping address blocks) can be reconstructed even
 * when the underlying PDF content stream draws labels and values out of
 * their visual order (common with spreadsheet-exported PDFs). */
export interface PositionedTextItem {
  str: string;
  x: number;
  y: number;
}

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

const ADDRESS_FIELD_LABELS: Record<string, keyof ParsedAddress> = {
  "company name": "companyName",
  "street with number": "street",
  city: "city",
  "zip code": "zipCode",
  country: "country",
  "contact phone number": "contactPhone",
  "contact mail": "contactEmail",
};

function normalizeLabel(raw: string): string {
  return raw.trim().replace(/:\s*$/, "").toLowerCase();
}

/**
 * Reconstructs the "IMPORTER OF RECORD / INVOICE TO ADDRESS" (billing) and
 * "DELIVERY TO / PLACE OF COLLECTION" (shipping) two-column address blocks,
 * plus the PO #/Date/Customer Account Number header fields, from positioned
 * text items. Groups items into visual rows by y-coordinate, splits each row
 * into left (billing) / right (shipping) columns using the x-midpoint of the
 * two section header labels, then pairs each "Label:" item with the next
 * item to its right in the same column/row as its value. This works even
 * though the raw extracted text stream often interleaves/reorders labels and
 * values across the two columns (see poIntakeAgent.ts).
 */
export function extractAddressesFromPositions(items: PositionedTextItem[]): {
  billingAddress: ParsedAddress | null;
  shippingAddress: ParsedAddress | null;
  poNumber: string | null;
  poDate: string | null;
  customerAccountNumber: string | null;
} {
  const nonEmpty = items.filter((item) => item.str.trim().length > 0);
  const Y_TOLERANCE = 3;
  const rows: PositionedTextItem[][] = [];
  for (const item of [...nonEmpty].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= Y_TOLERANCE);
    if (row) row.push(item);
    else rows.push([item]);
  }
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));

  let columnThreshold = 350;
  const headerRow = rows.find(
    (row) => row.some((i) => /IMPORTER OF RECORD/i.test(i.str)) && row.some((i) => /DELIVERY TO/i.test(i.str))
  );
  if (headerRow) {
    const left = headerRow.find((i) => /IMPORTER OF RECORD/i.test(i.str));
    const right = headerRow.find((i) => /DELIVERY TO/i.test(i.str));
    if (left && right) columnThreshold = (left.x + right.x) / 2;
  }

  const billing: Partial<Record<keyof ParsedAddress, string>> = {};
  const shipping: Partial<Record<keyof ParsedAddress, string>> = {};
  let poNumber: string | null = null;
  let poDate: string | null = null;
  let customerAccountNumber: string | null = null;

  const assignAddressField = (column: PositionedTextItem[], target: Partial<Record<keyof ParsedAddress, string>>) => {
    for (let i = 0; i < column.length - 1; i++) {
      const field = ADDRESS_FIELD_LABELS[normalizeLabel(column[i].str)];
      if (field) target[field] = column[i + 1].str.trim();
    }
  };

  for (const row of rows) {
    assignAddressField(
      row.filter((i) => i.x < columnThreshold),
      billing
    );
    assignAddressField(
      row.filter((i) => i.x >= columnThreshold),
      shipping
    );

    for (let i = 0; i < row.length - 1; i++) {
      const label = normalizeLabel(row[i].str);
      if (label === "po #") poNumber = row[i + 1].str.trim() || poNumber;
      else if (label === "date") poDate = row[i + 1].str.trim() || poDate;
      else if (label === "customer account number") customerAccountNumber = row[i + 1].str.trim() || customerAccountNumber;
    }
  }

  const toAddress = (map: Partial<Record<keyof ParsedAddress, string>>): ParsedAddress | null =>
    Object.keys(map).length === 0
      ? null
      : {
          companyName: map.companyName ?? null,
          street: map.street ?? null,
          city: map.city ?? null,
          zipCode: map.zipCode ?? null,
          country: map.country ?? null,
          contactPhone: map.contactPhone ?? null,
          contactEmail: map.contactEmail ?? null,
        };

  return {
    billingAddress: toAddress(billing),
    shippingAddress: toAddress(shipping),
    poNumber,
    poDate,
    customerAccountNumber,
  };
}

/**
 * Reconstructs the "ITEM# / DESCRIPTION / QTY / UNIT PRICE / TOTAL" line-item
 * table, and the grand total, from positioned text items — needed because
 * (like the address blocks handled by `extractAddressesFromPositions`) this
 * PO template draws each column's values in a block separate from the
 * header/other columns in the underlying content stream, so the plain
 * joined text interleaves item numbers, descriptions, and prices out of
 * their visual row order (see poIntakeAgent.ts).
 *
 * Rather than bucketing by x-position against the header cells' x (which
 * turned out *not* to align with the data columns' x in this template —
 * e.g. the "DESCRIPTION" header sits well to the right of where description
 * values actually start), this groups items below the header row into
 * visual rows by y, and — for rows that contain exactly the 5 expected
 * item-row cells — assigns them positionally left-to-right (item #,
 * description, qty, unit price, total). Rows that don't have exactly 5
 * cells (tax/shipping/other "-" placeholder rows, the grand-total row,
 * notes, etc.) are skipped.
 */
export function extractItemsFromPositions(items: PositionedTextItem[]): {
  items: ParsedPoItem[];
  total: number | null;
} {
  const nonEmpty = items.filter((item) => item.str.trim().length > 0);
  const Y_TOLERANCE = 3;

  const findHeader = (pattern: RegExp) => nonEmpty.find((i) => pattern.test(i.str.trim()));
  const itemNumberHeader = findHeader(/^ITEM#$/i);
  const descriptionHeader = findHeader(/^DESCRIPTION$/i);
  const qtyHeader = findHeader(/^QTY$/i);
  const priceHeader = findHeader(/^(UNIT|PRICE)$/i);
  const totalHeader = findHeader(/^TOTAL$/i);
  if (!itemNumberHeader || !descriptionHeader || !qtyHeader || !priceHeader || !totalHeader) {
    return { items: [], total: null };
  }

  const headerY = Math.min(itemNumberHeader.y, descriptionHeader.y, qtyHeader.y, priceHeader.y, totalHeader.y);
  const belowHeader = nonEmpty.filter((i) => i.y < headerY - Y_TOLERANCE);

  const rows: PositionedTextItem[][] = [];
  for (const item of [...belowHeader].sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r[0].y - item.y) <= Y_TOLERANCE);
    if (row) row.push(item);
    else rows.push([item]);
  }
  rows.forEach((row) => row.sort((a, b) => a.x - b.x));

  const parsedItems: ParsedPoItem[] = [];
  for (const row of rows) {
    if (row.length !== 5) continue;
    const [itemNumberCell, descriptionCell, qtyCell, unitPriceCell, totalCell] = row;
    const itemNumber = itemNumberCell.str.trim();
    const qty = qtyCell.str.trim();
    const unitPrice = unitPriceCell.str.trim();
    const total = totalCell.str.trim();
    if (
      /^[A-Za-z0-9-]+$/.test(itemNumber) &&
      /^\d+$/.test(qty) &&
      /^[\d,]+\.\d{2}$/.test(unitPrice) &&
      /^[\d,]+\.\d{2}$/.test(total)
    ) {
      parsedItems.push({
        itemNumber,
        description: descriptionCell.str.trim(),
        quantity: Number(qty),
        unitPrice: toNumber(unitPrice),
        total: toNumber(total),
      });
    }
  }

  // The grand total is typically printed as a "€ <amount>" (or "$ <amount>")
  // pair on its own row below the item table/tax-shipping-other lines.
  const currencyRow = rows.find((row) => row.some((cell) => /^[€$£]/.test(cell.str.trim())));
  const totalCell = currencyRow?.find((cell) => /^[\d,]+\.\d{2}$/.test(cell.str.trim()));
  const total = totalCell ? toNumber(totalCell.str.trim()) : null;

  return { items: parsedItems, total };
}

/**
 * Extracts structured data from the raw text of a (typically templated)
 * purchase order PDF: PO number, date, vendor, and the line-item table
 * (item #, description, qty, unit price, total). Tolerant of the common
 * "[Company Name] PURCHASE ORDER ... VENDOR ... ITEM # DESCRIPTION QTY UNIT
 * PRICE TOTAL" template layout, with a generic trailing-numbers fallback
 * for the item rows so it degrades gracefully on other layouts.
 *
 * When `positionedItems` is supplied (the PO Intake Agent always provides
 * these — see poIntakeAgent.ts), billing/shipping address blocks and the
 * PO #/Date/Customer Account Number header fields are extracted via
 * `extractAddressesFromPositions` instead, since those rely on x/y layout
 * to survive the label/value reordering common in spreadsheet-exported PO
 * PDFs (see that function's doc comment). Falls back to the plain-text
 * regexes below for PO #/Date when no positional match is found.
 */
export function parsePurchaseOrderText(text: string, positionedItems?: PositionedTextItem[]): ParsedPurchaseOrder {
  const poNumberMatch = text.match(/PO\s*#\s*[:\-]?\s*([A-Za-z0-9-]+)/i);
  const dateMatch = text.match(/\bDATE\b\s*[:\-]?\s*([\d/.\-]+)/i);

  // The "VENDOR" / "SHIP TO" headers are typically two columns rendered on
  // the same source line, with each column's data on the following line(s)
  // similarly joined — so the vendor name is the left-hand portion of the
  // first line after the header row (before a large gap, tab, or bracketed
  // "[Placeholder]" ship-to field).
  const vendorHeaderMatch = text.match(/VENDOR\s+SHIP\s+TO\s*[\r\n]+\s*([^\r\n]+)/i);
  const vendorName = vendorHeaderMatch
    ? vendorHeaderMatch[1].split(/\s{2,}|\t|\[/)[0].trim() || null
    : null;

  // Matches lines like: "[23423423] Product XYZ 15 150.00 2,250.00".
  // Uses [ \t] (not \s) between fields and ^...$ line anchors so a match
  // can never stitch together text from two different source lines.
  const itemLineRegex =
    /^\[?([A-Za-z0-9-]+)\]?[ \t]+(.+?)[ \t]+(\d+)[ \t]+\$?([\d,]+\.\d{2})[ \t]+\$?([\d,]+\.\d{2})[ \t]*$/gm;

  const items: ParsedPoItem[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemLineRegex.exec(text)) !== null) {
    const [, itemNumber, description, qty, unitPrice, total] = match;
    // Skip summary rows that happen to match the same shape (e.g. a
    // "SUBTOTAL ... 2,325.00" line has no item number, so this rarely
    // triggers, but guard against label-like descriptions defensively).
    if (/subtotal|shipping|^tax$|^other$/i.test(description)) continue;

    items.push({
      itemNumber,
      description: description.trim(),
      quantity: Number(qty),
      unitPrice: toNumber(unitPrice),
      total: toNumber(total),
    });
  }

  const subtotalMatch = text.match(/SUBTOTAL\s*\$?([\d,]+\.\d{2})/i);
  const totalMatches = [...text.matchAll(/\bTOTAL\b[^\d\n]*\$?([\d,]+\.\d{2})/gi)];

  const positionalAddresses = positionedItems?.length ? extractAddressesFromPositions(positionedItems) : null;
  // Fall back to positional item-table extraction when the plain-text regex
  // found no line items (see extractItemsFromPositions's doc comment) — this
  // template draws the ITEM#/DESCRIPTION/QTY/PRICE/TOTAL columns in blocks
  // that don't interleave row-by-row in the raw text stream.
  const positionalItems =
    items.length === 0 && positionedItems?.length ? extractItemsFromPositions(positionedItems) : null;

  return {
    poNumber: positionalAddresses?.poNumber ?? poNumberMatch?.[1] ?? null,
    poDate: positionalAddresses?.poDate ?? dateMatch?.[1] ?? null,
    vendorName,
    customerAccountNumber: positionalAddresses?.customerAccountNumber ?? null,
    billingAddress: positionalAddresses?.billingAddress ?? null,
    shippingAddress: positionalAddresses?.shippingAddress ?? null,
    items: positionalItems?.items.length ? positionalItems.items : items,
    subtotal: subtotalMatch ? toNumber(subtotalMatch[1]) : null,
    // The grand total line comes last (after any TOTAL column header).
    total:
      totalMatches.length > 0
        ? toNumber(totalMatches[totalMatches.length - 1][1])
        : positionalItems?.total ?? null,
  };
}

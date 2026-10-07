import { describe, expect, it } from "vitest";
import {
  extractAddressesFromPositions,
  extractItemsFromPositions,
  parsePurchaseOrderText,
  type PositionedTextItem,
} from "./poParser.js";

describe("parsePurchaseOrderText", () => {
  it("extracts PO #, date, vendor, line items, and totals from the plain-text regex path", () => {
    const text = [
      "ACME CORP PURCHASE ORDER",
      "PO #: PO-1001",
      "DATE: 2024-01-15",
      "VENDOR          SHIP TO",
      "Globex Supplies   [Placeholder]",
      "[SKU-001] Wireless Mouse 2 19.99 39.98",
      "[SKU-002] Mechanical Keyboard 1 89.99 89.99",
      "SUBTOTAL $129.97",
      "TOTAL $129.97",
    ].join("\n");

    const parsed = parsePurchaseOrderText(text);

    expect(parsed.poNumber).toBe("PO-1001");
    expect(parsed.vendorName).toBe("Globex Supplies");
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]).toMatchObject({
      itemNumber: "SKU-001",
      quantity: 2,
      unitPrice: 19.99,
      total: 39.98,
    });
    expect(parsed.subtotal).toBe(129.97);
    expect(parsed.total).toBe(129.97);
  });

  it("returns nulls/empty items gracefully for text with no recognizable PO structure", () => {
    const parsed = parsePurchaseOrderText("just some unrelated text with no PO fields");
    expect(parsed.poNumber).toBeNull();
    expect(parsed.vendorName).toBeNull();
    expect(parsed.items).toEqual([]);
    expect(parsed.total).toBeNull();
  });
});

describe("extractAddressesFromPositions", () => {
  it("splits billing/shipping columns by the IMPORTER OF RECORD / DELIVERY TO header midpoint", () => {
    const items: PositionedTextItem[] = [
      { str: "IMPORTER OF RECORD", x: 50, y: 700 },
      { str: "DELIVERY TO", x: 400, y: 700 },
      { str: "Company name:", x: 50, y: 680 },
      { str: "Billing Co", x: 150, y: 680 },
      { str: "Company name:", x: 400, y: 680 },
      { str: "Shipping Co", x: 500, y: 680 },
      { str: "City:", x: 50, y: 660 },
      { str: "Billton", x: 150, y: 660 },
      { str: "City:", x: 400, y: 660 },
      { str: "Shipton", x: 500, y: 660 },
    ];

    const result = extractAddressesFromPositions(items);

    expect(result.billingAddress).toMatchObject({ companyName: "Billing Co", city: "Billton" });
    expect(result.shippingAddress).toMatchObject({ companyName: "Shipping Co", city: "Shipton" });
  });

  it("returns null addresses when no address fields are present", () => {
    const result = extractAddressesFromPositions([{ str: "Unrelated", x: 0, y: 0 }]);
    expect(result.billingAddress).toBeNull();
    expect(result.shippingAddress).toBeNull();
  });
});

describe("extractItemsFromPositions", () => {
  it("assigns a 5-cell row below the header positionally to item#/description/qty/price/total", () => {
    const items: PositionedTextItem[] = [
      { str: "ITEM#", x: 10, y: 500 },
      { str: "DESCRIPTION", x: 100, y: 500 },
      { str: "QTY", x: 250, y: 500 },
      { str: "UNIT", x: 300, y: 500 },
      { str: "TOTAL", x: 400, y: 500 },

      { str: "SKU-001", x: 10, y: 480 },
      { str: "Wireless Mouse", x: 100, y: 480 },
      { str: "2", x: 250, y: 480 },
      { str: "19.99", x: 300, y: 480 },
      { str: "39.98", x: 400, y: 480 },
    ];

    const result = extractItemsFromPositions(items);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      itemNumber: "SKU-001",
      description: "Wireless Mouse",
      quantity: 2,
      unitPrice: 19.99,
      total: 39.98,
    });
  });

  it("skips rows that don't have exactly 5 cells (e.g. a tax/shipping placeholder row)", () => {
    const items: PositionedTextItem[] = [
      { str: "ITEM#", x: 10, y: 500 },
      { str: "DESCRIPTION", x: 100, y: 500 },
      { str: "QTY", x: 250, y: 500 },
      { str: "UNIT", x: 300, y: 500 },
      { str: "TOTAL", x: 400, y: 500 },

      { str: "TAX", x: 100, y: 480 },
      { str: "-", x: 400, y: 480 },
    ];

    const result = extractItemsFromPositions(items);
    expect(result.items).toEqual([]);
  });

  it("returns empty items when the expected header row isn't found", () => {
    const result = extractItemsFromPositions([{ str: "Nothing here", x: 0, y: 0 }]);
    expect(result.items).toEqual([]);
    expect(result.total).toBeNull();
  });
});

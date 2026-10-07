import { describe, expect, it } from "vitest";
import { formatOrderNumber, newOrderId } from "./orderId.js";

describe("formatOrderNumber", () => {
  it("pads a sequence number into the ORD-###### form", () => {
    expect(formatOrderNumber(42)).toBe("ORD-000042");
    expect(formatOrderNumber(1)).toBe("ORD-000001");
    expect(formatOrderNumber(123456)).toBe("ORD-123456");
  });

  it("falls back to a short UUID-derived form when orderSeq is null/undefined", () => {
    expect(formatOrderNumber(null, "11112222-3333-4444-5555-666677778888")).toBe("ORD-11112222");
    expect(formatOrderNumber(undefined, "abcdabcd-0000-0000-0000-000000000000")).toBe("ORD-ABCDABCD");
  });

  it("falls back to an empty-derived form when neither orderSeq nor fallbackId is given", () => {
    expect(formatOrderNumber(null)).toBe("ORD-");
  });
});

describe("newOrderId", () => {
  it("generates distinct UUID-shaped ids", () => {
    const a = newOrderId();
    const b = newOrderId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

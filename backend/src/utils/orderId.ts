import { v4 as uuid } from "uuid";

export function newOrderId(): string {
  return uuid();
}

/** Formats a database sequence number into the human-readable order number
 * shown throughout the UI/chat bot (e.g. "ORD-000042") instead of exposing
 * the raw UUID primary key. Falls back to a short UUID-derived form for
 * legacy rows created before the `order_seq` column existed. */
export function formatOrderNumber(orderSeq: number | null | undefined, fallbackId?: string): string {
  if (orderSeq != null) {
    return `ORD-${String(orderSeq).padStart(6, "0")}`;
  }
  return `ORD-${(fallbackId ?? "").replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

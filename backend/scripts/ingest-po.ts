/**
 * Manual PO-PDF ingestion helper — for processing a purchase-order PDF a
 * partner/customer sent you directly (email, Slack, shared drive, etc.)
 * without them needing to log in to the dashboard or reach your machine
 * over the network at all.
 *
 * Calls the exact same `createOrderFromPdf` used by
 * `POST /api/orders/from-po` (see routes/orders.ts), so the resulting order
 * shows up on the live dashboard identically to a real upload — it just
 * skips the HTTP + Supabase-session-auth layer, which only exists to gate
 * *who* can call the API, not the intake logic itself.
 *
 * Usage:
 *   npx tsx scripts/ingest-po.ts <path-to-pdf> [customerEmail] [customerName]
 *
 * customerEmail/customerName are only used as a fallback if the PDF itself
 * has no extractable billing contact email (see poIntakeAgent.ts).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createOrderFromPdf } from "../src/services/orderService.js";

async function main() {
  const [, , filePath, customerEmail, customerName] = process.argv;

  if (!filePath) {
    console.error("Usage: npx tsx scripts/ingest-po.ts <path-to-pdf> [customerEmail] [customerName]");
    process.exit(1);
  }

  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const t0 = performance.now();
  const outcome = await createOrderFromPdf({ fileBuffer, fileName, customerEmail, customerName });
  const elapsed = performance.now() - t0;

  if ("error" in outcome) {
    console.error(`Failed to process ${fileName}: ${outcome.error}`);
    process.exit(1);
  }

  const status = (outcome.result as { status?: string })?.status ?? "unknown";
  console.log(`Processed ${fileName} in ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`Order ${outcome.orderNumber} (${outcome.orderId}) -> status: ${status}`);
  console.log(`Extraction method: ${outcome.extractionMethod}`);
  console.log(`Vendor: ${outcome.parsed.vendorName ?? "unknown"}, total items: ${outcome.parsed.items.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

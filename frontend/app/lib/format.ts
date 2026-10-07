/** Shared display formatters so currency/dates render consistently across
 * the dashboard and inventory pages (e.g. always "€150.00", never a mix of
 * "€150" and "€19.99" depending on whether the number happens to have
 * decimals). */

const currencyFormatter = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
});

export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  return currencyFormatter.format(amount);
}

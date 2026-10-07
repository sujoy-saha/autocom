import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

// Load the repo-root .env regardless of the process's cwd (npm workspace
// scripts run with cwd set to backend/, not the repo root, so the default
// dotenv/config behavior of reading "./.env" would silently miss it).
loadEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const nebiusApiKey = process.env.NEBIUS_API_KEY;
const tavilyApiKey = process.env.TAVILY_API_KEY;
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const dsvClientId = process.env.DSV_CLIENT_ID;
const dsvClientSecret = process.env.DSV_CLIENT_SECRET;
const dsvSubscriptionKey = process.env.DSV_SUBSCRIPTION_KEY;

// Two independent "demo" concerns, each falling back to a zero-config stand-in
// when its own credentials are missing:
//   - isDemoStore: no Supabase creds -> use the in-memory DataStore
//   - isDemoLlm:   no Nebius API key -> use canned/heuristic responses instead
//     of calling Nemotron
// DEMO_MODE=true|false (if set) forces both together, for convenience/back-
// compat. Otherwise each is auto-detected independently, so e.g. you can
// configure only NEBIUS_API_KEY to exercise the real LLM + MCP tool-calling
// while still using the in-memory store.
const forcedDemoMode = process.env.DEMO_MODE ? process.env.DEMO_MODE === "true" : undefined;
const isDemoStore = forcedDemoMode ?? (!supabaseUrl || !supabaseServiceRoleKey);
const isDemoLlm = forcedDemoMode ?? !nebiusApiKey;
// Web search (Tavily) isn't covered by DEMO_MODE the way store/LLM are —
// it's a purely additive fallback (replenishment sourcing leads, chat bot
// Q&A), so it's off only when TAVILY_API_KEY itself is missing, regardless
// of DEMO_MODE.
const isDemoSearch = !tavilyApiKey;
// Payment Agent (agents/paymentAgent.ts): no STRIPE_SECRET_KEY -> keep the
// original simulated ~90%-approval charge instead of calling Stripe. This
// is independent of DEMO_MODE (like isDemoSearch) since Stripe test-mode
// keys are free/self-service and unrelated to the Supabase/LLM demo story.
const isDemoPayment = !stripeSecretKey;
// Fulfillment Agent (agents/fulfillmentAgent.ts): no DSV sandbox
// credentials -> keep the original simulated random-carrier shipment
// instead of calling DSV's real Connect Booking API. Independent of
// DEMO_MODE for the same reason as isDemoPayment.
const isDemoFulfillment = !dsvClientId || !dsvClientSecret || !dsvSubscriptionKey;
const isDemoMode = isDemoStore || isDemoLlm;

if (isDemoStore) {
  console.warn(
    "[config] No Supabase credentials configured: using an in-memory data store " +
      "(data does not persist across restarts). Set SUPABASE_URL and " +
      "SUPABASE_SERVICE_ROLE_KEY in .env to use real Supabase."
  );
}
if (isDemoLlm) {
  console.warn(
    "[config] No NEBIUS_API_KEY configured: using canned/heuristic agent " +
      "responses instead of calling Nemotron. Set NEBIUS_API_KEY in .env to " +
      "run against the real model."
  );
}
if (isDemoSearch) {
  console.warn(
    "[config] No TAVILY_API_KEY configured: web search is disabled " +
      "(Replenishment Agent supplier lookups and ChatBot general Q&A fall " +
      "back to their existing non-search behavior). Set TAVILY_API_KEY in " +
      ".env to enable it."
  );
}
if (isDemoPayment) {
  console.warn(
    "[config] No STRIPE_SECRET_KEY configured: using the simulated ~90%- " +
      "approval charge instead of Stripe. Set STRIPE_SECRET_KEY (a Stripe " +
      "*test-mode* secret key, sk_test_...) in .env to charge against the " +
      "real Stripe sandbox with test cards."
  );
}
if (isDemoFulfillment) {
  console.warn(
    "[config] No DSV sandbox credentials configured (DSV_CLIENT_ID / " +
      "DSV_CLIENT_SECRET / DSV_SUBSCRIPTION_KEY): using the simulated " +
      "random-carrier shipment instead of booking with DSV. Set those in " +
      ".env (from the DSV developer portal's sandbox) to book real DSV " +
      "test shipments."
  );
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  isDemoMode,
  isDemoStore,
  isDemoLlm,
  isDemoSearch,

  supabaseUrl: supabaseUrl ?? "",
  // Service-role key: backend only, never expose to the frontend.
  supabaseServiceRoleKey: supabaseServiceRoleKey ?? "",

  // Nebius Token Factory exposes an OpenAI-compatible Chat Completions API.
  nebiusBaseUrl: process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.com/v1",
  nebiusApiKey: nebiusApiKey ?? "",
  // e.g. "nvidia/nemotron-3-ultra" for deep reasoning, or a Nano/Super variant
  // for cheap, fast agent steps. Override per-agent via env if desired.
  nebiusModel: process.env.NEBIUS_MODEL ?? "nvidia/nemotron-3-ultra",

  // Tavily web search: used by the Replenishment Agent (real supplier leads
  // when our simulated vendor can't fully restock a SKU) and the ChatBot
  // Agent (answering general questions it can't resolve from the catalog or
  // order status). See services/tavilySearch.ts.
  tavilyApiKey: tavilyApiKey ?? "",
  tavilyBaseUrl: process.env.TAVILY_BASE_URL ?? "https://api.tavily.com",

  // Stripe test-mode (sandbox) integration for the Payment Agent — see
  // agents/paymentAgent.ts and services/stripePayment.ts. Only ever use a
  // *test* secret key (sk_test_...) here, never a live key.
  isDemoPayment,
  stripeSecretKey: stripeSecretKey ?? "",
  // Stripe test PaymentMethod IDs (https://stripe.com/docs/testing#cards):
  // pm_card_visa always succeeds; pm_card_chargeDeclined always declines
  // with a generic_decline code. Configurable so demos can force either
  // outcome without touching code.
  stripeTestPaymentMethod: process.env.STRIPE_TEST_PAYMENT_METHOD ?? "pm_card_visa",
  stripeDeclinePaymentMethod: process.env.STRIPE_DECLINE_PAYMENT_METHOD ?? "pm_card_chargeDeclined",

  // DSV Connect Booking API (Road transport mode) sandbox integration for
  // the Fulfillment Agent — see agents/fulfillmentAgent.ts and
  // services/dsvShipping.ts. Only ever use sandbox credentials issued by
  // the DSV developer portal (https://developer.dsv.com/), never a
  // production/live account.
  isDemoFulfillment,
  dsvClientId: dsvClientId ?? "",
  dsvClientSecret: dsvClientSecret ?? "",
  dsvSubscriptionKey: dsvSubscriptionKey ?? "",
  // MDM test account number used as the Booking Party / Freight Payer on
  // every booking, issued alongside sandbox credentials.
  dsvAccountNumber: process.env.DSV_ACCOUNT_NUMBER ?? "",
  dsvTokenUrl: process.env.DSV_TOKEN_URL ?? "https://api.dsv.com/oauth2/token",
  dsvApiBaseUrl: process.env.DSV_API_BASE_URL ?? "https://api-sandbox.dsv.com/connect/booking/v1",

  // Single fixed warehouse/sender address (hackathon simplification — this
  // app has no multi-warehouse concept). Used as the shipper on every DSV
  // booking.
  dsvSender: {
    name: process.env.DSV_SENDER_NAME ?? "",
    street: process.env.DSV_SENDER_STREET ?? "",
    city: process.env.DSV_SENDER_CITY ?? "",
    zip: process.env.DSV_SENDER_ZIP ?? "",
    country: process.env.DSV_SENDER_COUNTRY ?? "",
    phone: process.env.DSV_SENDER_PHONE ?? "",
    email: process.env.DSV_SENDER_EMAIL ?? "",
  },

  // Default package weight/dimensions for every shipment (hackathon
  // simplification — the catalog has no per-SKU weight/dimensions today).
  dsvDefaultPackage: {
    weightKg: Number(process.env.DSV_DEFAULT_PACKAGE_WEIGHT_KG ?? 5),
    lengthCm: Number(process.env.DSV_DEFAULT_PACKAGE_LENGTH_CM ?? 30),
    widthCm: Number(process.env.DSV_DEFAULT_PACKAGE_WIDTH_CM ?? 20),
    heightCm: Number(process.env.DSV_DEFAULT_PACKAGE_HEIGHT_CM ?? 15),
  },

  // Enterprise guardrail: orders whose total exceeds this amount (in the
  // demo currency, EUR) are held for human sign-off by the Approval Agent
  // instead of proceeding straight to Payment. See agents/approvalAgent.ts.
  approvalThreshold: Number(process.env.APPROVAL_THRESHOLD ?? 500),

  // Replenishment Agent (agents/replenishmentAgent.ts): when Nemotron is
  // configured (!isDemoLlm), the agent negotiates each backordered SKU's
  // restock order with the vendor's MCP tools (propose_restock_order /
  // finalize_restock_order) instead of accepting list price outright, for
  // up to this many rounds before falling back to the deterministic
  // one-shot place_restock_order path.
  replenishmentMaxNegotiationRounds: Number(process.env.REPLENISHMENT_MAX_NEGOTIATION_ROUNDS ?? 3),
};


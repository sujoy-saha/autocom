# AutoCom

A multi-agent, end-to-end **order management system**: a customer's plain-English
order is parsed, checked against live stock, paid, shipped, and followed up on —
each step handled by a dedicated agent, coordinated as a [LangGraph](https://github.com/langchain-ai/langgraphjs)
state machine, reasoning with **NVIDIA Nemotron** models served by **Nebius Token
Factory**, and persisted in **Supabase** (Postgres + Realtime).

Built for the [Nebius x NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/)
— **Best Apps and Agents Track**.

## Architecture

![AutoCom architecture: PO Intake, Inventory, Approval, Payment, Fulfillment, and Support agents, an MCP server for live tool-calling, Nebius Token Factory/Nemotron for reasoning, and Supabase for persistence and the audit trail](./architecture-detailed.png)

*(Mermaid source + a simplified version for slides: [ARCHITECTURE_DIAGRAM.md](./ARCHITECTURE_DIAGRAM.md))*

```
Uploaded PO PDF ──▶ PO Intake Agent ──▶ Inventory Agent ──┬─▶ Approval Agent ──┬─▶ Payment Agent ──┬─▶ Fulfillment Agent ──▶ Support Agent
                                                            │                    │                   │
                                     (out of stock)         │                    │                   │
                                     Replenishment Agent ◀──┘                    │                   │
                                            │                                    │                   │
                                            └──────────────────────────────────────────────────────────▶ Support Agent
                                                                                       (held for human sign-off / payment declined)
```

| Agent | Responsibility | Model use |
|---|---|---|
| **PO Intake** | Entry point: extracts vendor, PO #, billing/shipping addresses, and priced line items directly from an uploaded purchase-order PDF, cross-checking SKUs against the live catalog via MCP tool calls, then feeds the pipeline starting at Inventory | Nemotron (tool-calling + structured JSON extraction from raw PDF text; falls back to a deterministic regex/positional parser in demo mode or if the model call fails) |
| **Inventory** | Reserves stock per line item; auto-provisions unknown SKUs (e.g. from an uploaded PO) with the requested quantity; routes to backorder if genuinely short | — (deterministic DB logic) |
| **Replenishment** | On a shortfall, autonomously negotiates a restock order with an *external* vendor's own MCP server for each short SKU (agent-to-agent commerce, not just our own DB) — haggling toward a lower unit price without accepting a worse lead time than standard; if the vendor can't fully cover it, also searches the live web for a real alternative supplier lead | Nemotron (bounded multi-round tool-calling negotiation via `propose_restock_order`/`finalize_restock_order`; falls back to a deterministic one-shot `place_restock_order` at list price in demo mode or if negotiation fails) |
| **Approval** | Enterprise guardrail: orders whose total exceeds `APPROVAL_THRESHOLD` are held (status `pending_approval`) for a human to Approve/Reject in the dashboard instead of proceeding straight to Payment; orders at or under the threshold auto-approve | — (deterministic policy check) |
| **Payment** | Charges Stripe's test-mode (sandbox) API with a configurable test card, persists payment record; falls back to a simulated charge if `STRIPE_SECRET_KEY` is unset | — (Stripe test mode) |
| **Fulfillment** | Books a Road shipment via DSV's real sandbox Connect Booking API using the customer's address on file, generates a real tracking number; falls back to a simulated carrier/tracking number if DSV sandbox credentials aren't configured, the order has no address on file, or the DSV call fails | — (DSV sandbox) |
| **Support** | Drafts a tailored customer notification for every outcome (shipped / backordered / payment failed) | Nemotron (natural-language drafting) |

Every agent step is appended to `agent_logs` in Supabase, and the Next.js dashboard
subscribes to that table (and `orders`) via **Supabase Realtime**, so the agent
timeline updates live as an order moves through the pipeline.

### Guardrails: human approval for high-value orders

The **Approval Agent** sits between Inventory and Payment. If an order's total
exceeds `APPROVAL_THRESHOLD` (env var, default €500), the order is held with
status `pending_approval` and the pipeline run ends there — Payment is never
charged automatically. The dashboard shows an **Approve**/**Reject** action on
held orders (`POST /api/orders/:id/approve` / `/reject`); approving resumes
the pipeline directly at Payment (via a separate tail-only LangGraph graph,
`buildResumeAfterApprovalGraph`), while rejecting stops the order at
`rejected` without charging it. Inventory is never re-run on
approval/rejection, since stock was already reserved before the gate — only
a genuinely backordered order (which never reserved anything) is safe to
restart from Inventory (see "Retry now").

### Agent-to-agent commerce: autonomous vendor restock

A shortfall at Inventory doesn't just end in a silent backorder. The
**Replenishment Agent** (`backend/src/agents/replenishmentAgent.ts`) calls an
*external* vendor/supplier's own MCP server
(`backend/src/mcp/vendorServer.ts`, reached via a completely separate
client/server boundary in `backend/src/mcp/vendorClient.ts` — its own
in-memory stock/pricing, no shared database with our own `inventory` table)
to autonomously source a restock order for each short SKU, logging the
vendor's order id, cost, and lead time to the agent timeline. This is
genuine agent-to-agent commerce — our buyer-side agent transacting with
another "company's" system through a protocol boundary — not just another
view onto our own data.

When Nemotron is configured, it doesn't just accept the vendor's list
price: it runs a bounded negotiation (up to `REPLENISHMENT_MAX_NEGOTIATION_ROUNDS`
rounds, default 3) against the vendor's `propose_restock_order` tool, which
implements a realistic hidden bulk-discount floor price (bigger orders
unlock a bigger discount) and counters lowball offers rather than accepting
them outright, plus a rush-lead-time surcharge if a faster-than-standard
delivery is requested. Nemotron aims to minimize cost without ever trading
away lead time versus the vendor's standard, then commits the deal with
`finalize_restock_order`. Every negotiation tool call is logged to the
agent timeline (`negotiation_tool_calls`), alongside the savings vs. list
price. In demo mode (no `NEBIUS_API_KEY`), or if the negotiation loop fails
for any reason, the agent falls back to the original one-shot
`place_restock_order` call at list price — a negotiation hiccup never
blocks sourcing stock.

It doesn't fulfill the *current* order (the vendor's
stock still has to physically arrive), so the order stays `backordered`;
bump the SKU's stock on the **Inventory** admin page once it "arrives" and
use **Retry now** to complete the order.

### MCP layer

`backend/src/mcp/server.ts` exposes the live product catalog and order status as
[Model Context Protocol](https://modelcontextprotocol.io) tools:

- `list_inventory` — full catalog (SKU, name, price, quantity available)
- `check_inventory` — look up a single SKU
- `ensure_inventory_item` — register a SKU discovered from an external document
- `get_order_status` — an order's status + full agent log timeline
- `web_search` — live web search (Tavily), used as a fallback by the
  Replenishment and ChatBot agents (see below)

`server.ts` also exposes `web_search`, a live web-search tool backed by
[Tavily](https://tavily.com) (`backend/src/services/tavilySearch.ts`). It's
the one tool here that reaches outside our own data entirely, and is used as
a fallback in two places: the **Replenishment Agent** calls it for a real
alternative-supplier lead whenever the simulated vendor can't fully cover a
shortfall, and the **ChatBot Agent** calls it (then asks Nemotron to
summarize the results) to answer a general customer question the catalog/
order tools have no answer for. Set `TAVILY_API_KEY` in `.env` to enable it;
left unset, both features degrade gracefully to their prior behavior (no
supplier lead / the generic "not sure how to answer that" message).

A second, independent MCP server, `backend/src/mcp/vendorServer.ts`,
simulates an external vendor/supplier's own system (`get_vendor_catalog`,
`check_vendor_stock`, `place_restock_order`, `propose_restock_order`,
`finalize_restock_order`, `get_vendor_order_status`), reached only via
`backend/src/mcp/vendorClient.ts`'s own client/server boundary —
deliberately never sharing a database or in-process object graph with our
own catalog server, so the Replenishment Agent's restock requests and
negotiation are genuine cross-system MCP calls, not a shortcut through
shared state.

`backend/src/mcp/client.ts` connects to that server over an in-memory MCP
transport (real MCP client/server JSON-RPC traffic, just carried in-process
instead of over stdio/HTTP, so the demo has no extra process to run). The
PO Intake agent hands these tools to Nemotron via the OpenAI-style
`tools` function-calling parameter (`completeJsonWithMcpTools` in
`backend/src/llm/nebiusClient.ts`): the model can call `check_inventory` /
`list_inventory` as many times as it needs while reasoning, before returning
its final structured JSON — grounding its answer in *live* data instead of a
catalog snapshot pasted into the prompt. Every tool call the model makes is
logged to `agent_logs` (`mcp_tool_calls`) so it's visible in the dashboard
timeline. In DEMO_MODE this agent skips the LLM (and therefore MCP) entirely
and uses its deterministic fallback instead, since there's no real model to
call tools against.

### Order intake: upload a PO PDF

A vendor/customer purchase order (PO #, vendor, billing/shipping addresses,
itemized table) is parsed by the PO Intake Agent, and its own item
numbers/descriptions/prices are used directly, since it's an externally
authored document rather than an order against our catalog. Unknown SKUs
are auto-provisioned into inventory so the order can still be fulfilled, and
the extracted billing/shipping addresses are persisted onto the customer
record. Try it with `POST /api/orders/from-po` (multipart `file` +
`customerEmail`) or the "Upload purchase order (PDF)" form in the dashboard.

### Why this fits the hackathon

- Runs on **Nebius Token Factory** (OpenAI-compatible Chat Completions endpoint) for all LLM calls.
- Uses **NVIDIA Nemotron** (`nvidia/nemotron-3-ultra` by default, configurable) for reasoning/drafting.
- A genuinely multi-agent, stateful **LangGraph** orchestration — not a single prompt.
- "An app someone would actually use": order management is a real operational workflow.

### Security hardening

- **Authentication** — every `/api/*` route (`/health` excepted) requires a
  valid Supabase-issued access token, verified server-side against Supabase
  Auth (`backend/src/middleware/auth.ts`). This is the same login session
  the dashboard/inventory pages already gate behind Supabase Auth (see
  `frontend/middleware.ts`); the frontend attaches it automatically to every
  API call via `frontend/app/lib/apiClient.ts`. When no Supabase project is
  configured at all (zero-config demo mode against the in-memory store),
  auth is skipped entirely — there's no real user system to check a token
  against, matching the frontend's own demo-mode bypass.
- **Rate limiting** — a standard ceiling (120 req/min/IP) applies to all API
  traffic, and a tighter ceiling (20 req/min/IP) applies to endpoints that
  either call the LLM (real Nebius credits per call) or perform a bulk
  destructive write: PO/text order intake, the chat bot, and
  `DELETE /api/orders` (see `backend/src/middleware/rateLimit.ts`).
- **CORS** — restrict which origins may call the API by setting
  `ALLOWED_ORIGINS` (comma-separated) to your deployed frontend URL(s), e.g.
  your Vercel domain. Left unset, all origins are allowed (the previous,
  wide-open default), so existing local setups keep working unchanged.

### Personas: Buyer / Seller / Supplier

Every Supabase-authenticated user has a persona role, read from the
`profiles` table (`supabase/migrations/0005_personas.sql`; assigned
manually for now — insert a row with `role` set to `buyer`, `seller`, or
`supplier`). A user with no `profiles` row defaults to `seller`, and
zero-config demo mode (no Supabase project) always reports `seller`, so the
original single-persona experience is unchanged unless you set up personas.

- **Buyer** — can place a PO and follow its status/agent timeline on
  `/dashboard`, strictly read-only: no Approve/Reject/Retry actions, and no
  access to `/inventory` at all.
- **Seller** — everything the app has always done: full order actions,
  inventory management, *plus* reviewing/approving supplier invoices on the
  new `/invoices` page.
- **Supplier** — sees none of the Buyer/Seller screens. Instead, `/supplier`
  lists the "backfill" restock requests the Supplier Agent registered
  (`backend/src/agents/supplierAgent.ts`, fired the moment the
  Replenishment Agent places one with the vendor, persisted to the
  `restock_orders` table). The human Supplier approves or rejects each
  request:
  - **Approve** hands off to the **Supplier Invoice Agent**
    (`backend/src/agents/supplierInvoiceAgent.ts`), which auto-generates and
    submits an invoice to the Seller for the restock order's agreed
    total_cost — no manual amount entry.
  - **Reject** marks the restock order `supplier_rejected`; no invoice is
    ever created.

  The instant an invoice is created, the **Invoice Validator Agent**
  (`backend/src/agents/invoiceValidatorAgent.ts`) cross-checks its amount
  against the restock order it's billed against and records a
  validated/flagged verdict + note (visible on `/invoices`) — it never
  blocks or auto-decides, only flags a mismatch for the human Seller.

  The Seller then makes the final call on `/invoices`: approving charges
  the invoice via Stripe test mode (`backend/src/services/stripePayment.ts`),
  mirroring the existing Payment Agent flow — and, as the goods-receipt
  confirmation that this stock has actually arrived, immediately credits
  the invoiced quantity onto the SKU's live `quantity_available` in the
  Seller's own `inventory` catalog (`DataStore.receiveInventoryStock`), so a
  backordered order can be retried without a manual Inventory-page bump.
  Rejecting makes no charge and receives no stock.

  End-to-end: **Replenishment Agent** (places the vendor order) → **Supplier
  Agent** (registers it, waits for Supplier approval) → **Supplier Invoice
  Agent** (auto-invoices on approval) → **Invoice Validator Agent**
  (auto-checks the invoice against the restock order) → human **Seller**
  (final approve/reject + payment). Every step logs to the underlying
  order's `agent_logs` timeline (visible in its dashboard detail view) when
  the restock order is tied to a real order.

Every gate is enforced server-side (`requireRole` in
`backend/src/middleware/auth.ts`, applied per-route in `routes/orders.ts`,
`routes/inventory.ts`, `routes/invoices.ts`) — the frontend's role-based nav/
redirects (`frontend/app/lib/useUserRole.ts`) are a UX convenience, not the
actual access boundary.

## Project layout

```
backend/    Express API + LangGraph agent orchestration (Node.js/TypeScript)
frontend/   Next.js live dashboard (place orders, watch agents work in real time)
supabase/   SQL schema/migrations (orders, inventory, payments, shipments, agent_logs, ...)
```

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Run `supabase/migrations/combined_apply_all.sql` in the SQL Editor, or apply
   every migration in `supabase/migrations/` in filename order. The latest
   migrations include atomic inventory reservation and an atomic, retry-safe
   Supplier approval that receives stock and creates its invoice.
3. Grab your Project URL and keys from Project Settings → API:
   - **Publishable/anon key** (`sb_publishable_...`, or legacy `anon` JWT) →
     `NEXT_PUBLIC_SUPABASE_ANON_KEY` (frontend, RLS-restricted).
   - **Secret/service-role key** (`sb_secret_...`, or legacy `service_role`
     JWT) → `SUPABASE_SERVICE_ROLE_KEY` (backend only — this is what lets
     agents bypass RLS to read/write every table). Using the publishable key
     here will fail with `new row violates row-level security policy`.

### 2. Nebius Token Factory

1. Join the [Nebius Builder Program](https://dev.nebius.com/builders) for credits.
2. Create a Token Factory API key at [Nebius AI Studio](https://studio.nebius.com/).
3. Note an available Nemotron model name (e.g. `nvidia/nemotron-3-ultra`, or a Nano/Super variant for cheaper/faster steps).

### 3. Tavily (optional — web search)

1. Get an API key at [tavily.com](https://tavily.com).
2. Set `TAVILY_API_KEY` in `.env`. Left unset, the app runs fine without
   it — the Replenishment Agent just skips the alternative-supplier lookup,
   and the ChatBot Agent falls back to its generic "not sure how to answer
   that" message for questions outside the catalog/order tools.

### 4. Stripe (optional — test-mode payments)

1. Create a free Stripe account and grab a **test-mode** secret key at
   [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
   (starts with `sk_test_...` — never use a live key here).
2. Set `STRIPE_SECRET_KEY` in `.env`. Left unset, the Payment Agent falls
   back to its original simulated ~90%-approval charge.
3. `STRIPE_TEST_PAYMENT_METHOD` (default `pm_card_visa`) and
   `STRIPE_DECLINE_PAYMENT_METHOD` (default `pm_card_chargeDeclined`) select
   which [Stripe test card](https://stripe.com/docs/testing#cards) the
   Payment Agent charges — no real card data is ever collected or sent.
   Pass a `testPaymentMethodId` in the body of `POST /api/orders/:id/retry-payment`
   to retry a declined order with a different test PaymentMethod.

### 5. DSV (optional — sandbox real carrier booking)

1. Register at [developer.dsv.com](https://developer.dsv.com/), subscribe to
   the Connect Booking API, and get approved for **sandbox** access — this
   requires manual approval, unlike Stripe's instant self-serve test keys.
2. Set `DSV_CLIENT_ID`, `DSV_CLIENT_SECRET`, `DSV_SUBSCRIPTION_KEY`, and
   `DSV_ACCOUNT_NUMBER` (your sandbox MDM test account, used as both
   Booking Party and Freight Payer) in `.env`. Left unset, the Fulfillment
   Agent falls back to its original simulated random-carrier shipment.
3. `DSV_SENDER_*` configures a single fixed warehouse/sender address (this
   app has no multi-warehouse concept); `DSV_DEFAULT_PACKAGE_*` configures a
   fixed package weight/dimensions applied to every shipment (the catalog
   has no per-SKU weight/dimensions today — see "Extending" below).
4. Bookings use Road transport mode and submit directly to DSV
   (`autobook: true`). If an order's customer has no shipping/billing
   address on file (e.g. a free-text chat order), or the DSV API call
   fails, the Fulfillment Agent logs a warning and falls back to the
   simulated shipment rather than failing the order.

### 6. Environment variables

```bash
cp .env.example .env
# then fill in SUPABASE_*, NEBIUS_* values in .env
# frontend/.env.local needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_BASE_URL
```

`ALLOWED_ORIGINS` in `.env` defaults to `http://localhost:3000` for local
dev; update it once you deploy (see "Deployment" below).

`REPLENISHMENT_MAX_NEGOTIATION_ROUNDS` (default `3`) caps how many
back-and-forth `propose_restock_order` rounds the Replenishment Agent's
Nemotron negotiation will run per short SKU before it must finalize or give
up (falling back to a list-price `place_restock_order`).

### 7. Install & run

```bash
npm install                 # installs both workspaces
npm run dev:backend         # http://localhost:4000
npm run dev:frontend        # http://localhost:3000 (in a second terminal)
```

Open http://localhost:3000, upload `po/purchase_order_32145.pdf` or another
purchase-order PDF from `po/` (see
"Upload purchase order (PDF)"), and watch the agent timeline populate live.
The PO Intake Agent extracts vendor, line items, and billing/shipping
addresses from the PDF, auto-provisioning unknown SKUs into inventory; the
customer record is created/updated from the PO's own billing contact. Select
an order to see the "Order details" view (items, payment, shipment,
notifications, addresses) or the "Agent timeline" view (raw per-agent log
entries). Try a PO that includes `USB-C Hub` (seeded with 0 stock) to see the
backorder path, a PO whose total exceeds `APPROVAL_THRESHOLD` (default €500)
to see the approval-hold path (Approve/Reject buttons appear on the order),
and re-submit a few times to see the simulated ~10% payment-decline path
(or, with `STRIPE_SECRET_KEY` set, a real Stripe test-mode decline if
`STRIPE_TEST_PAYMENT_METHOD` is set to a decline test PaymentMethod like
`pm_card_chargeDeclined`).

## Extending

- Point `paymentAgent.ts` at a different Stripe PaymentMethod flow (e.g. SEPA, wallets) or swap in another gateway entirely.
- Add real per-SKU package weight/dimensions (a new inventory column) and multi-warehouse sender support to `dsvShipping.ts` instead of the current fixed defaults/single warehouse.
- Add a **Fraud/Risk Agent** or **Returns/Refunds Agent** as additional LangGraph nodes.
- Deploy the backend as a Nebius Serverless Endpoint/Job; deploy the frontend to Vercel or any static host.

## Deployment

No Docker: the frontend deploys to **Vercel** (zero-config Next.js), and the
backend deploys to any host that runs a plain Node.js web service directly
from source — **Render** is used below since it needs no Dockerfile and has
a free tier, but Railway/Fly.io work the same way.

### Backend (Render, or any Node host)

1. Push this repo to GitHub (if not already).
2. On [Render](https://dashboard.render.com), create a **Blueprint** from
   this repo — it reads `render.yaml` at the repo root automatically and
   configures the service (`rootDir: .`, `npm install && npm run build
   --workspace backend`, `npm run start --workspace backend`,
   `healthCheckPath: /health`). No Dockerfile needed.
3. In the Render dashboard, fill in the secret env vars `render.yaml` left
   blank (`sync: false`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `NEBIUS_API_KEY`. Leave `ALLOWED_ORIGINS` blank for now — you'll set it
   in step 3 below, after the frontend has a URL.
4. Deploy, then confirm `https://<your-service>.onrender.com/health` returns
   `{"status":"ok", ...}`.

### Frontend (Vercel)

1. On [Vercel](https://vercel.com/new), import this repo.
2. Set the project's **Root Directory** to `frontend` (this is a monorepo —
   Vercel needs to know Next.js lives in the `frontend/` workspace, not the
   repo root).
3. Add environment variables (Project Settings → Environment Variables):
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — same
     values as `frontend/.env.local`.
   - `NEXT_PUBLIC_API_BASE_URL` — the Render backend URL from step above
     (e.g. `https://autocom-backend.onrender.com`).
4. Deploy. Vercel gives you a `https://<your-app>.vercel.app` URL.

### Close the loop: lock down CORS

Back on Render, set the backend's `ALLOWED_ORIGINS` env var to your Vercel
URL (and `http://localhost:3000` if you still want local dev to work against
the deployed backend), then redeploy the backend service:

```
ALLOWED_ORIGINS=https://your-app.vercel.app,http://localhost:3000
```

Without this step the backend still works (it falls back to allowing all
origins), but locking it down to your real frontend URL(s) is the whole
point of the CORS hardening described above.

## License

MIT — see [LICENSE](./LICENSE).

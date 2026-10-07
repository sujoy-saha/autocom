# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three personas, each gated server-side by a `profiles.role` lookup (`requireRole` middleware): **Buyer** places purchase orders and follows their status/agent timeline read-only (no Approve/Reject/Retry, no Inventory access); **Seller** is internal sales-ops/order-desk staff and approvers — full order actions, inventory management, plus reviewing/approving Supplier invoices; **Supplier** is an external trading partner who sees only its own restock ("backfill") requests and can approve/reject them and track invoice status, with no visibility into any Buyer/Seller screen.

## Product Purpose

AutoCom automates the full order-to-cash flow for partner purchase orders: intake (PDF parsing), inventory check/reservation, approval gating, payment, fulfillment/shipping, and customer notification — all as a chain of autonomous agents (LangGraph + NVIDIA Nemotron via Nebius Token Factory), instead of a human manually re-typing the same order across email, CRM, and ERP. It also runs a second, mirrored agentic commerce mesh on the supply side: when a shortfall triggers a restock order with an external vendor, a Supplier Agent, Supplier Invoice Agent, and Invoice Validator Agent automate registering the request, invoicing, and pre-validating the invoice, with a human decision gating both the Supplier's and the Seller's side. Success means a partner PO becomes a shipped, tracked, invoiced order with zero manual re-entry and a full audit trail — and a vendor shortfall becomes a received, invoiced, paid restock with the same zero-manual-re-entry guarantee.

## Positioning

Replaces manual PO re-typing across email/CRM/ERP with one live, auditable order record and autonomous agents (PO Intake, Inventory, Approval, Replenishment, Payment, Fulfillment, Support). Includes capabilities most manual workflows lack entirely: enforced approval gating on high-value orders, autonomous agent-to-agent vendor negotiation on stock shortfalls (via a second, independent MCP server), and a full supplier-side invoicing mesh (Supplier Agent → Supplier Invoice Agent → Invoice Validator Agent) with persona-based access control (Buyer/Seller/Supplier) enforcing who can see and do what.

## Operating Context

- Order desk: partner uploads/emails a PO PDF; PO Intake Agent extracts vendor, line items, billing/shipping addresses, PO number, grounded against live inventory via MCP tool calls.
- Inventory page (Seller only): sales-ops views/edits stock levels and unit prices, and registers new catalog SKUs by hand — the same catalog the Inventory Agent checks and auto-provisions against, and the same catalog credited atomically when a Supplier confirms a restock.
- Dashboard: shows orders and an append-only agent audit trail (agent_logs) driving live updates via Supabase Realtime; approvers act on orders paused in `pending_approval`. Buyers see the same view read-only.
- Supplier page (`/supplier`, Supplier only): lists restock ("backfill") requests the Supplier Agent registered on a shortfall; Supplier approval atomically credits stock, creates the Supplier Invoice Agent's invoice once, and transitions the request; rejection is terminal and creates no invoice.
- Invoices page (`/invoices`, Seller only): reviews invoices the Supplier Invoice Agent generated, each already carrying an Invoice Validator Agent verdict (validated/flagged); approving charges Stripe test mode, rejecting makes no charge. Goods are credited when the Supplier confirms the restock, not when the Seller later pays.
- Runs in both a "live" mode (real Supabase/Stripe/DSV sandbox credentials) and a "demo mode" fallback (in-memory store, polling instead of Realtime, `requireRole` no-op, `/api/me` always reports `seller`) when credentials aren't configured.

## Capabilities and Constraints

- Hackathon-stage demo; must gracefully fall back to demo mode without Supabase/Stripe/DSV credentials configured.
- Approval threshold is configurable via `APPROVAL_THRESHOLD` (default €500); orders over threshold pause for human Approve/Reject.
- Inventory reservation is all-or-nothing across an order's line items; each SKU decrement uses a conditional atomic Postgres update.
- Supplier approval, goods receipt, and invoice creation are performed as one database transaction and only once for a `placed` restock order, including on concurrent requests.
- Payment (Stripe test mode) and Fulfillment (DSV sandbox) are real sandbox integrations with simulated fallbacks; customer notifications are drafted by Nemotron but written to a notifications table rather than actually emailed.
- Persona roles (`profiles.role`) are assigned manually today (no self-service signup/role picker); a user with no `profiles` row defaults to `seller`.
- All Suppliers share one simulated pool today (not a real multi-tenant marketplace) — every restock request is visible to every Supplier-role user.

## Brand Commitments

Name: AutoCom. Built with NVIDIA Nemotron on Nebius Token Factory, MCP, LangGraph, Supabase — these platform/vendor names are factual and should not be altered or genericized in the UI.

## Evidence on Hand

- `README.md`, `PITCH_DECK.md`, `architecture/ARCHITECTURE_DIAGRAM.md` at the repo root describe the full agent pipeline, persona model, and demo script.
- Demo purchase-order PDFs: `po/purchase_order_32145.pdf` and `po/purchase_order_321775.pdf`.
- No customer testimonials, benchmarks, or pricing exist; do not fabricate any.

## Product Principles

- Every manual re-typing step in the old PO-to-cash flow maps to exactly one autonomous agent — no generic chatbot framing.
- One live record is the single source of truth; never reintroduce copy-paste between views.
- Enforce governance (approval gating) as a first-class, visible workflow state, not an afterthought.
- Every action is logged to an append-only audit trail visible to the user — transparency over black-box automation.
- Agents prepare and inform; they never bypass a human decision at a money- or commitment-changing boundary (order approval, invoice approval, restock acceptance).
- Persona access is enforced server-side, never trusted from the frontend alone.
- Always degrade gracefully to demo mode rather than failing when live credentials are absent.

## Accessibility & Inclusion

None specified beyond standard web accessibility.

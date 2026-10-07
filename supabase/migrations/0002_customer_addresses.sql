-- Adds billing/shipping address storage to customers, populated by the PO
-- Intake Agent when it extracts address blocks from an uploaded PO PDF
-- (see backend/src/agents/poParser.ts's ParsedAddress / poIntakeAgent.ts).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table customers
  add column if not exists billing_address jsonb,
  add column if not exists shipping_address jsonb;

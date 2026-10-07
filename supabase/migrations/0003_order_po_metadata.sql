-- Adds PO metadata columns to orders, populated by the PO Intake Agent when
-- it parses an uploaded PO PDF (see backend/src/agents/poIntakeAgent.ts).
-- Run via `supabase db push` or paste into the Supabase SQL editor.

alter table orders
  add column if not exists po_number text,
  add column if not exists po_date text,
  add column if not exists customer_account_number text;

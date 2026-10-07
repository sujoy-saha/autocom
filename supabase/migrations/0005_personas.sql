-- Persona-based access: Buyer / Seller / Supplier.
--
-- Roles are assigned manually for now (no self-service signup flow):
--   insert into profiles (user_id, email, role) values ('<auth-user-uuid>', 'someone@example.com', 'buyer');
--
-- No RLS policies here, matching the existing convention for orders/
-- agent_logs (see 0001_init.sql) -- authorization is enforced server-side
-- in the Express backend (see backend/src/middleware/auth.ts's
-- requireRole), not via Postgres RLS.

create table if not exists profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'seller' check (role in ('buyer', 'seller', 'supplier')),
  created_at timestamptz not null default now()
);

-- Vendor/backfill restock orders placed by the Replenishment Agent (see
-- backend/src/agents/replenishmentAgent.ts) against the (simulated)
-- external vendor's MCP server (backend/src/mcp/vendorServer.ts).
-- Persisting these -- rather than leaving them only in the vendor's own
-- in-memory store -- is what lets a real logged-in Supplier user see and
-- invoice them.
create table if not exists restock_orders (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id),
  sku text not null,
  quantity int not null,
  unit_price numeric(10, 2) not null,
  total_cost numeric(10, 2) not null,
  eta_days int,
  vendor_order_id text,
  -- placed -> invoiced -> invoice_approved | invoice_rejected -> paid
  status text not null default 'placed'
    check (status in ('placed', 'invoiced', 'invoice_approved', 'invoice_rejected', 'paid')),
  created_at timestamptz not null default now()
);

-- Invoices a Supplier submits against a restock order for a Seller to
-- review/approve, mirroring the existing Payment Agent's Stripe test-mode
-- pattern (see backend/src/services/stripePayment.ts) on approval.
create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  restock_order_id uuid references restock_orders (id) not null,
  amount numeric(10, 2) not null,
  currency text not null default 'eur',
  -- draft -> submitted -> approved | rejected -> (approved orders also get paid via Stripe)
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  provider_ref text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable Realtime so the Supplier/Seller pages can live-update the same way
-- the existing dashboard does for orders/agent_logs.
alter publication supabase_realtime add table restock_orders;
alter publication supabase_realtime add table invoices;

-- Order Orchestrator: initial schema
-- Run via `supabase db push` or paste into the Supabase SQL editor.

create extension if not exists "uuid-ossp";

-- Customers placing orders
create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

-- Product catalog / stock levels used by the Inventory Agent
create table if not exists inventory (
  sku text primary key,
  name text not null,
  quantity_available int not null default 0,
  unit_price numeric(10, 2) not null default 0,
  updated_at timestamptz not null default now()
);

-- One row per order, mutated as agents progress it through the pipeline
create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers (id),
  raw_request text not null,               -- original natural-language order text
  items jsonb not null default '[]',        -- [{sku, quantity, unit_price}]
  status text not null default 'received',  -- received -> inventory_checked -> paid -> fulfilled -> completed | backordered | payment_failed | cancelled
  total_amount numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Payment attempts (simulated payment gateway)
create table if not exists payments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  amount numeric(10, 2) not null,
  status text not null default 'pending', -- pending -> succeeded | failed
  provider_ref text,
  created_at timestamptz not null default now()
);

-- Shipments created by the Fulfillment Agent
create table if not exists shipments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  carrier text,
  tracking_number text,
  status text not null default 'pending', -- pending -> shipped -> delivered
  created_at timestamptz not null default now()
);

-- Customer-facing notifications drafted by the Support Agent
create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  channel text not null default 'email',
  message text not null,
  created_at timestamptz not null default now()
);

-- Append-only audit trail of every agent decision, used to drive the live
-- dashboard timeline via Supabase Realtime.
create table if not exists agent_logs (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  agent text not null,       -- intake | inventory | payment | fulfillment | support
  action text not null,      -- short machine label, e.g. "stock_reserved"
  detail text,               -- human-readable / LLM-generated explanation
  created_at timestamptz not null default now()
);

-- Enable Realtime on the tables the dashboard subscribes to.
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table agent_logs;

-- Seed a small catalog so the demo works out of the box.
insert into inventory (sku, name, quantity_available, unit_price) values
  ('SKU-001', 'Wireless Mouse', 25, 19.99),
  ('SKU-002', 'Mechanical Keyboard', 10, 89.99),
  ('SKU-003', 'USB-C Hub', 0, 34.50),
  ('SKU-004', '27" Monitor', 5, 249.00)
on conflict (sku) do nothing;

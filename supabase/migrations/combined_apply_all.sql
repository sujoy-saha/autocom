-- Combined migration: paste this whole file into the Supabase SQL Editor
-- (Project -> SQL Editor -> New query -> Run) to set up the schema in one go.
-- Equivalent to running 0001_init.sql, 0002_customer_addresses.sql,
-- 0003_order_po_metadata.sql, 0004_order_number.sql, 0005_personas.sql,
-- 0006_supplier_agent_workflow.sql, 0007_atomic_inventory_reservation.sql,
-- 0008_atomic_restock_approval.sql
-- in order. Safe to re-run (uses IF NOT EXISTS / DROP CONSTRAINT IF EXISTS /
-- CREATE OR REPLACE FUNCTION).

-- ===== 0001_init.sql =====
create extension if not exists "uuid-ossp";

create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists inventory (
  sku text primary key,
  name text not null,
  quantity_available int not null default 0,
  unit_price numeric(10, 2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  customer_id uuid references customers (id),
  raw_request text not null,
  items jsonb not null default '[]',
  status text not null default 'received',
  total_amount numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  amount numeric(10, 2) not null,
  status text not null default 'pending',
  provider_ref text,
  created_at timestamptz not null default now()
);

create table if not exists shipments (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  carrier text,
  tracking_number text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists notifications (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  channel text not null default 'email',
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists agent_logs (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id) not null,
  agent text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'orders'
  ) then
    alter publication supabase_realtime add table orders;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'agent_logs'
  ) then
    alter publication supabase_realtime add table agent_logs;
  end if;
end $$;

insert into inventory (sku, name, quantity_available, unit_price) values
  ('SKU-001', 'Wireless Mouse', 25, 19.99),
  ('SKU-002', 'Mechanical Keyboard', 10, 89.99),
  ('SKU-003', 'USB-C Hub', 0, 34.50),
  ('SKU-004', '27" Monitor', 5, 249.00)
on conflict (sku) do nothing;

-- ===== 0002_customer_addresses.sql =====
alter table customers
  add column if not exists billing_address jsonb,
  add column if not exists shipping_address jsonb;

-- ===== 0003_order_po_metadata.sql =====
alter table orders
  add column if not exists po_number text,
  add column if not exists po_date text,
  add column if not exists customer_account_number text;

-- ===== 0004_order_number.sql =====
alter table orders
  add column if not exists order_seq bigserial;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_order_seq_key'
  ) then
    alter table orders add constraint orders_order_seq_key unique (order_seq);
  end if;
end $$;

-- ===== 0005_personas.sql =====
create table if not exists profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'seller' check (role in ('buyer', 'seller', 'supplier')),
  created_at timestamptz not null default now()
);

create table if not exists restock_orders (
  id uuid primary key default uuid_generate_v4(),
  order_id uuid references orders (id),
  sku text not null,
  quantity int not null,
  unit_price numeric(10, 2) not null,
  total_cost numeric(10, 2) not null,
  eta_days int,
  vendor_order_id text,
  status text not null default 'placed'
    check (status in ('placed', 'invoiced', 'invoice_approved', 'invoice_rejected', 'paid')),
  created_at timestamptz not null default now()
);

create table if not exists invoices (
  id uuid primary key default uuid_generate_v4(),
  restock_order_id uuid references restock_orders (id) not null,
  amount numeric(10, 2) not null,
  currency text not null default 'eur',
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'paid')),
  provider_ref text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter publication supabase_realtime add table restock_orders;
alter publication supabase_realtime add table invoices;

-- ===== 0006_supplier_agent_workflow.sql =====
alter table restock_orders drop constraint if exists restock_orders_status_check;
alter table restock_orders add constraint restock_orders_status_check
  check (status in ('placed', 'invoiced', 'invoice_approved', 'invoice_rejected', 'supplier_rejected', 'paid'));

alter table invoices add column if not exists validation_status text
  check (validation_status in ('validated', 'flagged'));
alter table invoices add column if not exists validation_note text;

-- ===== 0007_atomic_inventory_reservation.sql =====
create or replace function reserve_inventory(p_sku text, p_qty int)
returns boolean
language sql
as $$
  with updated as (
    update inventory
    set quantity_available = quantity_available - p_qty, updated_at = now()
    where sku = p_sku and quantity_available >= p_qty
    returning 1
  )
  select exists(select 1 from updated);
$$;

create or replace function release_inventory(p_sku text, p_qty int)
returns void
language sql
as $$
  update inventory
  set quantity_available = quantity_available + p_qty, updated_at = now()
  where sku = p_sku;
$$;

-- ===== 0008_atomic_restock_approval.sql =====
create or replace function receive_inventory_stock(p_sku text, p_qty int)
returns void
language plpgsql
as $$
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'p_qty must be positive' using errcode = '22023';
  end if;

  insert into inventory (sku, name, quantity_available, unit_price)
  values (p_sku, p_sku, p_qty, 0)
  on conflict (sku) do update
    set quantity_available = inventory.quantity_available + excluded.quantity_available,
        updated_at = now();
end;
$$;

create or replace function approve_restock_order(
  p_restock_order_id uuid,
  p_invoice_amount numeric,
  p_invoice_note text
)
returns setof invoices
language plpgsql
as $$
declare
  v_restock_order restock_orders%rowtype;
  v_invoice invoices%rowtype;
begin
  if p_invoice_amount is null or p_invoice_amount <= 0 then
    raise exception 'p_invoice_amount must be positive' using errcode = '22023';
  end if;

  select * into v_restock_order
  from restock_orders
  where id = p_restock_order_id and status = 'placed'
  for update;

  if not found then
    return;
  end if;

  perform receive_inventory_stock(v_restock_order.sku, v_restock_order.quantity);

  insert into invoices (restock_order_id, amount, currency, status, note)
  values (v_restock_order.id, p_invoice_amount, 'eur', 'submitted', p_invoice_note)
  returning * into v_invoice;

  update restock_orders
  set status = 'invoiced'
  where id = v_restock_order.id;

  return next v_invoice;
end;
$$;

revoke all on function receive_inventory_stock(text, int) from public;
revoke all on function approve_restock_order(uuid, numeric, text) from public;
grant execute on function receive_inventory_stock(text, int) to service_role;
grant execute on function approve_restock_order(uuid, numeric, text) to service_role;

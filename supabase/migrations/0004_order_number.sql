-- Adds a human-readable, sequential order number (e.g. "ORD-000042") so the
-- UI and chat bot don't have to show/ask for the raw UUID primary key.
-- `order_seq` auto-increments via an implicit sequence; the app formats it
-- as "ORD-NNNNNN" (see backend/src/utils/orderId.ts's formatOrderNumber).
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

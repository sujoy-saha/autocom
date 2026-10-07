-- Atomically receive a supplier restock and create its invoice exactly once.
-- The row lock makes concurrent approval/retry requests observe the transition
-- from "placed" only once; the inventory upsert adds stock without a
-- read-then-write lost-update race.
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

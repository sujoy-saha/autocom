-- Atomic inventory reservation: fixes a race condition where the Inventory
-- Agent's old read-then-write pattern (SELECT quantity_available, then
-- UPDATE ... SET quantity_available = <computed value>) let two concurrent
-- orders for the same SKU both read sufficient stock and both succeed,
-- overselling it. These functions make the check-and-decrement a single
-- atomic statement at the database level instead.
--
-- reserve_inventory: attempts to decrement `sku`'s quantity_available by
-- p_qty, but only if enough stock is available -- the WHERE clause and the
-- decrement happen in one atomic UPDATE, so concurrent callers are
-- serialized by Postgres's own row-level locking rather than racing each
-- other in application code. Returns true if the reservation succeeded,
-- false if there wasn't enough stock (caller should treat the SKU as
-- backordered; see backend/src/agents/inventoryAgent.ts).
create or replace function reserve_inventory(p_sku text, p_qty int)
returns boolean
language sql
as $$
  -- Wrapped in exists(...) rather than a bare `returning` so this always
  -- yields exactly one row (true/false), never zero rows/NULL, when the
  -- WHERE clause excludes every row (SKU missing or insufficient stock).
  with updated as (
    update inventory
    set quantity_available = quantity_available - p_qty, updated_at = now()
    where sku = p_sku and quantity_available >= p_qty
    returning 1
  )
  select exists(select 1 from updated);
$$;

-- release_inventory: the inverse -- used to roll back a reservation made
-- earlier in the same order when a *different* line item in that order
-- turns out to be short (so a partial shortfall never leaves other SKUs
-- silently held while the order as a whole is backordered).
create or replace function release_inventory(p_sku text, p_qty int)
returns void
language sql
as $$
  update inventory
  set quantity_available = quantity_available + p_qty, updated_at = now()
  where sku = p_sku;
$$;

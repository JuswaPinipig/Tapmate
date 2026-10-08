-- ============================================================
-- TapMate Stock & Inventory (non-AI)
-- Supabase > SQL Editor > New query > paste all > Run. Safe to re-run.
-- Run AFTER adminproducts.sql (needs public.products and is_admin_card()).
--
-- What this adds (it reuses public.products, nothing is duplicated):
--   products.stock          current quantity (never negative)
--   stock_settings          one row: the low-stock threshold
--   stock_movements         stock history / audit trail (who, when, why)
--   stock_adjust()          admin: add / remove / set exact stock (logged)
--   stock_set_threshold()   admin: change the low-stock threshold
--   stock_deduct_items()    for the purchase/transaction function to call
--
-- Stock STATUS is not stored: it is derived from stock + threshold, so it
-- can never go out of date:  0 = Sold Out, <= threshold = Low Stock, else Available.
-- ============================================================

-- 1) Stock column on the existing products table
alter table public.products
    add column if not exists stock integer not null default 0 check (stock >= 0 and stock <= 1000000);

-- 2) Low-stock threshold (single row)
create table if not exists public.stock_settings (
    id                  boolean primary key default true check (id),
    low_stock_threshold integer not null default 5 check (low_stock_threshold between 0 and 100000),
    updated_at          timestamptz not null default now()
);
insert into public.stock_settings (id) values (true) on conflict do nothing;

alter table public.stock_settings enable row level security;
drop policy if exists "stock settings read" on public.stock_settings;
create policy "stock settings read" on public.stock_settings for select using (true);
grant select on public.stock_settings to anon, authenticated;

-- 3) Stock history. Rows are written ONLY by the functions below.
create table if not exists public.stock_movements (
    id             uuid primary key default gen_random_uuid(),
    product_id     uuid references public.products (id) on delete set null,
    product_name   text not null,
    action         text not null check (action in ('add', 'remove', 'adjust', 'sale')),
    previous_stock integer not null,
    change         integer not null,
    new_stock      integer not null check (new_stock >= 0),
    reason         text,
    actor_name     text,
    actor_role     text,
    created_at     timestamptz not null default now()
);
create index if not exists stock_movements_product_idx on public.stock_movements (product_id, created_at desc);
create index if not exists stock_movements_created_idx on public.stock_movements (created_at desc);

alter table public.stock_movements enable row level security;
drop policy if exists "stock movements admin read" on public.stock_movements;
create policy "stock movements admin read" on public.stock_movements for select using (public.is_admin_card());
grant select on public.stock_movements to anon, authenticated;   -- RLS above: admins only

-- 4) Guard: stock may only change through the functions below (so every change is logged)
create or replace function public.products_guard_stock()
returns trigger language plpgsql as $$
begin
    if coalesce(current_setting('app.stock_rpc', true), 'off') = 'on' then
        return new;
    end if;
    if tg_op = 'INSERT' then
        new.stock := 0;
    elsif new.stock is distinct from old.stock then
        raise exception 'Stock can only be changed through Stock & Inventory.' using errcode = 'P0001';
    end if;
    return new;
end $$;

drop trigger if exists products_guard_stock on public.products;
create trigger products_guard_stock before insert or update on public.products
    for each row execute function public.products_guard_stock();

-- 5) Who is acting? (reads the same x-card-token header as is_admin_card())
create or replace function public.stock_actor(out actor_name text, out actor_role text)
language plpgsql stable security definer set search_path = public as $$
declare tok text; s jsonb;
begin
    tok := nullif(coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-card-token', '');
    if tok is null then return; end if;
    s := to_jsonb(public.card_session(tok));
    actor_role := s ->> 'role';
    actor_name := coalesce(nullif(s ->> 'name', ''), nullif(s ->> 'full_name', ''),
                           nullif(s ->> 'username', ''), initcap(actor_role));
exception when others then
    null;
end $$;

-- 6) Core: change stock + write the history row, atomically, never below zero
create or replace function public.stock_apply(
    p_product_id uuid, p_action text, p_qty integer, p_reason text,
    p_actor_name text, p_actor_role text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prod record; newv integer;
begin
    if p_qty is null or p_qty < 0 or p_qty > 1000000
       or (p_action in ('add', 'remove', 'sale') and p_qty = 0)
       or p_action not in ('add', 'remove', 'adjust', 'sale') then
        return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;

    select id, name, stock into prod from public.products where id = p_product_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;

    newv := case p_action
        when 'add' then prod.stock + p_qty
        when 'remove' then prod.stock - p_qty
        when 'sale' then prod.stock - p_qty
        else p_qty            -- 'adjust' = set the exact total
    end;

    if newv < 0 then
        return jsonb_build_object('ok', false, 'reason', 'negative', 'name', prod.name, 'stock', prod.stock);
    end if;
    if newv > 1000000 then
        return jsonb_build_object('ok', false, 'reason', 'too_large');
    end if;
    if newv = prod.stock then
        return jsonb_build_object('ok', false, 'reason', 'no_change', 'stock', prod.stock);
    end if;

    perform set_config('app.stock_rpc', 'on', true);
    update public.products set stock = newv where id = prod.id;
    perform set_config('app.stock_rpc', 'off', true);

    insert into public.stock_movements
        (product_id, product_name, action, previous_stock, change, new_stock, reason, actor_name, actor_role)
    values
        (prod.id, prod.name, p_action, prod.stock, newv - prod.stock, newv,
         nullif(btrim(coalesce(p_reason, '')), ''), p_actor_name, p_actor_role);

    return jsonb_build_object('ok', true, 'previous', prod.stock, 'new', newv, 'change', newv - prod.stock);
end $$;

revoke all on function public.stock_apply(uuid, text, integer, text, text, text) from public, anon, authenticated;

-- 7) Admin: add / remove / set exact stock (reason is optional; the page sends 'adjust' with the new total)
create or replace function public.stock_adjust(
    p_product_id uuid, p_action text, p_qty integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a record;
begin
    if not public.is_admin_card() then
        return jsonb_build_object('ok', false, 'reason', 'admin');
    end if;
    if p_action not in ('add', 'remove', 'adjust') then
        return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
    select * into a from public.stock_actor();
    return public.stock_apply(p_product_id, p_action, p_qty, left(btrim(p_reason), 200), a.actor_name, a.actor_role);
end $$;

grant execute on function public.stock_adjust(uuid, text, integer, text) to anon, authenticated;

-- 8) Admin: low-stock threshold
create or replace function public.stock_set_threshold(p_value integer)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
    if not public.is_admin_card() then
        return jsonb_build_object('ok', false, 'reason', 'admin');
    end if;
    if p_value is null or p_value < 0 or p_value > 100000 then
        return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
    update public.stock_settings set low_stock_threshold = p_value, updated_at = now() where id;
    return jsonb_build_object('ok', true, 'value', p_value);
end $$;

grant execute on function public.stock_set_threshold(integer) to anon, authenticated;

-- 9) Sales: call this from INSIDE the function that confirms a canteen transaction.
--    p_items = [{"product_id": "<uuid>", "qty": 2}, ...]
--    If any item is sold out or short, it RAISES, so the whole transaction rolls back
--    (nothing is charged, no stock changes). Not callable from the browser on purpose;
--    the transaction function must be SECURITY DEFINER to call it.
create or replace function public.stock_deduct_items(
    p_items jsonb,
    p_reason text default 'Student purchase',
    p_actor_name text default null,
    p_actor_role text default 'cashier')
returns void language plpgsql security definer set search_path = public as $$
declare it record; res jsonb; pname text;
begin
    for it in
        select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'qty')::integer)::integer as qty
          from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) e
         group by 1 order by 1                                   -- fixed lock order: no deadlocks
    loop
        res := public.stock_apply(it.product_id, 'sale', it.qty, p_reason, p_actor_name, p_actor_role);
        if not coalesce((res ->> 'ok')::boolean, false) then
            select name into pname from public.products where id = it.product_id;
            raise exception 'OUT_OF_STOCK: % (% left, % requested)',
                coalesce(pname, it.product_id::text), coalesce(res ->> 'stock', '0'), it.qty
                using errcode = 'P0001';
        end if;
    end loop;
end $$;

revoke all on function public.stock_deduct_items(jsonb, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- OPTIONAL one-time carry-over of stock from your OLD inventory tables.
-- I could not see inventory.sql, so the table/column names below are a TEMPLATE.
-- Edit them, uncomment, run once, then check the numbers.
--
-- do $$ begin
--     perform set_config('app.stock_rpc', 'on', true);
--     update public.products p set stock = greatest(0, o.quantity)
--       from public.<old_inventory_table> o where o.product_id = p.id;
-- end $$;
-- ------------------------------------------------------------

notify pgrst, 'reload schema';

-- Verify: should list the column and both tables
select 'column' as kind, column_name as name from information_schema.columns
 where table_schema = 'public' and table_name = 'products' and column_name = 'stock'
union all
select 'table', table_name from information_schema.tables
 where table_schema = 'public' and table_name in ('stock_settings', 'stock_movements');
-- ============================================================
-- TapMate v8 migration: Cashier Kiosk. Run AFTER studentwallet2.sql / adminproducts.sql. Safe to re-run.
-- Supabase > SQL Editor > New query.
--
-- Adds:
--   * products.yolo_label      - the exact class name your YOLO model uses for that product
--   * kiosk_orders / lines     - ONE shared order per cashier (the kiosk and the Register page both read/write it)
--   * kiosk_sales              - receipt log of every kiosk sale
--   * kiosk_* functions        - order sync + kiosk_checkout (RFID tap -> deduct wallet), all in one transaction
--
-- ASSUMPTIONS to double-check (they come from login.sql, which I haven't seen):
--   accounts.role   : 'student' | 'cashier' | 'admin'   (text/enum)
--   accounts.status : 'active'
--   accounts.rfid_uid holds the card UID as text
--   public.transactions(account_id, type, amount, description, location, created_at) exists (same as the wallet page)
-- ============================================================

alter table public.products add column if not exists yolo_label text;
create unique index if not exists products_yolo_label_uq on public.products (lower(yolo_label)) where yolo_label is not null;

insert into public.app_settings (key, value) values ('pay_later_due_days', '7') on conflict (key) do nothing;

create table if not exists public.kiosk_orders (
    cashier_id uuid primary key references public.accounts (id) on delete cascade,
    payment    text not null default 'rfid' check (payment in ('rfid', 'paylater')),
    version    bigint not null default 0,
    updated_at timestamptz not null default now()
);
create table if not exists public.kiosk_order_lines (
    cashier_id uuid not null references public.kiosk_orders (cashier_id) on delete cascade,
    product_id uuid not null references public.products (id) on delete cascade,
    qty        int  not null check (qty between 1 and 99),
    ai         boolean not null default false,          -- true = at least one was added by the camera
    added_at   timestamptz not null default now(),
    primary key (cashier_id, product_id)
);
create table if not exists public.kiosk_sales (
    id         uuid primary key default gen_random_uuid(),
    cashier_id uuid not null references public.accounts (id),
    account_id uuid not null references public.accounts (id),
    total      numeric(12,2) not null,
    method     text not null,
    items      jsonb not null,
    created_at timestamptz not null default now()
);
create index if not exists kiosk_sales_cashier_idx on public.kiosk_sales (cashier_id, created_at desc);

alter table public.kiosk_orders      enable row level security;
alter table public.kiosk_order_lines enable row level security;
alter table public.kiosk_sales       enable row level security;
revoke all on public.kiosk_orders, public.kiosk_order_lines, public.kiosk_sales from anon, authenticated;

-- ---------- helpers ----------
create or replace function public._kiosk_cashier(p_token text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid; r text;
begin
    v := public._token_account(p_token);
    if v is null then return null; end if;
    select lower(role::text) into r from public.accounts where id = v;
    if r in ('cashier', 'admin') then return v; end if;
    return null;
end $$;

create or replace function public._kiosk_touch(c uuid) returns void
language sql security definer set search_path = public as $$
    insert into public.kiosk_orders (cashier_id) values (c)
    on conflict (cashier_id) do update set version = public.kiosk_orders.version + 1, updated_at = now()
$$;

create or replace function public._kiosk_order_json(c uuid) returns jsonb
language sql stable security definer set search_path = public as $$
    select jsonb_build_object('ok', true,
        'version', coalesce((select version from public.kiosk_orders where cashier_id = c), 0),
        'payment', coalesce((select payment from public.kiosk_orders where cashier_id = c), 'rfid'),
        'items', coalesce((select jsonb_agg(jsonb_build_object('product_id', l.product_id, 'qty', l.qty, 'ai', l.ai)
                                            order by l.added_at)
                             from public.kiosk_order_lines l where l.cashier_id = c), '[]'::jsonb))
$$;
revoke execute on function public._kiosk_cashier(text), public._kiosk_touch(uuid), public._kiosk_order_json(uuid)
    from public, anon, authenticated;

-- ---------- who is this cashier ----------
create or replace function public.kiosk_whoami(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid; a public.accounts;
begin
    c := public._kiosk_cashier(p_token);
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into a from public.accounts where id = c;
    return jsonb_build_object('ok', true, 'id', a.id, 'name', coalesce(a.full_name, a.first_name), 'role', a.role::text);
end $$;

-- ---------- shared order ----------
create or replace function public.kiosk_get_order(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    return public._kiosk_order_json(c);
end $$;

-- Atomic "+qty": two devices adding at the same moment never overwrite each other
create or replace function public.kiosk_add_item(p_token text, p_product_id uuid, p_qty int default 1, p_ai boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if not exists (select 1 from public.products where id = p_product_id and status = 'active') then
        return jsonb_build_object('ok', false, 'reason', 'unavailable');
    end if;
    perform public._kiosk_touch(c);
    insert into public.kiosk_order_lines (cashier_id, product_id, qty, ai)
    values (c, p_product_id, least(greatest(p_qty, 1), 99), p_ai)
    on conflict (cashier_id, product_id) do update
        set qty = least(public.kiosk_order_lines.qty + excluded.qty, 99),
            ai  = public.kiosk_order_lines.ai or excluded.ai;
    return public._kiosk_order_json(c);
end $$;

-- Cashier-only edit: set an exact quantity (0 removes the line). The camera never calls this.
create or replace function public.kiosk_set_qty(p_token text, p_product_id uuid, p_qty int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    perform public._kiosk_touch(c);
    if p_qty <= 0 then
        delete from public.kiosk_order_lines where cashier_id = c and product_id = p_product_id;
    else
        insert into public.kiosk_order_lines (cashier_id, product_id, qty) values (c, p_product_id, least(p_qty, 99))
        on conflict (cashier_id, product_id) do update set qty = least(p_qty, 99);
    end if;
    return public._kiosk_order_json(c);
end $$;

create or replace function public.kiosk_clear_order(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    perform public._kiosk_touch(c);
    delete from public.kiosk_order_lines where cashier_id = c;
    return public._kiosk_order_json(c);
end $$;

create or replace function public.kiosk_set_payment(p_token text, p_method text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if p_method not in ('rfid', 'paylater') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
    perform public._kiosk_touch(c);
    update public.kiosk_orders set payment = p_method where cashier_id = c;
    return public._kiosk_order_json(c);
end $$;

-- ---------- RFID tap = pay ----------
-- Prices come from the products table (never from the app), the student is found by the card UID,
-- and the wallet deduction, transaction row, receipt and order clearing all succeed or fail together.
create or replace function public.kiosk_checkout(p_token text, p_rfid text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c uuid; o public.kiosk_orders; a public.accounts;
    v_uid text; v_total numeric(12,2); v_missing int; v_n int; v_items jsonb;
    v_cap numeric; v_spent numeric; v_new numeric; v_days int; v_sale uuid;
begin
    c := public._kiosk_cashier(p_token);
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into o from public.kiosk_orders where cashier_id = c for update;
    if not found or not exists (select 1 from public.kiosk_order_lines where cashier_id = c) then
        return jsonb_build_object('ok', false, 'reason', 'empty');
    end if;

    select count(*) filter (where p.id is null or p.status <> 'active'),
           coalesce(sum(p.price * l.qty), 0), sum(l.qty),
           jsonb_agg(jsonb_build_object('name', p.name, 'qty', l.qty, 'price', p.price) order by l.added_at)
      into v_missing, v_total, v_n, v_items
      from public.kiosk_order_lines l left join public.products p on p.id = l.product_id
     where l.cashier_id = c;
    if v_missing > 0 then return jsonb_build_object('ok', false, 'reason', 'unavailable'); end if;

    v_uid := upper(regexp_replace(coalesce(p_rfid, ''), '\s', '', 'g'));
    if length(v_uid) < 4 then return jsonb_build_object('ok', false, 'reason', 'unknown_card'); end if;
    select * into a from public.accounts
     where upper(regexp_replace(coalesce(rfid_uid, ''), '\s', '', 'g')) = v_uid for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_card'); end if;
    if a.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
    if lower(coalesce(a.role::text, 'student')) <> 'student' then
        return jsonb_build_object('ok', false, 'reason', 'not_student');
    end if;

    -- daily limit set by the admin / spending limit set by the student: the lower one wins
    select min(x) into v_cap from (values (a.daily_limit), (a.spending_limit)) t(x) where x is not null and x > 0;
    if v_cap is not null then
        select coalesce(sum(amount), 0) into v_spent from public.transactions
         where account_id = a.id and type = 'purchase'
           and created_at >= (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila');
        if v_spent + v_total > v_cap then
            return jsonb_build_object('ok', false, 'reason', 'over_limit', 'remaining', greatest(v_cap - v_spent, 0));
        end if;
    end if;

    if o.payment = 'paylater' then
        if not a.pay_later_enabled then return jsonb_build_object('ok', false, 'reason', 'paylater_off'); end if;
        if a.pay_later_outstanding > 0 and a.pay_later_due_at is not null and a.pay_later_due_at < now() then
            return jsonb_build_object('ok', false, 'reason', 'paylater_overdue');
        end if;
        if a.pay_later_limit - a.pay_later_outstanding < v_total then
            return jsonb_build_object('ok', false, 'reason', 'paylater_limit',
                                      'available', greatest(a.pay_later_limit - a.pay_later_outstanding, 0));
        end if;
        v_days := public._setting_num('pay_later_due_days', 7)::int;
        update public.accounts
           set pay_later_outstanding = pay_later_outstanding + v_total,
               pay_later_due_at = case when pay_later_outstanding = 0 or pay_later_due_at is null
                                       then now() + make_interval(days => v_days) else pay_later_due_at end
         where id = a.id;
        v_new := a.balance;
    else
        if a.balance < v_total then
            return jsonb_build_object('ok', false, 'reason', 'insufficient', 'balance', a.balance);
        end if;
        update public.accounts set balance = balance - v_total where id = a.id returning balance into v_new;
    end if;

    insert into public.transactions (account_id, type, amount, description, location)
    values (a.id, 'purchase', v_total,
            'Kiosk purchase (' || v_n || ' item' || case when v_n = 1 then '' else 's' end || ')'
                || case when o.payment = 'paylater' then ' - Pay Later' else '' end,
            'Kiosk');
    insert into public.kiosk_sales (cashier_id, account_id, total, method, items)
    values (c, a.id, v_total, o.payment, v_items) returning id into v_sale;

    perform public._kiosk_touch(c);
    delete from public.kiosk_order_lines where cashier_id = c;

    return jsonb_build_object('ok', true, 'sale_id', v_sale, 'total', v_total, 'method', o.payment,
        'student', coalesce(a.first_name, a.full_name), 'new_balance', v_new,
        'pay_later_available', greatest(a.pay_later_limit - a.pay_later_outstanding - case when o.payment = 'paylater' then v_total else 0 end, 0));
end $$;

revoke execute on function public.kiosk_whoami(text), public.kiosk_get_order(text),
    public.kiosk_add_item(text, uuid, int, boolean), public.kiosk_set_qty(text, uuid, int),
    public.kiosk_clear_order(text), public.kiosk_set_payment(text, text), public.kiosk_checkout(text, text) from public;
grant execute on function public.kiosk_whoami(text), public.kiosk_get_order(text),
    public.kiosk_add_item(text, uuid, int, boolean), public.kiosk_set_qty(text, uuid, int),
    public.kiosk_clear_order(text), public.kiosk_set_payment(text, text), public.kiosk_checkout(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
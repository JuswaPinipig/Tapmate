-- =====================================================================
-- TapMate · Student History (purchases from the kiosk + top-ups)
-- Run once in the Supabase SQL editor.
--
-- 1) purchase_receipts / purchase_receipt_items  -> every kiosk payment, saved as a receipt snapshot
-- 2) record_purchase_receipt(...)                -> kiosk_checkout calls this ONE line when a payment succeeds
-- 3) student_history(p_token)                    -> what studenthistory.js reads (purchases + top-ups)
-- =====================================================================

-- ---------- 1. receipts ----------
-- Keyed by student_id (YYYY-NNNNNN) and storing names/prices as a snapshot, so a receipt never changes
-- even if a product is renamed, repriced or removed later.
create table if not exists public.purchase_receipts (
    id                  uuid primary key default gen_random_uuid(),
    reference           text not null unique,
    student_id          text not null check (student_id ~ '^[0-9]{4}-[0-9]{6}$'),
    student_name        text,
    cashier_name        text,
    method              text not null default 'rfid' check (method in ('rfid', 'paylater')),
    total               numeric(12,2) not null check (total >= 0),
    balance_after       numeric(12,2),
    pay_later_available numeric(12,2),
    remaining_today     numeric(12,2),
    created_at          timestamptz not null default now()
);

create table if not exists public.purchase_receipt_items (
    id         bigserial primary key,
    receipt_id uuid not null references public.purchase_receipts(id) on delete cascade,
    name       text not null,
    qty        integer not null check (qty > 0),
    price      numeric(12,2) not null check (price >= 0)
);

create index if not exists purchase_receipts_student_idx on public.purchase_receipts (student_id, created_at desc);
create index if not exists purchase_receipt_items_receipt_idx on public.purchase_receipt_items (receipt_id);

-- Nobody reads these tables directly: students go through student_history() below.
alter table public.purchase_receipts      enable row level security;
alter table public.purchase_receipt_items enable row level security;

-- ---------- 2. save a receipt (called by the kiosk checkout) ----------
create or replace function public.record_purchase_receipt(
    p_reference text, p_student_id text, p_student_name text, p_cashier_name text, p_method text,
    p_total numeric, p_items jsonb,
    p_balance_after numeric default null, p_pay_later_available numeric default null,
    p_remaining_today numeric default null, p_paid_at timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
    insert into purchase_receipts (reference, student_id, student_name, cashier_name, method, total,
                                   balance_after, pay_later_available, remaining_today, created_at)
    values (p_reference, p_student_id, p_student_name, p_cashier_name,
            case when p_method = 'paylater' then 'paylater' else 'rfid' end, p_total,
            p_balance_after, p_pay_later_available, p_remaining_today, coalesce(p_paid_at, now()))
    on conflict (reference) do nothing
    returning id into v_id;

    if v_id is null then                                     -- already saved (retry): don't duplicate the items
        select id into v_id from purchase_receipts where reference = p_reference;
        return v_id;
    end if;

    insert into purchase_receipt_items (receipt_id, name, qty, price)
    select v_id, i->>'name', (i->>'qty')::int, (i->>'price')::numeric
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i;
    return v_id;
end $$;

-- Only server code (kiosk_checkout) may write receipts. The website must never be able to forge one.
revoke all on function public.record_purchase_receipt(text, text, text, text, text, numeric, jsonb, numeric, numeric, numeric, timestamptz) from public, anon, authenticated;

-- ---------- 3. what the History page reads ----------
create or replace function public.student_history(p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
    v_portal    jsonb;
    v_sid       text;
    v_purchases jsonb;
    v_topups    jsonb := '[]'::jsonb;
    v_topups_ok boolean := true;
begin
    -- same session check as the wallet: student_portal returns null for an expired or invalid token
    v_portal := public.student_portal(p_token);
    if v_portal is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    v_sid := v_portal -> 'profile' ->> 'student_id';
    if v_sid is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_purchases
    from (
        select r.id, r.reference, r.created_at, r.total, r.method, r.cashier_name, r.student_name,
               r.balance_after, r.pay_later_available, r.remaining_today,
               coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'price', i.price) order by i.id)
                         from purchase_receipt_items i where i.receipt_id = r.id), '[]'::jsonb) as items
        from purchase_receipts r
        where r.student_id = v_sid
        order by r.created_at desc
        limit 200
    ) x;

    -- ADAPT HERE: top-ups come from the table your student-top-up.sql created.
    -- This assumes topup_requests(student_id, amount, method, reference_no, status, created_at).
    -- If your table or columns are named differently, change only this select. Until it matches,
    -- the page keeps working and the Top-up tab simply says it isn't available yet.
    begin
        select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_topups
        from (
            select q.id, q.amount, q.method, q.reference_no, q.status, q.created_at
            from topup_requests q
            where q.student_id = v_sid
            order by q.created_at desc
            limit 200
        ) t;
    exception when others then
        v_topups := '[]'::jsonb; v_topups_ok := false;
    end;

    return jsonb_build_object('ok', true, 'purchases', v_purchases, 'topups', v_topups, 'topups_ok', v_topups_ok);
end $$;

grant execute on function public.student_history(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. WIRE THE KIOSK: add this inside kiosk_checkout (kiosk_v8.sql), right after the payment succeeds,
--    using the values you already put in the JSON it returns (reference, items, total, method ...):
--
--   perform public.record_purchase_receipt(
--       v_reference,            -- the reference the kiosk already shows
--       v_student_id,           -- the student's YYYY-NNNNNN
--       v_student_name,
--       v_cashier_name,
--       v_method,               -- 'rfid' or 'paylater'
--       v_total,
--       v_items,                -- jsonb array: [{"name": "...", "qty": 2, "price": 25.00}, ...]
--       v_new_balance,          -- wallet balance after paying (null for Pay Later)
--       v_pay_later_available,  -- only for Pay Later (null otherwise)
--       v_remaining_today,
--       now());
-- ---------------------------------------------------------------------
-- =====================================================================
--  TapMate - Refunds & disputes
--  Run this once in the Supabase SQL editor.
--
--  I couldn't see your database, so the lines marked  -- ADAPT  assume
--  these names. If yours differ, change only those lines:
--    card_sessions(token, user_id, expires_at)     login tokens
--    profiles(id, full_name, role)                 role = 'cashier' | 'admin'
--    purchases(id, reference, user_id, items jsonb, total, method, created_at)
--         items = [{"name":"Siomai","qty":2,"price":20}]   method = 'rfid' | 'paylater'
--    wallets(user_id, balance, paylater_owed)
--  (purchases is whatever table student_history already reads.)
-- =====================================================================

-- 1) One row per refunded purchase. The unique key makes double refunds impossible.
create table if not exists public.refunds (
    id           uuid primary key default gen_random_uuid(),
    purchase_id  uuid not null unique references public.purchases(id),   -- ADAPT (purchases.id type)
    amount       numeric(12,2) not null check (amount >= 0),
    method       text,
    reason       text,
    refunded_by  uuid,
    created_at   timestamptz not null default now()
);
alter table public.refunds enable row level security;   -- no policies: only the functions below can touch it

-- 2) Who is calling? Returns the cashier/admin's user id, or null.
create or replace function public.tm_staff_id(p_token text)
returns uuid language sql security definer set search_path = public stable as $$
    select s.user_id
    from public.card_sessions s                                   -- ADAPT
    join public.profiles p on p.id = s.user_id                    -- ADAPT
    where s.token = p_token
      and (s.expires_at is null or s.expires_at > now())
      and lower(p.role) in ('cashier', 'admin')
    limit 1;
$$;

-- 3) Every kiosk purchase, newest first, with the customer's name and refund status.
create or replace function public.cashier_transactions(p_token text, p_limit int default 500)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_staff uuid := public.tm_staff_id(p_token); v_rows jsonb;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select coalesce(jsonb_agg(t order by t.created_at desc), '[]'::jsonb) into v_rows
    from (
        select pu.id, pu.reference, pr.full_name as customer_name, pu.items, pu.total, pu.method,
               pu.created_at, (rf.id is not null) as refunded, rf.created_at as refunded_at
        from public.purchases pu                                       -- ADAPT
        left join public.profiles pr on pr.id = pu.user_id             -- ADAPT
        left join public.refunds  rf on rf.purchase_id = pu.id
        order by pu.created_at desc
        limit greatest(least(coalesce(p_limit, 500), 1000), 1)
    ) t;

    return jsonb_build_object('ok', true, 'transactions', v_rows);
end $$;

-- 4) Issue a refund: money goes back to the RFID wallet, or comes off the Pay Later balance.
create or replace function public.cashier_issue_refund(p_token text, p_purchase_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_staff uuid := public.tm_staff_id(p_token); v_p record; v_ref public.refunds;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into v_p from public.purchases where id = p_purchase_id for update;   -- ADAPT; locks the row
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if exists (select 1 from public.refunds where purchase_id = p_purchase_id) then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;

    insert into public.refunds (purchase_id, amount, method, reason, refunded_by)
    values (v_p.id, v_p.total, v_p.method, nullif(trim(p_reason), ''), v_staff)
    returning * into v_ref;

    if v_p.method = 'paylater' then
        update public.wallets set paylater_owed = greatest(coalesce(paylater_owed, 0) - v_p.total, 0)   -- ADAPT
        where user_id = v_p.user_id;
    else
        update public.wallets set balance = coalesce(balance, 0) + v_p.total                             -- ADAPT
        where user_id = v_p.user_id;
    end if;

    return jsonb_build_object('ok', true, 'refunded_at', v_ref.created_at);
end $$;

grant execute on function public.cashier_transactions(text, int)        to anon, authenticated;
grant execute on function public.cashier_issue_refund(text, uuid, text) to anon, authenticated;
-- =====================================================================
--  TapMate - Refunds & disputes   (rewritten for your real schema)
--  Run the whole file once in the Supabase SQL editor.
--
--  Uses:  accounts, card_sessions, kiosk_sales   (no guessed names left)
--  Session check copies your current_account_role(): sha256 of the token
--  compared to card_sessions.token_hash.
-- =====================================================================

-- 1) One row per refunded sale. The unique key makes double refunds impossible.
create table if not exists public.refunds (
    id           uuid primary key default gen_random_uuid(),
    purchase_id  uuid not null unique references public.kiosk_sales(id),
    amount       numeric(12,2) not null check (amount >= 0),
    method       text,
    reason       text,
    refunded_by  uuid,
    created_at   timestamptz not null default now()
);
alter table public.refunds enable row level security;   -- no policies: only the functions below can touch it

-- 2) Who is calling? Returns the cashier/admin's account id, or null.
create or replace function public.tm_staff_id(p_token text)
returns uuid language sql security definer stable
set search_path = public, extensions as $$
    select s.account_id
    from public.card_sessions s
    join public.accounts a on a.id = s.account_id
    where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
      and s.expires_at > now()
      and a.status = 'active'
      and lower(a.role) in ('cashier', 'admin')
    limit 1;
$$;

-- 3) Every kiosk sale, newest first, with the customer's name and refund status.
create or replace function public.cashier_transactions(p_token text, p_limit int default 500)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare v_staff uuid := public.tm_staff_id(p_token); v_rows jsonb;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_rows
    from (
        select ks.id,
               coalesce(rc.reference, 'TM-' || upper(left(replace(ks.id::text, '-', ''), 8))) as reference,
               a.full_name as customer_name,
               ks.items, ks.total, ks.method, ks.created_at,
               (rf.id is not null) as refunded, rf.created_at as refunded_at
        from public.kiosk_sales ks
        left join public.accounts a  on a.id = ks.account_id
        left join public.refunds  rf on rf.purchase_id = ks.id
        left join lateral (                      -- reuse the e-receipt reference when we can match it
            select r.reference
            from public.purchase_receipts r
            where r.student_id = a.student_id
              and r.total = ks.total
              and abs(extract(epoch from (r.created_at - ks.created_at))) < 15
            order by abs(extract(epoch from (r.created_at - ks.created_at)))
            limit 1
        ) rc on true
        order by ks.created_at desc
        limit greatest(least(coalesce(p_limit, 500), 1000), 1)
    ) t;

    return jsonb_build_object('ok', true, 'transactions', v_rows);
end $$;

-- 4) Issue a refund: money goes back to the wallet balance, or comes off the Pay Later balance.
create or replace function public.cashier_issue_refund(p_token text, p_purchase_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare v_staff uuid := public.tm_staff_id(p_token); v_s record; v_ref public.refunds;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into v_s from public.kiosk_sales where id = p_purchase_id for update;   -- locks the row
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if exists (select 1 from public.refunds where purchase_id = p_purchase_id) then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;

    insert into public.refunds (purchase_id, amount, method, reason, refunded_by)
    values (v_s.id, v_s.total, v_s.method, nullif(trim(p_reason), ''), v_staff)
    returning * into v_ref;

    if lower(coalesce(v_s.method, '')) like '%later%' then
        update public.accounts
           set pay_later_outstanding = greatest(coalesce(pay_later_outstanding, 0) - v_s.total, 0),
               updated_at = now()
         where id = v_s.account_id;
    else
        update public.accounts
           set balance = coalesce(balance, 0) + v_s.total,
               updated_at = now()
         where id = v_s.account_id;
    end if;

    return jsonb_build_object('ok', true, 'refunded_at', v_ref.created_at);
end $$;

revoke all on function public.tm_staff_id(text)                          from public, anon, authenticated;
revoke all on function public.cashier_transactions(text, int)            from public;
revoke all on function public.cashier_issue_refund(text, uuid, text)     from public;
grant execute on function public.cashier_transactions(text, int)         to anon, authenticated;
grant execute on function public.cashier_issue_refund(text, uuid, text)  to anon, authenticated;

notify pgrst, 'reload schema';   -- makes the API see the new functions right away
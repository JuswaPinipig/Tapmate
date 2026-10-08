-- =====================================================================
-- TapMate · Student History  (REPLACES the earlier studenthistory.sql)
-- Run once in the Supabase SQL Editor. Safe to re-run. Needs Kioskv8v2.sql + transaction.sql already applied.
--
-- Every completed kiosk order is ALREADY saved in public.kiosk_sales (items, total, method, time), so the
-- History page now reads that table directly. No second copy, no extra call to wire into the kiosk.
--   * Your existing orders (like "Kiosk purchase (3 items)") show up immediately.
--   * 3 new columns let new receipts also show the wallet balance / Pay Later / limit left after paying.
--     Older sales don't have them, so their receipts simply leave those lines out.
--   * Top-up history reads public.transactions rows of type 'topup'.
-- =====================================================================

-- (optional) the tables from the first version are no longer used. Uncomment to remove them:
-- drop function if exists public.record_purchase_receipt(text, text, text, text, text, numeric, jsonb, numeric, numeric, numeric, timestamptz);
-- drop table if exists public.purchase_receipt_items, public.purchase_receipts;

alter table public.kiosk_sales add column if not exists balance_after       numeric(12,2);
alter table public.kiosk_sales add column if not exists pay_later_available numeric(12,2);
alter table public.kiosk_sales add column if not exists remaining_today     numeric(12,2);
create index if not exists kiosk_sales_account_idx on public.kiosk_sales (account_id, created_at desc);

-- ---------- kiosk_checkout: same as Kioskv8v2.sql, but it also saves the balance figures on the sale ----------
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
    insert into public.kiosk_sales (cashier_id, account_id, total, method, items,
                                    balance_after, pay_later_available, remaining_today)
    values (c, a.id, v_total, o.payment, v_items,
            v_new,
            greatest(a.pay_later_limit - a.pay_later_outstanding - case when o.payment = 'paylater' then v_total else 0 end, 0),
            case when v_cap is null then null else greatest(v_cap - v_spent - v_total, 0) end)
    returning id into v_sale;

    perform public._kiosk_touch(c);
    delete from public.kiosk_order_lines where cashier_id = c;

    return jsonb_build_object('ok', true, 'sale_id', v_sale,
        'reference', 'TM-' || upper(left(replace(v_sale::text, '-', ''), 8)),
        'paid_at', now(), 'items', v_items, 'total', v_total, 'method', o.payment,
        'student', coalesce(a.first_name, a.full_name), 'new_balance', v_new,
        'remaining_today', case when v_cap is null then null else greatest(v_cap - v_spent - v_total, 0) end,
        'pay_later_available', greatest(a.pay_later_limit - a.pay_later_outstanding - case when o.payment = 'paylater' then v_total else 0 end, 0));
end $$;

-- ---------- what the History page reads ----------
create or replace function public.student_history(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v uuid := public._token_account(p_token);
    v_purchases jsonb;
    v_topups jsonb;
begin
    if v is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_purchases
    from (
        select s.id,
               'TM-' || upper(left(replace(s.id::text, '-', ''), 8)) as reference,   -- same reference the kiosk prints
               s.created_at, s.total, s.method,
               coalesce(c.full_name, c.first_name) as cashier_name,
               s.balance_after, s.pay_later_available, s.remaining_today,
               s.items                                                              -- [{name, qty, price}]
        from public.kiosk_sales s
        left join public.accounts c on c.id = s.cashier_id
        where s.account_id = v
        order by s.created_at desc
        limit 200
    ) x;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_topups
    from (
        select q.id, q.amount, coalesce(q.location, q.description) as method, null::text as reference_no,
               'approved'::text as status, q.created_at
        from public.transactions q
        where q.account_id = v and q.type = 'topup'
        order by q.created_at desc
        limit 200
    ) t;

    return jsonb_build_object('ok', true, 'purchases', v_purchases, 'topups', v_topups, 'topups_ok', true);
end $$;

revoke execute on function public.student_history(text) from public;
grant execute on function public.student_history(text) to anon, authenticated;

notify pgrst, 'reload schema';
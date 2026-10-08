-- ============================================================
-- TapMate: make kiosk sales reduce stock.  Supabase > SQL Editor > paste all > Run. Safe to re-run.
-- Run AFTER Kioskv8v2.sql and adminproductsv2.sql.
--
-- Why stock never dropped: kiosk_checkout charged the student and saved the receipt but never called
-- stock_deduct_items(). This replaces kiosk_checkout with the same function PLUS:
--   * a stock check before any money moves  -> returns reason 'out_of_stock' (name + stock left)
--   * stock_deduct_items() in the same transaction -> stock drops and a 'sale' row lands in stock_movements
-- Sales made BEFORE running this are not deducted retroactively (fix those with Stock & Inventory > adjust).
-- ============================================================

create or replace function public.kiosk_checkout(p_token text, p_rfid text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c uuid; o public.kiosk_orders; a public.accounts;
    v_uid text; v_total numeric(12,2); v_missing int; v_n int; v_items jsonb;
    v_cap numeric; v_spent numeric; v_new numeric; v_days int; v_sale uuid;
    v_short text; v_left int; v_cname text;
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

    -- stock check (before any money moves): refuse the sale if anything in the order is sold out / short
    select p.name, p.stock into v_short, v_left
      from public.kiosk_order_lines l join public.products p on p.id = l.product_id
     where l.cashier_id = c and p.stock < l.qty
     order by p.name limit 1;
    if found then
        return jsonb_build_object('ok', false, 'reason', 'out_of_stock', 'name', v_short, 'stock', v_left);
    end if;

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

    -- take the items out of stock (same transaction: if this fails, the payment above is rolled back too)
    select coalesce(first_name, full_name) into v_cname from public.accounts where id = c;
    perform public.stock_deduct_items(
        (select jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty))
           from public.kiosk_order_lines where cashier_id = c),
        'Kiosk sale TM-' || upper(left(replace(v_sale::text, '-', ''), 8)),
        v_cname, 'cashier');

    perform public._kiosk_touch(c);
    delete from public.kiosk_order_lines where cashier_id = c;

    return jsonb_build_object('ok', true, 'sale_id', v_sale,
        'reference', 'TM-' || upper(left(replace(v_sale::text, '-', ''), 8)),
        'paid_at', now(), 'items', v_items, 'total', v_total, 'method', o.payment,
        'student', coalesce(a.first_name, a.full_name), 'new_balance', v_new,
        'remaining_today', case when v_cap is null then null else greatest(v_cap - v_spent - v_total, 0) end,
        'pay_later_available', greatest(a.pay_later_limit - a.pay_later_outstanding - case when o.payment = 'paylater' then v_total else 0 end, 0));
end $$;

grant execute on function public.kiosk_checkout(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
-- =====================================================================
--  TapMate - Refunds & disputes  v5: refund amount for the weekly summary
--  Run once in the Supabase SQL editor (after v2 and v3).
--  Same as the v2 cashier_transactions(), plus refunded_amount so partial
--  refunds are counted correctly in the summary.
-- =====================================================================

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
               (rf.id is not null) as refunded,
               rf.created_at as refunded_at,
               rf.amount     as refunded_amount
        from public.kiosk_sales ks
        left join public.accounts a  on a.id = ks.account_id
        left join public.refunds  rf on rf.purchase_id = ks.id
        left join lateral (
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

revoke all on function public.cashier_transactions(text, int) from public;
grant execute on function public.cashier_transactions(text, int) to anon, authenticated;

notify pgrst, 'reload schema';
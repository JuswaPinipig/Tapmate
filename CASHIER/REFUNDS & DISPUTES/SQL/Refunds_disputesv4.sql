-- =====================================================================
--  TapMate - Refunds & disputes  v4: evidence for the refund-ai function
--  Run once in the Supabase SQL editor (after v2 and v3).
--  The Edge Function calls this with the cashier's token and reads
--  { ok, facts, flags }.  Reasons: session | not_found
-- =====================================================================

create or replace function public.cashier_refund_evidence(p_token text, p_purchase_id uuid)
returns jsonb language plpgsql security definer stable
set search_path = public, extensions as $$
declare
    v_staff uuid := public.tm_staff_id(p_token);
    v_s     record;
    v_mins        numeric;
    v_dupes       int;
    v_ref_count   int;
    v_ref_total   numeric;
    v_buy_count   int;
    v_already     boolean;
    v_flags       jsonb := '[]'::jsonb;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into v_s from public.kiosk_sales where id = p_purchase_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

    v_mins := round(extract(epoch from (now() - v_s.created_at)) / 60.0);

    -- Same customer, same amount, within 10 minutes (possible duplicate charge)
    select count(*) into v_dupes
    from public.kiosk_sales k
    where k.account_id = v_s.account_id
      and k.id <> v_s.id
      and k.total = v_s.total
      and abs(extract(epoch from (k.created_at - v_s.created_at))) <= 600;

    -- This customer's refund history, last 30 days
    select count(*), coalesce(sum(r.amount), 0) into v_ref_count, v_ref_total
    from public.refunds r
    join public.kiosk_sales k on k.id = r.purchase_id
    where k.account_id = v_s.account_id
      and r.created_at > now() - interval '30 days';

    select count(*) into v_buy_count
    from public.kiosk_sales k
    where k.account_id = v_s.account_id
      and k.created_at > now() - interval '30 days';

    v_already := exists (select 1 from public.refunds where purchase_id = v_s.id);

    if v_already            then v_flags := v_flags || to_jsonb('already_refunded'::text); end if;
    if v_dupes > 0          then v_flags := v_flags || to_jsonb('possible_duplicate_charge'::text); end if;
    if v_mins > 60 * 24 * 7 then v_flags := v_flags || to_jsonb('purchase_older_than_7_days'::text); end if;
    if v_ref_count >= 3     then v_flags := v_flags || to_jsonb('frequent_refunds_last_30_days'::text); end if;
    if v_buy_count >= 5 and v_ref_count::numeric / v_buy_count >= 0.4
                            then v_flags := v_flags || to_jsonb('high_refund_rate'::text); end if;

    return jsonb_build_object(
        'ok', true,
        'facts', jsonb_build_object(
            'minutes_since_purchase', v_mins,
            'same_amount_sales_within_10_min', v_dupes,
            'customer_purchases_last_30_days', v_buy_count,
            'customer_refunds_last_30_days', v_ref_count,
            'customer_refunded_total_last_30_days', v_ref_total
        ),
        'flags', v_flags
    );
end $$;

revoke all on function public.cashier_refund_evidence(text, uuid) from public;
grant execute on function public.cashier_refund_evidence(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
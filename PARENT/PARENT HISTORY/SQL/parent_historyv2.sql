-- =====================================================================
-- TapMate · Parent History
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Needs already applied: parent_portal (your parent overview), studenthistoryv2.sql, studentrefunds.sql
-- Adds ONE function. Nothing on the student side is changed.
--
-- It finds the parent's linked student the same way the Parent Overview does: by asking
-- parent_portal(p_token) who the linked student is (matched by Student ID), so no guessing
-- about how the link table is built.
-- =====================================================================
create or replace function public.parent_history(p_token text, p_student uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
    v uuid := public._token_account(p_token);
    portal jsonb; sid text; s public.accounts;
    v_pl jsonb; v_purchases jsonb; v_topups jsonb; v_used_month numeric; v_uses int;
    v_parent jsonb;
begin
    if v is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    portal   := public.parent_portal(p_token);
    v_parent := coalesce(portal->'parent', '{}'::jsonb);
    if portal is null or coalesce((portal->>'linked')::boolean, false) is not true then
        return jsonb_build_object('ok', false, 'reason', 'no_child', 'parent', v_parent);
    end if;

    sid := portal->'student'->'profile'->>'student_id';
    select * into s from public.accounts where student_id = sid limit 1;
    if not found then return jsonb_build_object('ok', false, 'reason', 'no_child', 'parent', v_parent); end if;

    select coalesce(sum(k.total), 0), count(*) into v_used_month, v_uses
      from public.kiosk_sales k
     where k.account_id = s.id and k.method = 'paylater'
       and k.created_at >= date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';

    v_pl := jsonb_build_object(
        'enabled', coalesce(s.pay_later_enabled, false),
        'limit', coalesce(s.pay_later_limit, 0),
        'outstanding', coalesce(s.pay_later_outstanding, 0),
        'available', greatest(coalesce(s.pay_later_limit, 0) - coalesce(s.pay_later_outstanding, 0), 0),
        'due_at', s.pay_later_due_at,
        'overdue', coalesce(s.pay_later_outstanding, 0) > 0 and s.pay_later_due_at is not null and s.pay_later_due_at < now(),
        'used_month', v_used_month, 'uses_count', v_uses);

    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_purchases
    from (
        select k.id,
               'TM-' || upper(left(replace(k.id::text, '-', ''), 8)) as reference,
               k.created_at, k.total, k.method,
               coalesce(c.full_name, c.first_name) as cashier_name,
               k.balance_after, k.pay_later_available, k.remaining_today, k.items,
               r.status as refund_status, r.created_at as refund_requested_at
        from public.kiosk_sales k
        left join public.accounts c on c.id = k.cashier_id
        left join public.refund_requests r on r.sale_id = k.id
        where k.account_id = s.id
        order by k.created_at desc
        limit 200
    ) x;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_topups
    from (
        select q.id, q.amount, coalesce(q.location, q.description) as method, null::text as reference_no,
               'approved'::text as status, q.created_at
        from public.transactions q
        where q.account_id = s.id and q.type = 'topup'
        order by q.created_at desc
        limit 200
    ) t;

    return jsonb_build_object('ok', true,
        'parent', v_parent,
        'children', jsonb_build_array(jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name,
                    'full_name', coalesce(s.full_name, trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,''))),
                    'student_id', s.student_id, 'avatar_url', s.avatar_url)),
        'child', jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name,
                    'full_name', coalesce(s.full_name, trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,''))),
                    'student_id', s.student_id, 'avatar_url', s.avatar_url),
        'pay_later', v_pl, 'purchases', v_purchases, 'topups', v_topups, 'topups_ok', true);
end $$;

revoke execute on function public.parent_history(text, uuid) from public;
grant execute on function public.parent_history(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
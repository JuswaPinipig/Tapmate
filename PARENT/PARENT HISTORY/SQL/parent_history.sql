-- =====================================================================
-- TapMate · Parent History
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Needs already applied: Kioskv8v2.sql, studenthistoryv2.sql, studentrefunds.sql
-- Nothing of the student side is changed. This only ADDS two functions.
--
-- ASSUMPTION: public.parent_student_links links a parent account to a student account.
-- The code reads the columns by name from the row itself and accepts either
--   parent_id / parent_account_id   and   student_id / student_account_id
-- If your table uses other names, edit _parent_children below (two lines).
-- =====================================================================

-- ---------- the children linked to a parent ----------
create or replace function public._parent_children(p_parent uuid)
returns table (student uuid)
language sql stable security definer set search_path = public, extensions as $$
    select coalesce(j->>'student_id', j->>'student_account_id')::uuid
      from public.parent_student_links l, lateral (select to_jsonb(l) as j) x
     where coalesce(j->>'parent_id', j->>'parent_account_id')::uuid = p_parent
       and coalesce(j->>'student_id', j->>'student_account_id') is not null
$$;
revoke execute on function public._parent_children(uuid) from public;

-- ---------- what the Parent History page reads ----------
create or replace function public.parent_history(p_token text, p_student uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v uuid := public._token_account(p_token);
    pa public.accounts;
    s  public.accounts;
    v_kids jsonb; v_pl jsonb; v_purchases jsonb; v_topups jsonb;
    v_used_month numeric; v_uses int;
begin
    if v is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into pa from public.accounts where id = v;
    if not found or lower(coalesce(pa.role::text, '')) <> 'parent' then
        return jsonb_build_object('ok', false, 'reason', 'session');
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'first_name', a.first_name, 'last_name', a.last_name,
               'full_name', coalesce(a.full_name, trim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,''))),
               'student_id', a.student_id, 'avatar_url', a.avatar_url)
               order by a.first_name), '[]'::jsonb)
      into v_kids
      from public.accounts a where a.id in (select student from public._parent_children(v));

    if jsonb_array_length(v_kids) = 0 then
        return jsonb_build_object('ok', false, 'reason', 'no_child',
            'parent', jsonb_build_object('full_name', pa.full_name, 'email', pa.email, 'first_name', pa.first_name, 'last_name', pa.last_name, 'avatar_url', pa.avatar_url));
    end if;

    -- the chosen child must really be linked to THIS parent; otherwise fall back to the first one
    if p_student is not null and exists (select 1 from public._parent_children(v) c where c.student = p_student) then
        select * into s from public.accounts where id = p_student;
    else
        select * into s from public.accounts where id = (v_kids->0->>'id')::uuid;
    end if;

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
               k.balance_after, k.pay_later_available, k.remaining_today,
               k.items,
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
        'parent', jsonb_build_object('full_name', pa.full_name, 'email', pa.email, 'first_name', pa.first_name, 'last_name', pa.last_name, 'avatar_url', pa.avatar_url),
        'children', v_kids,
        'child', jsonb_build_object('id', s.id, 'first_name', s.first_name, 'last_name', s.last_name,
                    'full_name', coalesce(s.full_name, trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,''))),
                    'student_id', s.student_id, 'avatar_url', s.avatar_url),
        'pay_later', v_pl, 'purchases', v_purchases, 'topups', v_topups, 'topups_ok', true);
end $$;

revoke execute on function public.parent_history(text, uuid) from public;
grant execute on function public.parent_history(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
-- ============================================================
-- Pay Later funds (limit) set by the admin.   Run AFTER pay-later-ledgersv2.sql. Safe to re-run.
--
-- The limit (accounts.pay_later_limit) is the MOST a student can owe on Pay Later.
--   available = pay_later_limit - pay_later_outstanding
-- Once the unpaid balance reaches the limit, Pay Later can't be used until it is paid back or the admin raises the limit.
-- ============================================================

-- 1. Admin sets the limit for a student who is linked to a parent ---------------
create or replace function public.admin_set_pay_later_limit(p_token text, p_id uuid, p_limit numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    c_max constant numeric := 100000;      -- sanity cap against typos; keep in sync with MAX_LIMIT in pay-later-ledgers.js
    a public.accounts;
    v_limit numeric;
begin
    perform public._pl_require_admin(p_token);
    if p_limit is null or p_limit < 0 or p_limit > c_max then
        return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
    select * into a from public.accounts where id = p_id and role = 'student' for update;
    if not found then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    if not exists (select 1 from public.parent_student_links l where l.student_id = p_id) then
        return jsonb_build_object('ok', false, 'reason', 'no_parent');
    end if;

    v_limit := round(p_limit, 2);
    update public.accounts set pay_later_limit = v_limit where id = p_id;
    -- TODO: insert an audit-log row here, matching how admin_archive_account does it.
    return jsonb_build_object('ok', true, 'limit', v_limit, 'outstanding', a.pay_later_outstanding,
                              'available', greatest(v_limit - a.pay_later_outstanding, 0));
end $$;

grant execute on function public.admin_set_pay_later_limit(text, uuid, numeric) to anon, authenticated;

-- 2. Re-activating Pay Later no longer wipes the limit the admin set ---------------
--    (same function as studentwallet2.sql; the only change is the pay_later_limit line)
create or replace function public.student_activate_pay_later(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; a public.accounts; v_max int;
begin
    v_id := public._token_account(p_token);
    if v_id is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into a from public.accounts where id = v_id for update;
    v_max := public._setting_num('pay_later_max_uses', 5)::int;

    if a.pay_later_enabled then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
    if a.pay_later_outstanding > 0 and a.pay_later_due_at is not null and a.pay_later_due_at < now() then
        return jsonb_build_object('ok', false, 'reason', 'overdue');
    end if;
    if a.pay_later_outstanding > 0 then return jsonb_build_object('ok', false, 'reason', 'outstanding'); end if;
    if a.pay_later_used_count >= v_max then return jsonb_build_object('ok', false, 'reason', 'max_uses'); end if;

    update public.accounts
       set pay_later_enabled = true,
           pay_later_limit = case when pay_later_limit > 0 then pay_later_limit      -- keep what the admin set
                                  else public._setting_num('pay_later_default_limit', 0) end,
           pay_later_used_count = pay_later_used_count + 1
     where id = a.id;
    return jsonb_build_object('ok', true);
end $$;

-- Optional: give every NEW activation a starting limit instead of 0 (example: 500). Admin can still change it per student.
-- update public.app_settings set value = '500' where key = 'pay_later_default_limit';
-- ============================================================
-- Parent Top Up + Pay Later
-- Run in the Supabase SQL editor AFTER pay-later-ledgers.sql.
--
-- ASSUMPTIONS: I couldn't see your login / top-up schema, so check every line marked ADAPT.
--   1. Parents are rows in public.accounts with role = 'parent' and sign in like everyone
--      else (card token). public.card_session(p_token) returns json with "role" and "id".
--   2. Student top-ups live in a table I named public.topup_requests
--      (id, account_id, amount, reference, proof_path, method, status, approved_by, created_at).
--   3. PINs are stored in accounts.pin_hash using pgcrypto crypt().
-- ============================================================

-- 0. Allow the 'parent' role. ADAPT: your role CHECK constraint may have a different name.
--    Find it with:  select conname from pg_constraint where conrelid = 'public.accounts'::regclass and contype = 'c';
-- alter table public.accounts drop constraint accounts_role_check;
-- alter table public.accounts add constraint accounts_role_check
--     check (role in ('student','faculty','admin','cashier','parent'));

-- 1. Link a parent ACCOUNT to a student (parent_links was created by pay-later-ledgers.sql)
alter table public.parent_links add column if not exists parent_id uuid references public.accounts(id) on delete cascade;
create index if not exists parent_links_parent on public.parent_links (parent_id) where status = 'active';

-- 2. Pay later limit per student (the most that can build up). ADAPT: the default is a placeholder.
alter table public.accounts add column if not exists pay_later_limit numeric(12,2) not null default 500;

-- 3. Who submitted a top-up
alter table public.topup_requests add column if not exists requested_by uuid references public.accounts(id);

-- 4. PIN change log (3 changes per 24 hours)
create table if not exists public.pin_change_log (
    id         uuid primary key default gen_random_uuid(),
    account_id uuid not null references public.accounts(id) on delete cascade,
    changed_at timestamptz not null default now()
);
create index if not exists pin_change_log_acct on public.pin_change_log (account_id, changed_at desc);
alter table public.pin_change_log enable row level security;

-- 5. Helpers -----------------------------------------------------
create or replace function public._parent_id(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare s jsonb;
begin
    s := to_jsonb(public.card_session(p_token));
    if s is null or coalesce(s->>'role', '') <> 'parent' then return null; end if;
    return (s->>'id')::uuid;
end $$;

create or replace function public._parent_owns(pid uuid, sid uuid)
returns boolean language sql security definer set search_path = public as $$
    select exists (select 1 from public.parent_links l
                   where l.parent_id = pid and l.student_id = sid and l.status = 'active');
$$;

create or replace function public._pl_owed(sid uuid)
returns numeric language sql security definer set search_path = public as $$
    select coalesce(sum(case e.kind when 'charge' then e.amount else -e.amount end), 0)
    from public.pay_later_entries e where e.student_id = sid;
$$;

-- 6. Everything the page needs in one call -----------------------
create or replace function public.parent_portal(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid uuid := public._parent_id(p_token); me record; used int; nxt timestamptz;
begin
    if pid is null then return null; end if;
    select a.full_name, a.email, a.phone, a.avatar into me from public.accounts a where a.id = pid;
    select count(*), min(changed_at) + interval '24 hours' into used, nxt
    from public.pin_change_log where account_id = pid and changed_at > now() - interval '24 hours';
    return jsonb_build_object(
        'profile', jsonb_build_object(
            'full_name', me.full_name, 'email', me.email, 'phone', me.phone, 'avatar_url', me.avatar,
            'pin_limit', 3, 'pin_used', used, 'pin_next_at', case when used >= 3 then nxt end),
        'children', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', s.id, 'full_name', s.full_name || coalesce(' ' || s.suffix, ''), 'student_id', s.student_id,
                'balance', s.balance, 'updated_at', s.updated_at,
                'pay_later_enabled', coalesce(s.pay_later_enabled, false),
                'pay_later_limit', s.pay_later_limit,
                'outstanding', public._pl_owed(s.id)) order by s.full_name)
            from public.parent_links l join public.accounts s on s.id = l.student_id
            where l.parent_id = pid and l.status = 'active' and s.status <> 'archived'), '[]'::jsonb));
end $$;

-- 7. Top-up history for one of the parent's students -------------
-- ADAPT: table / column names
create or replace function public.parent_topup_history(p_token text, p_student_id uuid)
returns table (id uuid, amount numeric, status text, created_at timestamptz, approved_by_name text)
language plpgsql security definer set search_path = public as $$
declare pid uuid := public._parent_id(p_token);
begin
    if pid is null or not public._parent_owns(pid, p_student_id) then return; end if;
    return query
    select t.id, t.amount, t.status, t.created_at, ad.full_name
    from public.topup_requests t
    left join public.accounts ad on ad.id = t.approved_by
    where t.account_id = p_student_id
    order by t.created_at desc limit 100;
end $$;

-- 8. Submit a top-up for a linked student ------------------------
-- Uses the same settings as the student side (amounts, ref_length, max_pending).
-- ADAPT: the insert must match how student_submit_topup writes to your table.
create or replace function public.parent_submit_topup(
    p_token text, p_student_id uuid, p_method text, p_amount numeric, p_reference text, p_proof_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid uuid := public._parent_id(p_token); s jsonb := to_jsonb(public.student_topup_settings()); pend int;
begin
    if pid is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if not public._parent_owns(pid, p_student_id) then return jsonb_build_object('ok', false, 'reason', 'student'); end if;
    if not exists (select 1 from jsonb_array_elements_text(s->'amounts') a where a::numeric = p_amount) then
        return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
    if p_reference !~ ('^\d{' || (s->>'ref_length') || '}$') then
        return jsonb_build_object('ok', false, 'reason', 'format'); end if;
    select count(*) into pend from public.topup_requests where account_id = p_student_id and status = 'pending';
    if pend >= coalesce((s->>'max_pending')::int, 3) then
        return jsonb_build_object('ok', false, 'reason', 'pending_limit'); end if;

    insert into public.topup_requests (account_id, requested_by, method, amount, reference, proof_path, status)
    values (p_student_id, pid, coalesce(p_method, 'gcash'), p_amount, p_reference, p_proof_path, 'pending');
    return jsonb_build_object('ok', true);
end $$;

-- 9. Pay later: activate / deactivate, and activity --------------
create or replace function public.parent_set_pay_later(p_token text, p_student_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare pid uuid := public._parent_id(p_token);
begin
    if pid is null or not public._parent_owns(pid, p_student_id) then
        raise exception 'This student isn''t linked to your account.' using errcode = '42501'; end if;
    update public.accounts set pay_later_enabled = p_enabled where id = p_student_id and role = 'student';
    -- TODO: write an audit-log row (actor = this parent), like the admin actions do.
end $$;

create or replace function public.parent_pay_later_entries(p_token text, p_student_id uuid)
returns table (id uuid, kind text, amount numeric, note text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare pid uuid := public._parent_id(p_token);
begin
    if pid is null or not public._parent_owns(pid, p_student_id) then return; end if;
    return query select e.id, e.kind, e.amount, e.note, e.created_at
                 from public.pay_later_entries e where e.student_id = p_student_id
                 order by e.created_at desc limit 50;
end $$;

-- 10. Change own PIN (max 3 per 24 hours) ------------------------
-- ADAPT: assumes accounts.pin_hash + pgcrypto's crypt().
create or replace function public.parent_change_own_pin(p_token text, p_current text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare pid uuid := public._parent_id(p_token); used int; nxt timestamptz;
begin
    if pid is null then raise exception 'Please sign in again.' using errcode = '42501'; end if;
    if p_new !~ '^\d{4}$' then raise exception 'Your new PIN must be exactly 4 digits.'; end if;
    select count(*), min(changed_at) + interval '24 hours' into used, nxt
    from public.pin_change_log where account_id = pid and changed_at > now() - interval '24 hours';
    if used >= 3 then raise exception 'You have reached the maximum of 3 PIN changes within 24 hours.'; end if;
    if not exists (select 1 from public.accounts where id = pid and pin_hash = crypt(p_current, pin_hash)) then
        raise exception 'Your current PIN is incorrect.'; end if;
    update public.accounts set pin_hash = crypt(p_new, gen_salt('bf')) where id = pid;
    insert into public.pin_change_log (account_id) values (pid);
    used := used + 1;
    select min(changed_at) + interval '24 hours' into nxt
    from public.pin_change_log where account_id = pid and changed_at > now() - interval '24 hours';
    return jsonb_build_object('pin_limit', 3, 'pin_used', used, 'pin_next_at', case when used >= 3 then nxt end);
end $$;

-- 11. Permissions ------------------------------------------------
revoke all on function public._parent_id(text), public._parent_owns(uuid, uuid), public._pl_owed(uuid)
    from public, anon, authenticated;
grant execute on function public.parent_portal(text) to anon, authenticated;
grant execute on function public.parent_topup_history(text, uuid) to anon, authenticated;
grant execute on function public.parent_submit_topup(text, uuid, text, numeric, text, text) to anon, authenticated;
grant execute on function public.parent_set_pay_later(text, uuid, boolean) to anon, authenticated;
grant execute on function public.parent_pay_later_entries(text, uuid) to anon, authenticated;
grant execute on function public.parent_change_own_pin(text, text, text) to anon, authenticated;
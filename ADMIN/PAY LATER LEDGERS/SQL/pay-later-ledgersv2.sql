-- ============================================================
-- Pay Later Ledger (admin)  -  run in the Supabase SQL editor.
-- Safe to re-run.
--
-- Uses the REAL link data (not a separate table):
--   * parent link  = public.parent_student_links (+ the parent's row in public.accounts)
--   * pay later    = columns on the student's public.accounts row
--                    (pay_later_enabled / _limit / _outstanding / _due_at / _used_count)
--   * transactions = public.pay_later_entries  (kind 'charge' = bought with Pay Later,
--                                                kind 'payment' = money paid back)
-- Requires studentwallet2.sql + parentoverview.sql to have been run first.
-- ============================================================

-- 1. Ledger entries ----------------------------------------------
create table if not exists public.pay_later_entries (
    id          uuid primary key default gen_random_uuid(),
    student_id  uuid not null references public.accounts(id) on delete cascade,
    kind        text not null check (kind in ('charge', 'payment')),
    amount      numeric(12,2) not null check (amount > 0),
    note        text,
    created_at  timestamptz not null default now()
);
create index if not exists pay_later_entries_student on public.pay_later_entries (student_id, created_at desc);
alter table public.pay_later_entries enable row level security;

-- 2. Admin check -------------------------------------------------
create or replace function public._pl_require_admin(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if coalesce((public.card_session(p_token))->>'role', '') <> 'admin' then
        raise exception 'Permission denied. Sign in as an admin.' using errcode = '42501';
    end if;
end $$;

-- 3. Students with parent-link + pay later usage ------------------
drop function if exists public.admin_pay_later_list(text, text, text, int, int);
create or replace function public.admin_pay_later_list(
    p_token text, p_search text default '', p_filter text default 'all',
    p_limit int default 5, p_offset int default 0)
returns table (
    id uuid, student_id text, full_name text, suffix text,
    parent_linked boolean, parent_name text, parent_contact text,
    pay_later_enabled boolean, pay_later_limit numeric, outstanding numeric,
    used_count int, max_uses int, due_at timestamptz, overdue boolean, total_count bigint)
language plpgsql security definer set search_path = public as $$
declare v_max int;
begin
    perform public._pl_require_admin(p_token);
    v_max := public._setting_num('pay_later_max_uses', 5)::int;
    return query
    with base as (
        select a.id, a.student_id, a.full_name, a.suffix,
               (pl.parent_id is not null) as linked, pl.pname, pl.pcontact,
               coalesce(a.pay_later_enabled, false) as enabled,
               a.pay_later_limit as lim, a.pay_later_outstanding as owed,
               a.pay_later_used_count as used, a.pay_later_due_at as due,
               (a.pay_later_outstanding > 0 and a.pay_later_due_at is not null and a.pay_later_due_at < now()) as late
        from public.accounts a
        left join lateral (
            select p.id as parent_id,
                   btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as pname,
                   coalesce(p.email, p.phone) as pcontact
              from public.parent_student_links l
              join public.accounts p on p.id = l.parent_id
             where l.student_id = a.id limit 1) pl on true
        where a.role = 'student' and a.status <> 'archived'
          and (coalesce(p_search, '') = ''
               or a.full_name ilike '%' || p_search || '%'
               or a.student_id ilike '%' || p_search || '%')
    ), filtered as (
        select * from base
        where p_filter = 'all'
           or (p_filter = 'eligible' and linked)
           or (p_filter = 'active'   and linked and enabled)
           or (p_filter = 'unpaid'   and owed > 0)
           or (p_filter = 'unlinked' and not linked)
    )
    select f.id, f.student_id, f.full_name, f.suffix,
           f.linked, nullif(f.pname, ''), f.pcontact,
           (f.linked and f.enabled), f.lim, f.owed,
           f.used, v_max, f.due, f.late,
           count(*) over () as total_count
    from filtered f
    order by f.full_name asc
    limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end $$;

-- 4. Pay later transactions for one student, with paid / unpaid ---
--    Payments are applied to the oldest charges first.
drop function if exists public.admin_pay_later_entries(text, uuid);
create or replace function public.admin_pay_later_entries(p_token text, p_id uuid)
returns table (id uuid, kind text, amount numeric, note text, created_at timestamptz,
               paid_amount numeric, status text)
language plpgsql security definer set search_path = public as $$
begin
    perform public._pl_require_admin(p_token);
    return query
    with pays as (
        select coalesce(sum(e.amount), 0) as total from public.pay_later_entries e
         where e.student_id = p_id and e.kind = 'payment'
    ), ch as (
        select e.id, e.amount,
               coalesce(sum(e.amount) over (order by e.created_at, e.id
                        rows between unbounded preceding and 1 preceding), 0) as before_amt
          from public.pay_later_entries e
         where e.student_id = p_id and e.kind = 'charge'
    ), calc as (
        select ch.id as cid,
               least(ch.amount, greatest((select total from pays) - ch.before_amt, 0)) as paid
          from ch
    )
    select e.id, e.kind, e.amount, e.note, e.created_at,
           case when e.kind = 'charge' then c.paid end,
           case when e.kind <> 'charge' then null
                when c.paid >= e.amount then 'paid'
                when c.paid > 0 then 'partial'
                else 'unpaid' end
      from public.pay_later_entries e
      left join calc c on c.cid = e.id
     where e.student_id = p_id
     order by e.created_at desc, e.id desc
     limit 200;
end $$;

-- 5. Admin can switch pay later OFF; only the parent can switch it on
create or replace function public.admin_set_pay_later(p_token text, p_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
    perform public._pl_require_admin(p_token);
    if p_enabled then
        raise exception 'Only the student''s linked parent can activate Pay Later.';
    end if;
    update public.accounts set pay_later_enabled = false where id = p_id and role = 'student';
    -- TODO: insert an audit-log row here, matching how admin_archive_account does it.
end $$;

-- 6. Permissions -------------------------------------------------
revoke all on function public._pl_require_admin(text) from public, anon, authenticated;
grant execute on function public.admin_pay_later_list(text, text, text, int, int) to anon, authenticated;
grant execute on function public.admin_pay_later_entries(text, uuid) to anon, authenticated;
grant execute on function public.admin_set_pay_later(text, uuid, boolean) to anon, authenticated;
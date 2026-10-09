-- ============================================================
-- Pay Later Ledger (admin)
-- Run in the Supabase SQL editor.
--
-- ASSUMPTIONS (adjust if your schema differs):
--   * public.accounts holds students (role = 'student'), as used by Account Management.
--   * "Linked to a parent" means the student has an ACTIVE row in public.parent_links.
--     If you already have a parent-linking table, drop the parent_links block below
--     and point the lateral join in admin_pay_later_list (and the check in
--     admin_set_pay_later) at your table instead.
--   * public.card_session(p_token) returns json with a "role" key (see login.sql).
-- ============================================================

-- 1. Parent links ------------------------------------------------
create table if not exists public.parent_links (
    id           uuid primary key default gen_random_uuid(),
    student_id   uuid not null references public.accounts(id) on delete cascade,
    parent_name  text not null,
    parent_email text,
    status       text not null default 'active' check (status in ('active', 'revoked')),
    linked_at    timestamptz not null default now()
);
create index if not exists parent_links_student on public.parent_links (student_id) where status = 'active';
alter table public.parent_links enable row level security;   -- no direct access; use the RPCs

-- 2. Ledger entries ----------------------------------------------
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

-- 3. Admin check -------------------------------------------------
create or replace function public._pl_require_admin(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
    if coalesce((public.card_session(p_token))->>'role', '') <> 'admin' then
        raise exception 'Permission denied. Sign in as an admin.' using errcode = '42501';
    end if;
end $$;

-- 4. List students with parent-link status -----------------------
create or replace function public.admin_pay_later_list(
    p_token text, p_search text default '', p_filter text default 'all',
    p_limit int default 5, p_offset int default 0)
returns table (
    id uuid, student_id text, full_name text, suffix text,
    parent_linked boolean, parent_name text,
    pay_later_enabled boolean, outstanding numeric, total_count bigint)
language plpgsql security definer set search_path = public as $$
begin
    perform public._pl_require_admin(p_token);
    return query
    with base as (
        select a.id, a.student_id, a.full_name, a.suffix, a.pay_later_enabled,
               pl.parent_name,
               (pl.parent_name is not null) as linked,
               coalesce((select sum(case e.kind when 'charge' then e.amount else -e.amount end)
                         from public.pay_later_entries e where e.student_id = a.id), 0) as owed
        from public.accounts a
        left join lateral (
            select l.parent_name from public.parent_links l
            where l.student_id = a.id and l.status = 'active'
            order by l.linked_at limit 1) pl on true
        where a.role = 'student' and a.status <> 'archived'
          and (coalesce(p_search, '') = ''
               or a.full_name ilike '%' || p_search || '%'
               or a.student_id ilike '%' || p_search || '%')
    ), filtered as (
        select * from base
        where p_filter = 'all'
           or (p_filter = 'eligible' and linked)
           or (p_filter = 'unlinked' and not linked)
    )
    select f.id, f.student_id, f.full_name, f.suffix,
           f.linked, f.parent_name,
           (f.linked and coalesce(f.pay_later_enabled, false)),
           f.owed,
           count(*) over () as total_count
    from filtered f
    order by f.full_name asc
    limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end $$;

-- 5. Ledger entries for one student ------------------------------
create or replace function public.admin_pay_later_entries(p_token text, p_id uuid)
returns table (id uuid, kind text, amount numeric, note text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
    perform public._pl_require_admin(p_token);
    return query
    select e.id, e.kind, e.amount, e.note, e.created_at
    from public.pay_later_entries e
    where e.student_id = p_id
    order by e.created_at desc
    limit 200;
end $$;

-- 6. Enable / disable pay later (blocked when no parent is linked)
create or replace function public.admin_set_pay_later(p_token text, p_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
    perform public._pl_require_admin(p_token);
    if p_enabled and not exists (
        select 1 from public.parent_links l where l.student_id = p_id and l.status = 'active') then
        raise exception 'This student is not eligible for a pay later because this student isn''t currently linked to a parent.';
    end if;
    update public.accounts set pay_later_enabled = p_enabled where id = p_id and role = 'student';
    -- TODO: insert an audit-log row here, matching how admin_archive_account does it.
end $$;

-- 7. Permissions -------------------------------------------------
revoke all on function public._pl_require_admin(text) from public, anon, authenticated;
grant execute on function public.admin_pay_later_list(text, text, text, int, int) to anon, authenticated;
grant execute on function public.admin_pay_later_entries(text, uuid) to anon, authenticated;
grant execute on function public.admin_set_pay_later(text, uuid, boolean) to anon, authenticated;
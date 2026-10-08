-- ============================================================
-- TapMate schema v3: one `accounts` table for Student, Admin
-- and Cashier. Run in Supabase > SQL Editor > New query.
--
-- NOTE: this DROPS the old `students` / `accounts` tables, so
-- use it on a fresh or test project (or export your data first).
-- ============================================================

create extension if not exists pg_trgm;   -- fast "contains" search

drop table if exists public.students cascade;
drop table if exists public.accounts cascade;

create table public.accounts (
    id                uuid primary key default gen_random_uuid(),

    role              text not null default 'student'
                      check (role in ('student', 'admin', 'cashier')),
    status            text not null default 'active'
                      check (status in ('active', 'inactive')),

    -- identity (all roles)
    first_name        text not null check (char_length(btrim(first_name)) >= 1),
    middle_name       text,
    last_name         text not null check (char_length(btrim(last_name)) >= 1),
    full_name         text generated always as (
                          first_name
                          || coalesce(' ' || nullif(btrim(middle_name), ''), '')
                          || ' ' || last_name
                      ) stored,
    email             text not null unique
                      check (email ~ '^[a-z0-9._-]+@sjc\.edu\.ph$'),

    -- students only
    student_id        text unique check (student_id ~ '^\d{4}-\d{6}$'),   -- YYYY-NNNNNN
    balance           numeric(10,2) not null default 0   check (balance >= 0),
    daily_limit       numeric(10,2) not null default 200 check (daily_limit >= 0),
    pay_later_enabled boolean not null default false,

    -- admin / cashier only
    employee_id       text unique,                         -- staff reference number
    auth_user_id      uuid unique references auth.users (id) on delete set null,
                                                           -- their Supabase login

    -- any role: one RFID card = one account
    rfid_uid          text unique,

    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),

    -- students need an ID number; staff must not have one
    constraint student_id_by_role check (
        (role = 'student' and student_id is not null)
        or (role <> 'student' and student_id is null)
    ),
    -- wallet, spending limit and pay later are for students only
    constraint wallet_students_only check (
        role = 'student'
        or (balance = 0 and pay_later_enabled = false)
    ),
    -- employee ID / login link are for staff only
    constraint staff_fields_only check (
        role <> 'student' or (employee_id is null and auth_user_id is null)
    )
);

create index accounts_role_idx          on public.accounts (role);
create index accounts_full_name_trgm    on public.accounts using gin (full_name  gin_trgm_ops);
create index accounts_student_id_trgm   on public.accounts using gin (student_id gin_trgm_ops);

-- Keep updated_at fresh
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end $$;

create trigger accounts_set_updated_at
    before update on public.accounts
    for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- Staff login link: when a Supabase Auth user is created with the
-- same email as an admin/cashier account, connect them automatically.
-- (Students don't sign in with email; they tap their RFID card.)
-- ------------------------------------------------------------
create or replace function public.link_account_to_auth()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update public.accounts
       set auth_user_id = new.id
     where lower(email) = lower(new.email)
       and role in ('admin', 'cashier')
       and auth_user_id is null;
    return new;
end $$;

drop trigger if exists on_auth_user_link_account on auth.users;
create trigger on_auth_user_link_account
    after insert on auth.users
    for each row execute function public.link_account_to_auth();

-- ============================================================
-- Security (Row Level Security)
-- The anon key is public, so RLS is what actually protects data.
-- Who you are is read from the accounts table (no manual
-- app_metadata editing needed).
-- ============================================================
alter table public.accounts enable row level security;

-- SECURITY DEFINER so these lookups don't trigger RLS recursion
create or replace function public.current_account_role()
returns text language sql stable security definer set search_path = public as $$
    select role from public.accounts
     where auth_user_id = auth.uid() and status = 'active'
     limit 1
$$;

create or replace function public.is_admin()
returns boolean language sql stable as $$
    select coalesce(public.current_account_role(), '') = 'admin'
$$;

create or replace function public.is_cashier()
returns boolean language sql stable as $$
    select coalesce(public.current_account_role(), '') = 'cashier'
$$;

-- Admins: full access to every account
create policy "admins read"   on public.accounts for select using (public.is_admin());
create policy "admins insert" on public.accounts for insert with check (public.is_admin());
create policy "admins update" on public.accounts for update using (public.is_admin()) with check (public.is_admin());
create policy "admins delete" on public.accounts for delete using (public.is_admin());

-- Cashiers: can look up students (e.g. at the counter), nothing else
create policy "cashiers read students" on public.accounts
    for select using (public.is_cashier() and role = 'student');

-- Anyone signed in can read their own row (for the profile portal later)
create policy "read own account" on public.accounts
    for select using (auth_user_id = auth.uid());

-- ============================================================
-- FIRST ADMIN (bootstrap). Nobody can create accounts until one
-- admin exists, so run these once in the SQL Editor (they bypass
-- RLS). Replace the name and email with yours:
--
--   insert into public.accounts (role, first_name, last_name, email)
--   values ('admin', 'First', 'Last', 'username@sjc.edu.ph');
--
-- Then create that same email in Authentication > Users > Add user.
-- The trigger above links the login automatically. If the Auth
-- user already existed, link it by hand instead:
--
--   update public.accounts
--      set auth_user_id = (select id from auth.users where email = 'username@sjc.edu.ph')
--    where email = 'username@sjc.edu.ph';
--
-- Cashiers are added the same way with role = 'cashier'
-- (optionally add employee_id and rfid_uid).
-- ============================================================

-- ------------------------------------------------------------
-- TEMPORARY, LOCAL TESTING ONLY (before admin login exists):
-- lets anyone with the anon key read/write. Remove before going live!
--
-- create policy "dev open access" on public.accounts
--     for all using (true) with check (true);
-- ------------------------------------------------------------
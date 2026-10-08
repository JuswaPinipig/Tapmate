-- =====================================================================
-- TapMate | Audit logs
-- Run this once in the Supabase SQL editor.
-- Each row is one admin action, with a snapshot of who did it and the
-- values before and after. Rows can be added and read, never changed.
-- =====================================================================

create table if not exists public.audit_logs (
    id           bigint generated always as identity primary key,
    created_at   timestamptz not null default now(),

    -- Who did it. The admin's details are copied in (a snapshot) so the log
    -- stays accurate even if the admin is renamed, re-carded or removed later.
    admin_id     uuid references auth.users (id) on delete set null,
    admin_code   text not null,          -- assigned admin ID, e.g. ADM-0001
    admin_rfid   text,                   -- admin's RFID number
    admin_name   text not null,

    -- What was done.
    module       text not null check (module in ('accounts', 'products', 'pay_later', 'top_up', 'security')),
    action       text not null check (action in (
                     'create', 'update', 'archive', 'restore', 'rfid_assign',
                     'freeze', 'unfreeze', 'pin_reset', 'balance_adjust',
                     'approve', 'reject', 'settle', 'login')),
    summary      text not null,          -- plain sentence shown in the table

    -- What it was done to (optional, used for search and tracing).
    target_type  text,                   -- e.g. 'account', 'product'
    target_id    text,
    target_label text,                   -- e.g. 'Juan Dela Cruz (2024-001234)'

    -- Before and after. null before = created, null after = removed.
    -- Never put PINs or passwords in here.
    before_data  jsonb,
    after_data   jsonb
);

create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_module_idx  on public.audit_logs (module, created_at desc);
create index if not exists audit_logs_admin_idx   on public.audit_logs (admin_code, created_at desc);
create index if not exists audit_logs_action_idx  on public.audit_logs (action);
create index if not exists audit_logs_target_idx  on public.audit_logs (target_type, target_id);

comment on table public.audit_logs is 'Append-only record of admin actions with before/after values.';

-- ---------------------------------------------------------------------
-- Admin check
-- Assumes admins carry app_metadata.role = 'admin' in their Supabase auth
-- user. If you identify admins another way (for example a role column on
-- your accounts table), change only the body of this function.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- ---------------------------------------------------------------------
-- Row level security: admins can read, and can add rows under their own id
-- ---------------------------------------------------------------------
alter table public.audit_logs enable row level security;

drop policy if exists "admins read audit logs"   on public.audit_logs;
drop policy if exists "admins insert audit logs" on public.audit_logs;

create policy "admins read audit logs"
    on public.audit_logs for select
    to authenticated
    using (public.is_admin());

create policy "admins insert audit logs"
    on public.audit_logs for insert
    to authenticated
    with check (public.is_admin() and admin_id = auth.uid());

-- ---------------------------------------------------------------------
-- Append-only: block edits and deletes, even for admins
-- ---------------------------------------------------------------------
revoke update, delete, truncate on public.audit_logs from anon, authenticated;

create or replace function public.audit_logs_block_changes()
returns trigger
language plpgsql
as $$
begin
    raise exception 'audit_logs is append-only: % is not allowed', tg_op;
end;
$$;

drop trigger if exists audit_logs_no_update on public.audit_logs;
create trigger audit_logs_no_update
    before update or delete on public.audit_logs
    for each row execute function public.audit_logs_block_changes();

-- ---------------------------------------------------------------------
-- Admin list for the "Admin" filter on the page (latest name per admin)
-- ---------------------------------------------------------------------
create or replace view public.audit_admins
with (security_invoker = true) as
select distinct on (admin_code) admin_code, admin_name
from public.audit_logs
order by admin_code, created_at desc;

grant select on public.audit_admins to authenticated;
grant select, insert on public.audit_logs to authenticated;
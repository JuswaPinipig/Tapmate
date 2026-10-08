-- ============================================================
-- TapMate Register (cashier): store settings + cabinet links
-- Supabase > SQL Editor > New query > paste all > Run. Safe to re-run.
-- Run adminproducts.sql first (needs categories/products + is_admin_card()).
-- Everything the Register screen shows comes from the database.
-- ============================================================

-- 1) Store settings (currency, tax, name) - edit values here or in the admin portal
create table if not exists public.app_settings (
    key   text primary key,
    value text not null
);

insert into public.app_settings (key, value) values
    ('store_name', 'TapMate'),
    ('currency_symbol', '₱'),
    ('tax_rate', '0')
on conflict (key) do nothing;

-- 2) Cabinet links: each cashier module is its own page
create table if not exists public.portal_links (
    id         uuid primary key default gen_random_uuid(),
    label      text not null check (char_length(btrim(label)) between 1 and 40),
    href       text not null check (href ~ '^[A-Za-z0-9_./-]+\.html$'),
    sort_order int  not null default 0,
    active     boolean not null default true
);
create unique index if not exists portal_links_href_uq on public.portal_links (href);

insert into public.portal_links (label, href, sort_order) values
    ('Inventory',            'Inventory.html', 1),
    ('Refunds & disputes',   'Refunds.html',   2),
    ('Items sold analytics', 'Analytics.html', 3),
    ('Audit logs',           'AuditLogs.html', 4)
on conflict (href) do nothing;

-- 3) RLS: everyone reads, only admin writes
alter table public.app_settings enable row level security;
alter table public.portal_links enable row level security;

drop policy if exists "settings read"  on public.app_settings;
drop policy if exists "settings admin" on public.app_settings;
drop policy if exists "links read"     on public.portal_links;
drop policy if exists "links admin"    on public.portal_links;
create policy "settings read"  on public.app_settings for select using (true);
create policy "settings admin" on public.app_settings for all using (public.is_admin_card()) with check (public.is_admin_card());
create policy "links read"     on public.portal_links for select using (active or public.is_admin_card());
create policy "links admin"    on public.portal_links for all using (public.is_admin_card()) with check (public.is_admin_card());

grant select on public.app_settings, public.portal_links to anon, authenticated;
grant insert, update, delete on public.app_settings, public.portal_links to anon, authenticated;

notify pgrst, 'reload schema';
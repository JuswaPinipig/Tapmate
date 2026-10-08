-- ============================================================
-- TapMate products: categories + products + product image storage
-- Supabase > SQL Editor > New query > paste all > Run. Safe to re-run.
--
-- Admin-only writes use the same RFID-login token your account page
-- sends (x-card-token header) and checks it with card_session().
-- Everyone can READ the menu (products/categories/images).
-- No inventory/stock columns on purpose: that is managed elsewhere.
-- ============================================================

create extension if not exists pgcrypto;

-- 1) Who is the admin? Reads the x-card-token header and asks card_session().
create or replace function public.is_admin_card()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare tok text; r text;
begin
    tok := nullif(coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-card-token', '');
    if tok is null then return false; end if;
    select (public.card_session(tok))->>'role' into r;
    return coalesce(r, '') = 'admin';
exception when others then
    return false;
end $$;

grant execute on function public.is_admin_card() to anon, authenticated;

-- 2) Categories (each is either Food or a Beverage)
create table if not exists public.categories (
    id         uuid primary key default gen_random_uuid(),
    name       text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9 &''()/-]{0,39}$'),
    kind       text not null default 'food' check (kind in ('food', 'beverage')),
    created_at timestamptz not null default now()
);
create unique index if not exists categories_name_uq on public.categories (lower(name));

-- 3) Products
create table if not exists public.products (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(btrim(name)) between 1 and 60),
    category_id uuid not null references public.categories (id) on delete restrict,
    price       numeric(10,2) not null check (price > 0),
    description text check (description is null or char_length(description) <= 160),
    allergens   text[] not null default '{}' check (cardinality(allergens) <= 12),
    image_url   text,
    image_path  text,
    status      text not null default 'active' check (status in ('active', 'archived')),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index if not exists products_name_uq on public.products (lower(name));
create index if not exists products_category_idx on public.products (category_id);
create index if not exists products_status_idx   on public.products (status);

create or replace function public.products_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products
    for each row execute function public.products_set_updated_at();

-- 4) Row Level Security
alter table public.categories enable row level security;
alter table public.products   enable row level security;

drop policy if exists "categories read"  on public.categories;
drop policy if exists "categories admin" on public.categories;
create policy "categories read"  on public.categories for select using (true);
create policy "categories admin" on public.categories for all
    using (public.is_admin_card()) with check (public.is_admin_card());

drop policy if exists "products read"  on public.products;
drop policy if exists "products admin" on public.products;
create policy "products read"  on public.products for select using (status = 'active' or public.is_admin_card());
create policy "products admin" on public.products for all
    using (public.is_admin_card()) with check (public.is_admin_card());

grant select on public.categories, public.products to anon, authenticated;
grant insert, update, delete on public.categories, public.products to anon, authenticated; -- RLS above still decides who may

-- 5) Starter categories (edit/delete them in the app)
insert into public.categories (name, kind) values
    ('Rice Meals', 'food'), ('Snacks', 'food'), ('Beverages', 'beverage')
on conflict do nothing;

-- 6) Image storage: public bucket, only admins can add/replace/remove files
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "product images read"   on storage.objects;
drop policy if exists "product images insert" on storage.objects;
drop policy if exists "product images update" on storage.objects;
drop policy if exists "product images delete" on storage.objects;
create policy "product images read"   on storage.objects for select using (bucket_id = 'product-images');
create policy "product images insert" on storage.objects for insert with check (bucket_id = 'product-images' and public.is_admin_card());
create policy "product images update" on storage.objects for update using (bucket_id = 'product-images' and public.is_admin_card());
create policy "product images delete" on storage.objects for delete using (bucket_id = 'product-images' and public.is_admin_card());

notify pgrst, 'reload schema';

-- Verify: should list both tables and the bucket
select 'table' as kind, table_name as name from information_schema.tables
 where table_schema = 'public' and table_name in ('categories', 'products')
union all
select 'bucket', id from storage.buckets where id = 'product-images';
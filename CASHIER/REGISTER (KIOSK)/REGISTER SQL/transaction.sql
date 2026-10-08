-- ============================================================
-- TapMate patch: creates public.transactions (the wallet / kiosk purchase history).
-- The kiosk functions (kiosk_card_info, kiosk_checkout) and the student wallet page
-- all read or write this table, and it did not exist yet.
-- Safe to re-run. Supabase > SQL Editor > New query > paste > Run.
-- ============================================================

create table if not exists public.transactions (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references public.accounts (id) on delete cascade,
    type        text not null,                       -- e.g. 'purchase' (kiosk), top-ups, refunds
    amount      numeric(12,2) not null check (amount >= 0),
    description text,
    location    text,                                -- e.g. 'Kiosk'
    created_at  timestamptz not null default now()
);

create index if not exists transactions_account_idx
    on public.transactions (account_id, created_at desc);

-- Only the security-definer functions (kiosk_*, student_portal) touch this table
alter table public.transactions enable row level security;
revoke all on public.transactions from anon, authenticated;

notify pgrst, 'reload schema';
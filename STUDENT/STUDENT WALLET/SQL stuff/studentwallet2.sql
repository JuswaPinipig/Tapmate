-- ============================================================
-- Student portal: wallet, daily limit, Pay Later, PIN, spending limit
-- Run in Supabase > SQL Editor AFTER login.sql. Safe to re-run.
--
-- Assumed tables you may need to adjust (marked ">>> EDIT <<<"):
--   public.transactions (account_id, type, amount, description, location, created_at)
--   public.products     (id, name, price, category, is_available)
-- ============================================================

-- ---------- columns ----------
alter table public.accounts
    add column if not exists avatar_url             text,
    add column if not exists spending_limit         numeric(12,2) check (spending_limit is null or spending_limit > 0),
    add column if not exists pay_later_enabled      boolean       not null default false,
    add column if not exists pay_later_limit        numeric(12,2) not null default 0 check (pay_later_limit >= 0),
    add column if not exists pay_later_outstanding  numeric(12,2) not null default 0 check (pay_later_outstanding >= 0),
    add column if not exists pay_later_due_at       timestamptz,
    add column if not exists pay_later_used_count   int           not null default 0;

-- Admin-controlled settings (nothing about Pay Later is hardcoded in the page)
create table if not exists public.app_settings (key text primary key, value text not null);
insert into public.app_settings (key, value) values
    ('pay_later_default_limit', '0'),   -- amount given on activation; the admin changes this later
    ('pay_later_max_uses', '5')
on conflict (key) do nothing;

create table if not exists public.pay_later_requests (
    id         uuid primary key default gen_random_uuid(),
    account_id uuid not null references public.accounts (id) on delete cascade,
    status     text not null default 'pending' check (status in ('pending','approved','denied')),
    created_at timestamptz not null default now(),
    decided_at timestamptz
);
create unique index if not exists pay_later_one_pending on public.pay_later_requests (account_id) where status = 'pending';

create table if not exists public.pin_change_log (
    id         uuid primary key default gen_random_uuid(),
    account_id uuid not null references public.accounts (id) on delete cascade,
    changed_at timestamptz not null default now()
);
create index if not exists pin_change_log_idx on public.pin_change_log (account_id, changed_at desc);

alter table public.app_settings       enable row level security;
alter table public.pay_later_requests enable row level security;
alter table public.pin_change_log     enable row level security;
revoke all on public.app_settings, public.pay_later_requests, public.pin_change_log from anon, authenticated;

-- ---------- helpers ----------
create or replace function public._token_account(p_token text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
    select s.account_id from public.card_sessions s
      join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
       and s.expires_at > now() and a.status = 'active'
$$;
create or replace function public._setting_num(p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = public as $$
    select coalesce((select value::numeric from public.app_settings where key = p_key), p_default)
$$;
revoke execute on function public._token_account(text), public._setting_num(text, numeric) from public, anon, authenticated;

-- ---------- everything the page shows ----------
create or replace function public.student_portal(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c_limit constant int := 3;
    c_window constant interval := interval '24 hours';
    v_id uuid; a public.accounts;
    v_tx jsonb := '[]'::jsonb; v_tx_ok boolean := true; v_spent numeric := 0;
    v_count int; v_oldest timestamptz; v_max int; v_overdue boolean; v_pending boolean;
begin
    v_id := public._token_account(p_token);
    if v_id is null then return null; end if;
    select * into a from public.accounts where id = v_id;

    select count(*), min(changed_at) into v_count, v_oldest
      from public.pin_change_log where account_id = a.id and changed_at > now() - c_window;

    begin   -- >>> EDIT if your transactions table differs <<<
        select coalesce(jsonb_agg(t order by t.created_at desc), '[]'::jsonb) into v_tx
          from (select id, type, amount, description, location, created_at
                  from public.transactions where account_id = a.id
                 order by created_at desc limit 30) t;
        select coalesce(sum(amount), 0) into v_spent
          from public.transactions
         where account_id = a.id and type = 'purchase'
           and created_at >= (date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila');
    exception when undefined_table or undefined_column then
        v_tx := '[]'::jsonb; v_tx_ok := false; v_spent := 0;
    end;

    v_max     := public._setting_num('pay_later_max_uses', 5)::int;
    v_overdue := a.pay_later_outstanding > 0 and a.pay_later_due_at is not null and a.pay_later_due_at < now();
    v_pending := exists (select 1 from public.pay_later_requests where account_id = a.id and status = 'pending');

    return jsonb_build_object(
        'profile', jsonb_build_object(
            'first_name', a.first_name, 'middle_name', a.middle_name, 'last_name', a.last_name,
            'full_name', a.full_name, 'student_id', a.student_id, 'email', a.email,
            'avatar_url', a.avatar_url, 'balance', a.balance, 'updated_at', a.updated_at,
            'daily_limit', a.daily_limit, 'spending_limit', a.spending_limit, 'spent_today', v_spent),
        'card', case when a.rfid_uid is null then null else jsonb_build_object(
            'uid_last4', right(a.rfid_uid, 4),
            'has_pin', a.pin_hash is not null,
            'locked_until', case when a.pin_locked_until > now() then a.pin_locked_until end) end,
        'pin', jsonb_build_object('limit', c_limit,
            'remaining', greatest(c_limit - v_count, 0),
            'next_available_at', case when v_count >= c_limit then v_oldest + c_window end),
        'pay_later', jsonb_build_object(
            'enabled', a.pay_later_enabled, 'limit', a.pay_later_limit,
            'outstanding', a.pay_later_outstanding,
            'available', greatest(a.pay_later_limit - a.pay_later_outstanding, 0),
            'used_count', a.pay_later_used_count, 'max_uses', v_max,
            'due_at', a.pay_later_due_at, 'overdue', v_overdue, 'request_pending', v_pending,
            'can_activate', (not a.pay_later_enabled and not v_overdue
                             and a.pay_later_outstanding = 0 and a.pay_later_used_count < v_max)),
        'transactions', v_tx, 'transactions_ok', v_tx_ok);
end $$;

-- ---------- PIN change (3 per rolling 24 h) ----------
create or replace function public.student_change_pin(p_token text, p_current text, p_new text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c_limit constant int := 3;
    c_window constant interval := interval '24 hours';
    v_id uuid; a public.accounts; v_count int; v_oldest timestamptz;
begin
    v_id := public._token_account(p_token);
    if v_id is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into a from public.accounts where id = v_id for update;
    if a.pin_hash is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
    if a.pin_locked_until is not null and a.pin_locked_until > now() then
        return jsonb_build_object('ok', false, 'reason', 'locked');
    end if;
    select count(*), min(changed_at) into v_count, v_oldest
      from public.pin_change_log where account_id = a.id and changed_at > now() - c_window;
    if v_count >= c_limit then
        return jsonb_build_object('ok', false, 'reason', 'limit', 'next_available_at', v_oldest + c_window);
    end if;
    if p_new is null or p_new !~ '^\d{4}$' then return jsonb_build_object('ok', false, 'reason', 'format'); end if;
    if a.pin_hash <> crypt(coalesce(p_current, ''), a.pin_hash) then
        update public.accounts
           set pin_failed_attempts = case when pin_failed_attempts + 1 >= 5 then 0 else pin_failed_attempts + 1 end,
               pin_locked_until    = case when pin_failed_attempts + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
         where id = a.id;
        return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
    end if;
    if a.pin_hash = crypt(p_new, a.pin_hash) then return jsonb_build_object('ok', false, 'reason', 'same'); end if;

    update public.accounts set pin_hash = crypt(p_new, gen_salt('bf')), pin_failed_attempts = 0, pin_locked_until = null where id = a.id;
    insert into public.pin_change_log (account_id) values (a.id);
    return jsonb_build_object('ok', true);
end $$;

-- ---------- Pay Later ----------
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
           pay_later_limit = public._setting_num('pay_later_default_limit', 0),   -- comes from the admin's setting
           pay_later_used_count = pay_later_used_count + 1
     where id = a.id;
    return jsonb_build_object('ok', true);
end $$;

create or replace function public.student_request_pay_later_increase(p_token text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; a public.accounts;
begin
    v_id := public._token_account(p_token);
    if v_id is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into a from public.accounts where id = v_id;
    if not a.pay_later_enabled then return jsonb_build_object('ok', false, 'reason', 'inactive'); end if;
    if a.pay_later_outstanding > 0 and a.pay_later_due_at is not null and a.pay_later_due_at < now() then
        return jsonb_build_object('ok', false, 'reason', 'overdue');
    end if;
    begin
        insert into public.pay_later_requests (account_id) values (a.id);
    exception when unique_violation then
        return jsonb_build_object('ok', false, 'reason', 'pending');
    end;
    return jsonb_build_object('ok', true);
end $$;

-- ---------- Spending limit (never above the admin-assigned daily limit) ----------
create or replace function public.student_set_spending_limit(p_token text, p_limit numeric)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; a public.accounts;
begin
    v_id := public._token_account(p_token);
    if v_id is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    select * into a from public.accounts where id = v_id for update;
    if p_limit is null or p_limit <= 0 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
    if a.daily_limit is not null and a.daily_limit > 0 and p_limit > a.daily_limit then
        return jsonb_build_object('ok', false, 'reason', 'too_high', 'max', a.daily_limit);
    end if;
    update public.accounts set spending_limit = round(p_limit, 2) where id = a.id;
    return jsonb_build_object('ok', true);
end $$;

-- ---------- Products within a limit (used by the AI recommendation function) ----------
create or replace function public.student_products(p_token text, p_limit numeric)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v jsonb := '[]'::jsonb;
begin
    if public._token_account(p_token) is null then return null; end if;
    begin   -- >>> EDIT if your products table differs <<<
        select coalesce(jsonb_agg(p), '[]'::jsonb) into v
          from (select id, name, price, category from public.products
                 where is_available and price <= p_limit order by name limit 60) p;
    exception when undefined_table or undefined_column then
        v := '[]'::jsonb;
    end;
    return v;
end $$;

-- ---------- who can call what ----------
revoke execute on function public.student_portal(text), public.student_change_pin(text, text, text),
    public.student_activate_pay_later(text), public.student_request_pay_later_increase(text),
    public.student_set_spending_limit(text, numeric), public.student_products(text, numeric) from public;
grant execute on function public.student_portal(text), public.student_change_pin(text, text, text),
    public.student_activate_pay_later(text), public.student_request_pay_later_increase(text),
    public.student_set_spending_limit(text, numeric), public.student_products(text, numeric) to anon, authenticated;
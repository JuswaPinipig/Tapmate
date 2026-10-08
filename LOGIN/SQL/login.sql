-- ============================================================
-- TapMate: RFID tap + PIN login
-- Run AFTER the accounts schema (v3), in Supabase > SQL Editor.
-- Safe to re-run.
--
-- How it works
--   1. Page calls card_lookup(uid)     -> is this card assigned? has a PIN?
--   2. Page calls card_login(uid, pin) -> checks the PIN on the server,
--                                         returns a session token + profile
--   3. Later pages call card_session(token) to confirm who is signed in.
--
-- The browser never reads the accounts table or the PIN hash. Everything
-- goes through the functions below, so the public anon key can't be used
-- to look up cards or guess PINs outside the lockout rules.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ------------------------------------------------------------
-- 1. PIN columns on accounts
-- ------------------------------------------------------------
alter table public.accounts
    add column if not exists pin_hash            text,
    add column if not exists pin_failed_attempts int not null default 0,
    add column if not exists pin_locked_until    timestamptz,
    add column if not exists has_pin             boolean
        generated always as (pin_hash is not null) stored;

-- Nobody using the API (anon / signed-in admins) can read the hash.
-- Select is granted per column instead; pin_hash is left out on purpose.
-- NOTE: if you add new columns to accounts later, grant select on them too.
revoke select on public.accounts from anon, authenticated;
grant select (
    id, role, status, first_name, middle_name, last_name, full_name, email,
    student_id, balance, daily_limit, pay_later_enabled,
    employee_id, auth_user_id, rfid_uid, has_pin, created_at, updated_at
) on public.accounts to anon, authenticated;

-- ------------------------------------------------------------
-- 2. Login sessions (only the functions below can touch this table)
-- ------------------------------------------------------------
create table if not exists public.card_sessions (
    id          uuid primary key default gen_random_uuid(),
    account_id  uuid not null references public.accounts (id) on delete cascade,
    token_hash  text not null unique,        -- sha256 of the token; the raw token is never stored
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null
);
create index if not exists card_sessions_expires_idx on public.card_sessions (expires_at);

alter table public.card_sessions enable row level security;   -- no policies = no direct access
revoke all on public.card_sessions from anon, authenticated;

-- ------------------------------------------------------------
-- 3. Helper: what the page is allowed to know about a signed-in account
-- ------------------------------------------------------------
create or replace function public._account_profile(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
    select jsonb_build_object(
        'id',                id,
        'role',              role,
        'first_name',        first_name,
        'full_name',         full_name,
        'student_id',        student_id,
        'employee_id',       employee_id,
        'balance',           balance,
        'daily_limit',       daily_limit,
        'pay_later_enabled', pay_later_enabled
    )
    from public.accounts where id = p_id
$$;
revoke execute on function public._account_profile(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. Step 1: card tapped
--    Returns a status and, for a usable card, the owner's name
--    (shown as "Welcome, <name>" on the PIN screen). Nothing else.
-- ------------------------------------------------------------
create or replace function public.card_lookup(p_uid text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    a public.accounts;
begin
    select * into a from public.accounts where rfid_uid = btrim(p_uid);

    if not found then
        return jsonb_build_object('status', 'unassigned');
    end if;
    if a.status <> 'active' then
        return jsonb_build_object('status', 'inactive');
    end if;
    return jsonb_build_object('status', 'ok', 'has_pin', a.pin_hash is not null, 'name', a.full_name);
end $$;

-- ------------------------------------------------------------
-- 5. Step 2: PIN entered
--    5 wrong PINs in a row locks that card for 15 minutes.
-- ------------------------------------------------------------
create or replace function public.card_login(p_uid text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c_max_attempts constant int      := 5;
    c_lock_for     constant interval := interval '15 minutes';
    c_session_for  constant interval := interval '8 hours';

    a         public.accounts;
    v_token   text;
    v_expires timestamptz;
    v_failed  int;
begin
    -- FOR UPDATE serialises parallel guesses on the same card
    select * into a from public.accounts where rfid_uid = btrim(p_uid) for update;

    if not found then
        return jsonb_build_object('ok', false, 'reason', 'unassigned');
    end if;
    if a.status <> 'active' then
        return jsonb_build_object('ok', false, 'reason', 'inactive');
    end if;
    if a.pin_hash is null then
        return jsonb_build_object('ok', false, 'reason', 'no_pin');
    end if;
    if a.pin_locked_until is not null and a.pin_locked_until > now() then
        return jsonb_build_object(
            'ok', false, 'reason', 'locked',
            'retry_after_seconds', ceil(extract(epoch from (a.pin_locked_until - now())))::int
        );
    end if;

    -- Correct PIN
    if a.pin_hash = crypt(coalesce(p_pin, ''), a.pin_hash) then
        update public.accounts
           set pin_failed_attempts = 0, pin_locked_until = null
         where id = a.id;

        delete from public.card_sessions where expires_at < now();   -- housekeeping

        v_token   := encode(gen_random_bytes(32), 'hex');
        v_expires := now() + c_session_for;
        insert into public.card_sessions (account_id, token_hash, expires_at)
        values (a.id, encode(digest(v_token, 'sha256'), 'hex'), v_expires);

        return jsonb_build_object(
            'ok', true,
            'token', v_token,
            'expires_at', v_expires,
            'profile', public._account_profile(a.id)
        );
    end if;

    -- Wrong PIN (we return instead of raising, so the counter is saved)
    v_failed := a.pin_failed_attempts + 1;

    if v_failed >= c_max_attempts then
        update public.accounts
           set pin_failed_attempts = 0, pin_locked_until = now() + c_lock_for
         where id = a.id;
        return jsonb_build_object(
            'ok', false, 'reason', 'locked',
            'retry_after_seconds', extract(epoch from c_lock_for)::int
        );
    end if;

    update public.accounts set pin_failed_attempts = v_failed where id = a.id;
    return jsonb_build_object(
        'ok', false, 'reason', 'invalid',
        'attempts_left', c_max_attempts - v_failed
    );
end $$;

-- ------------------------------------------------------------
-- 6. Session check + sign out (for your dashboard / other pages)
-- ------------------------------------------------------------
create or replace function public.card_session(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v_account uuid;
begin
    select s.account_id into v_account
      from public.card_sessions s
      join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
       and s.expires_at > now()
       and a.status = 'active';

    if v_account is null then
        return null;
    end if;
    return public._account_profile(v_account);
end $$;

create or replace function public.card_logout(p_token text)
returns void language sql security definer set search_path = public, extensions as $$
    delete from public.card_sessions
     where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- ------------------------------------------------------------
-- 7. Admin: set or reset someone's PIN (4 digits)
--    Needs an admin to be signed in with Supabase Auth (is_admin()).
-- ------------------------------------------------------------
create or replace function public.admin_set_pin(p_account_id uuid, p_pin text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
    if not public.is_admin() then
        raise exception 'Only admins can set PINs' using errcode = '42501';
    end if;
    if p_pin is null or p_pin !~ '^\d{4}$' then
        raise exception 'PIN must be exactly 4 digits' using errcode = '22023';
    end if;

    update public.accounts
       set pin_hash = crypt(p_pin, gen_salt('bf')),
           pin_failed_attempts = 0,
           pin_locked_until = null
     where id = p_account_id;

    if not found then
        raise exception 'Account not found' using errcode = 'P0002';
    end if;

    delete from public.card_sessions where account_id = p_account_id;   -- sign them out everywhere
end $$;

-- ------------------------------------------------------------
-- 8. Who can call what
-- ------------------------------------------------------------
revoke execute on function public.card_lookup(text)        from public;
revoke execute on function public.card_login(text, text)   from public;
revoke execute on function public.card_session(text)       from public;
revoke execute on function public.card_logout(text)        from public;
revoke execute on function public.admin_set_pin(uuid, text) from public;

grant execute on function public.card_lookup(text)         to anon, authenticated;
grant execute on function public.card_login(text, text)    to anon, authenticated;
grant execute on function public.card_session(text)        to anon, authenticated;
grant execute on function public.card_logout(text)         to anon, authenticated;
grant execute on function public.admin_set_pin(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 9. Let an RFID + PIN login act as admin / cashier
--    Your row-level security asks current_account_role() "who is this?".
--    The old version only understood Supabase Auth (email + password).
--    This one also accepts the token from card_login(), which the pages
--    send in an "x-card-token" header. The existing admin / cashier
--    policies then work unchanged for anyone who tapped in.
-- ------------------------------------------------------------
create or replace function public.current_account_role()
returns text language plpgsql stable security definer
set search_path = public, extensions as $$
declare
    v_role  text;
    v_token text;
begin
    -- a) Supabase Auth login (email + password), if one exists
    if auth.uid() is not null then
        select role into v_role
          from public.accounts
         where auth_user_id = auth.uid() and status = 'active'
         limit 1;
        if v_role is not null then
            return v_role;
        end if;
    end if;

    -- b) RFID + PIN session token from the request header
    begin
        v_token := nullif(current_setting('request.headers', true), '')::json ->> 'x-card-token';
    exception when others then
        v_token := null;
    end;

    if v_token is null or v_token = '' then
        return null;
    end if;

    select a.role into v_role
      from public.card_sessions s
      join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(v_token, 'sha256'), 'hex')
       and s.expires_at > now()
       and a.status = 'active'
     limit 1;

    return v_role;
end $$;

-- ============================================================
-- FIRST ADMIN (run once, separately, after everything above)
-- The SQL Editor bypasses row-level security, so you can create the
-- first admin here without any email / password login.
--
--  * rfid_uid : the card number. Open login.html, press F12 > Console,
--               tap the card: it prints "Unassigned card number: ..."
--  * PIN      : exactly 4 digits
--  * email    : lowercase, ends with @sjc.edu.ph
--
--   insert into public.accounts
--       (role, first_name, last_name, email, employee_id, rfid_uid, pin_hash)
--   values
--       ('admin', 'First', 'Last', 'username@sjc.edu.ph', 'ADM-001',
--        'PUT_CARD_NUMBER_HERE',
--        extensions.crypt('1234', extensions.gen_salt('bf')));
--
-- Already inserted an admin row earlier without a card or PIN? Use:
--
--   update public.accounts
--      set rfid_uid = 'PUT_CARD_NUMBER_HERE',
--          pin_hash = extensions.crypt('1234', extensions.gen_salt('bf')),
--          pin_failed_attempts = 0, pin_locked_until = null
--    where email = 'username@sjc.edu.ph';
-- ============================================================

-- ============================================================
-- TESTING: give a student a PIN by hand (works without admin login).
-- Replace the student ID and PIN.
--
--   update public.accounts
--      set pin_hash = extensions.crypt('1234', extensions.gen_salt('bf')),
--          pin_failed_attempts = 0, pin_locked_until = null
--    where student_id = '2024-000001';
--
-- Unlock a card early:
--
--   update public.accounts
--      set pin_failed_attempts = 0, pin_locked_until = null
--    where rfid_uid = 'THE_CARD_NUMBER';
-- ============================================================
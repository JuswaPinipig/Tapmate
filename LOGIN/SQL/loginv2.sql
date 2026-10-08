-- ============================================================
-- TapMate: sign in with school email + RFID number (no card tap)
-- Run AFTER login.sql, in Supabase > SQL Editor. Safe to re-run.
--
-- Flow: card_lookup_email(email, rfid) -> if both match, the page shows
-- the PIN screen and the existing card_login(rfid, pin) finishes the
-- sign-in. So the PIN rules, lockout and session token are unchanged.
--
-- Wrong email/number guesses are counted per account:
-- 5 in a row locks THIS email sign-in for 15 minutes.
-- (Separate from the PIN lockout, which still applies afterwards.)
-- ============================================================

alter table public.accounts
    add column if not exists cred_failed_attempts int not null default 0,
    add column if not exists cred_locked_until    timestamptz;
-- (not added to the select grant on purpose: the browser can't read them)

create or replace function public.card_lookup_email(p_email text, p_rfid text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    c_max_attempts constant int      := 5;
    c_lock_for     constant interval := interval '15 minutes';

    a        public.accounts;
    v_failed int;
begin
    -- FOR UPDATE serialises parallel guesses on the same account
    select * into a
      from public.accounts
     where lower(email) = lower(btrim(coalesce(p_email, '')))
     for update;

    -- Unknown email: same answer as a wrong number
    if not found then
        return jsonb_build_object('status', 'invalid');
    end if;

    if a.cred_locked_until is not null and a.cred_locked_until > now() then
        return jsonb_build_object(
            'status', 'locked',
            'retry_after_seconds', ceil(extract(epoch from (a.cred_locked_until - now())))::int
        );
    end if;

    -- Wrong RFID number (we return instead of raising, so the counter is saved)
    if a.rfid_uid is null or a.rfid_uid <> btrim(coalesce(p_rfid, '')) then
        v_failed := a.cred_failed_attempts + 1;

        if v_failed >= c_max_attempts then
            update public.accounts
               set cred_failed_attempts = 0, cred_locked_until = now() + c_lock_for
             where id = a.id;
            return jsonb_build_object(
                'status', 'locked',
                'retry_after_seconds', extract(epoch from c_lock_for)::int
            );
        end if;

        update public.accounts set cred_failed_attempts = v_failed where id = a.id;
        return jsonb_build_object('status', 'invalid');
    end if;

    -- Email and number match
    update public.accounts
       set cred_failed_attempts = 0, cred_locked_until = null
     where id = a.id;

    if a.status <> 'active' then
        return jsonb_build_object('status', 'inactive');
    end if;

    return jsonb_build_object('status', 'ok', 'has_pin', a.pin_hash is not null, 'name', a.full_name);
end $$;

revoke execute on function public.card_lookup_email(text, text) from public;
grant  execute on function public.card_lookup_email(text, text) to anon, authenticated;

-- Unlock someone's email sign-in early:
--
--   update public.accounts
--      set cred_failed_attempts = 0, cred_locked_until = null
--    where email = 'username@sjc.edu.ph';
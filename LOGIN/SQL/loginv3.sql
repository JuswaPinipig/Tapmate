-- TapMate: parent login (email or PH mobile + password + 4-digit PIN).
-- Same session mechanism as card_login: a random token is returned to the
-- browser and only its sha256 hash is stored in card_sessions (8 hours).
-- Run once in the Supabase SQL editor.

create or replace function public.parent_login(p_contact text, p_password text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
    c_max_attempts constant int      := 5;
    c_lock_for     constant interval := interval '15 minutes';
    c_session_for  constant interval := interval '8 hours';

    a         public.accounts;
    v_contact text := btrim(coalesce(p_contact, ''));
    v_email   text;
    v_phone   text;
    v_token   text;
    v_expires timestamptz;
    v_failed  int;
begin
    -- Same contact rules as parent_sign_up: email, or PH mobile stored as +639XXXXXXXXX
    if v_contact like '%@%' then
        v_email := lower(v_contact);
    else
        v_phone := regexp_replace(v_contact, '[\s\-()]', '', 'g');
        if v_phone ~ '^09\d{9}$'     then v_phone := '+63' || substr(v_phone, 2);
        elsif v_phone ~ '^639\d{9}$' then v_phone := '+' || v_phone; end if;
    end if;

    -- FOR UPDATE serialises parallel guesses on the same account
    select * into a
      from public.accounts
     where role = 'parent'
       and ((v_email is not null and lower(email) = v_email)
         or (v_phone is not null and phone = v_phone))
     for update;

    if not found then
        perform crypt(coalesce(p_password, ''), gen_salt('bf'));   -- keeps timing similar
        return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
    if a.status <> 'active' then
        return jsonb_build_object('ok', false, 'reason', 'inactive');
    end if;
    if a.pin_locked_until is not null and a.pin_locked_until > now() then
        return jsonb_build_object(
            'ok', false, 'reason', 'locked',
            'retry_after_seconds', ceil(extract(epoch from (a.pin_locked_until - now())))::int
        );
    end if;

    -- Password AND PIN must both be right
    if a.password_hash is not null and a.password_hash = crypt(coalesce(p_password, ''), a.password_hash)
       and a.pin_hash is not null and a.pin_hash = crypt(coalesce(p_pin, ''), a.pin_hash) then

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
            'profile', jsonb_build_object(
                'id', a.id,
                'role', 'parent',
                'first_name', a.first_name,
                'last_name', a.last_name,
                'full_name', btrim(a.first_name || ' ' || a.last_name)
            )
        );
    end if;

    -- Wrong password or PIN: count it, lock after 5 (no hint about which one was wrong)
    v_failed := coalesce(a.pin_failed_attempts, 0) + 1;
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
    return jsonb_build_object('ok', false, 'reason', 'invalid');
end $function$;

grant execute on function public.parent_login(text, text, text) to anon, authenticated;
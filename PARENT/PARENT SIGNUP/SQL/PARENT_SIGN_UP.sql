-- ============================================================
-- TapMate: parent sign-up (opened from the student's QR / 6-digit code)
-- Run AFTER your earlier migrations, in Supabase > SQL Editor. Safe to re-run.
--
-- Flow: parent_link_preview(link)  -> page shows "Linking to <student>"
--       parent_sign_up(...)        -> creates the parent account (email OR phone,
--                                     password, 4-digit PIN), links the student,
--                                     and burns the code.
--
-- !! ASSUMPTIONS (the earlier SQL wasn't uploaded) - adjust if yours differ:
--   1. accounts has: id, role, status, first_name, last_name, email, phone, pin_hash
--      (full_name is generated / filled by a trigger, as loginv2.sql implies)
--   2. accounts.role allows 'parent' (if there is a CHECK constraint, add it)
--   3. student_create_parent_link stores codes in public.parent_link_codes
--      (qr_token text, code text, student_id uuid, expires_at timestamptz,
--       used_at timestamptz). Only _find_parent_link() below touches it.
--   4. PINs/passwords are hashed with pgcrypto: crypt(x, gen_salt('bf'))
-- ============================================================

alter table public.accounts add column if not exists password_hash text;

-- One parent per student (matches the wallet's "Linked to <parent>" state)
create table if not exists public.parent_student_links (
    id         uuid primary key default gen_random_uuid(),
    parent_id  uuid not null references public.accounts(id) on delete cascade,
    student_id uuid not null references public.accounts(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique (student_id)
);
alter table public.parent_student_links enable row level security;   -- no policies: RPC only

-- Throttle for guessing 6-digit codes
create table if not exists public.parent_signup_failures (at timestamptz not null default now());
alter table public.parent_signup_failures enable row level security;

-- ---- the ONE place that knows how codes are stored -------------------------
create or replace function public._find_parent_link(p_link text)
returns table (student_id uuid, expires_at timestamptz, used_at timestamptz, qr_token text)
language sql security definer set search_path = public as $$
    select c.student_id, c.expires_at, c.used_at, c.qr_token
      from public.parent_link_codes c
     where c.qr_token = btrim(p_link)
        or c.code     = regexp_replace(btrim(p_link), '\s', '', 'g')
     order by c.expires_at desc
     limit 1;
$$;

-- ---- preview: valid link? who is it for? -----------------------------------
create or replace function public.parent_link_preview(p_link text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare l record; s public.accounts;
begin
    if (select count(*) from public.parent_signup_failures where at > now() - interval '10 minutes') >= 30 then
        return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;

    select * into l from public._find_parent_link(p_link);
    if not found then
        insert into public.parent_signup_failures default values;
        return jsonb_build_object('ok', false, 'reason', 'invalid_link');
    end if;
    if l.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if l.expires_at <= now()  then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if exists (select 1 from public.parent_student_links where student_id = l.student_id) then
        return jsonb_build_object('ok', false, 'reason', 'already_linked');
    end if;

    select * into s from public.accounts where id = l.student_id;
    return jsonb_build_object('ok', true, 'student_first_name', s.first_name);
end $$;

-- ---- sign up ---------------------------------------------------------------
create or replace function public.parent_sign_up(
    p_link text, p_contact text, p_first_name text, p_last_name text,
    p_password text, p_pin text
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
    l record; v_contact text := btrim(coalesce(p_contact, ''));
    v_email text; v_phone text; v_id uuid;
    v_first text := btrim(coalesce(p_first_name, '')); v_last text := btrim(coalesce(p_last_name, ''));
begin
    if (select count(*) from public.parent_signup_failures where at > now() - interval '10 minutes') >= 30 then
        return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;

    select * into l from public._find_parent_link(p_link);
    if not found then
        insert into public.parent_signup_failures default values;
        return jsonb_build_object('ok', false, 'reason', 'invalid_link');
    end if;
    if l.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if l.expires_at <= now()  then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if exists (select 1 from public.parent_student_links where student_id = l.student_id) then
        return jsonb_build_object('ok', false, 'reason', 'already_linked');
    end if;

    -- email OR Philippine mobile number (stored as +639XXXXXXXXX)
    if v_contact like '%@%' then
        v_email := lower(v_contact);
        if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('ok', false, 'reason', 'bad_contact'); end if;
    else
        v_phone := regexp_replace(v_contact, '[\s\-()]', '', 'g');
        if v_phone ~ '^09\d{9}$'   then v_phone := '+63' || substr(v_phone, 2);
        elsif v_phone ~ '^639\d{9}$' then v_phone := '+' || v_phone; end if;
        if v_phone !~ '^\+639\d{9}$' then return jsonb_build_object('ok', false, 'reason', 'bad_contact'); end if;
    end if;

    if char_length(v_first) < 1 or char_length(v_last) < 1 or char_length(v_first) > 60 or char_length(v_last) > 60 then
        return jsonb_build_object('ok', false, 'reason', 'bad_name');
    end if;
    if char_length(coalesce(p_password, '')) < 8 or p_password !~ '[A-Za-z]' or p_password !~ '\d' then
        return jsonb_build_object('ok', false, 'reason', 'weak_password');
    end if;
    if coalesce(p_pin, '') !~ '^\d{4}$' or p_pin ~ '^(\d)\1{3}$' then
        return jsonb_build_object('ok', false, 'reason', 'bad_pin');
    end if;

    if exists (select 1 from public.accounts
                where (v_email is not null and lower(email) = v_email)
                   or (v_phone is not null and phone = v_phone)) then
        return jsonb_build_object('ok', false, 'reason', 'exists');
    end if;

    insert into public.accounts (role, status, first_name, last_name, email, phone, password_hash, pin_hash)
    values ('parent', 'active', v_first, v_last, v_email, v_phone,
            crypt(p_password, gen_salt('bf')), crypt(p_pin, gen_salt('bf')))
    returning id into v_id;

    insert into public.parent_student_links (parent_id, student_id) values (v_id, l.student_id);
    update public.parent_link_codes set used_at = now() where qr_token = l.qr_token;

    return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.parent_link_preview(text)                                  from public;
revoke execute on function public.parent_sign_up(text, text, text, text, text, text)         from public;
revoke execute on function public._find_parent_link(text)                                    from public;
grant  execute on function public.parent_link_preview(text)                                  to anon, authenticated;
grant  execute on function public.parent_sign_up(text, text, text, text, text, text)         to anon, authenticated;
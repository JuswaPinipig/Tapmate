-- TapMate: parent overview + "confirm the link" step.
-- Run this whole file once in the Supabase SQL editor.
--
-- What changes
--   * A parent who signs up is no longer linked straight away. Sign-up now parks the
--     link in parent_pending_links. The link only becomes real (parent_student_links)
--     when the parent confirms it on their first login. So the student's side
--     ("Parent linked", Pay Later unlocked) only changes after the parent confirms.
--   * parent_portal(token)       -> what the parent dashboard shows (and whether to show the prompt)
--   * parent_confirm_link(token) -> the "Confirm & Link Account" button

-- 1) Pending links ------------------------------------------------------------
create table if not exists public.parent_pending_links (
    parent_id  uuid primary key references public.accounts(id) on delete cascade,
    student_id uuid not null    references public.accounts(id) on delete cascade,
    created_at timestamptz not null default now()
);
create unique index if not exists parent_pending_links_student_key
    on public.parent_pending_links (student_id);
alter table public.parent_pending_links enable row level security;   -- only the functions below touch it


-- 2) Sign-up: park the link instead of making it ------------------------------
--    (same as before, except the last steps: a newer sign-up for the same student
--     replaces an older unconfirmed one, and the link goes to parent_pending_links)
create or replace function public.parent_sign_up(p_link text, p_contact text, p_first_name text, p_last_name text, p_password text, p_pin text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
    l record; v_contact text := btrim(coalesce(p_contact, ''));
    v_email text; v_phone text; v_id uuid; v_pin text; v_tries int;
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
        if v_phone ~ '^09\d{9}$'     then v_phone := '+63' || substr(v_phone, 2);
        elsif v_phone ~ '^639\d{9}$' then v_phone := '+' || v_phone; end if;
        if v_phone !~ '^\+639\d{9}$' then return jsonb_build_object('ok', false, 'reason', 'bad_contact'); end if;
    end if;

    if char_length(v_first) < 1 or char_length(v_last) < 1 or char_length(v_first) > 60 or char_length(v_last) > 60 then
        return jsonb_build_object('ok', false, 'reason', 'bad_name');
    end if;
    if char_length(coalesce(p_password, '')) < 8 or p_password !~ '[A-Za-z]' or p_password !~ '\d' then
        return jsonb_build_object('ok', false, 'reason', 'weak_password');
    end if;

    -- the PIN must be the one issued in the student's account
    select issued_pin, pin_attempts into v_pin, v_tries
      from public.parent_link_codes where qr_token::text = l.qr_token for update;
    if v_pin is null then return jsonb_build_object('ok', false, 'reason', 'pin_not_issued'); end if;
    if coalesce(p_pin, '') <> v_pin then
        v_tries := coalesce(v_tries, 0) + 1;
        if v_tries >= 5 then      -- too many guesses: kill this code
            update public.parent_link_codes set pin_attempts = v_tries, expires_at = now() - interval '1 second'
             where qr_token::text = l.qr_token;
            return jsonb_build_object('ok', false, 'reason', 'locked');
        end if;
        update public.parent_link_codes set pin_attempts = v_tries where qr_token::text = l.qr_token;
        return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
    end if;

    if exists (select 1 from public.accounts
                where (v_email is not null and lower(email) = v_email)
                   or (v_phone is not null and phone = v_phone)) then
        return jsonb_build_object('ok', false, 'reason', 'exists');
    end if;

    insert into public.accounts (role, status, first_name, last_name, email, phone, password_hash, pin_hash)
    values ('parent', 'active', v_first, v_last, v_email, v_phone,
            crypt(p_password, gen_salt('bf')), crypt(v_pin, gen_salt('bf')))
    returning id into v_id;

    -- NEW: wait for the parent's confirmation on their first login
    delete from public.parent_pending_links where student_id = l.student_id;
    insert into public.parent_pending_links (parent_id, student_id) values (v_id, l.student_id);
    update public.parent_link_codes set used_at = now() where qr_token::text = l.qr_token;

    return jsonb_build_object('ok', true);
end $function$;


-- 3) The parent dashboard -----------------------------------------------------
--    Returns null for a bad/expired session (the page then goes back to login).
--    The student's wallet numbers come from the existing student_portal(), run on a
--    one-minute session that exists only inside this call (inserted and deleted in
--    the same transaction, so nobody else can ever see or use it). That keeps the
--    parent's numbers identical to what the student sees. Card and PIN details are
--    removed before anything is sent to the parent.
create or replace function public.parent_portal(p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
    v_parent  public.accounts;
    v_sid     uuid;
    v_pend    record;
    v_tok     text;
    v_hash    text;
    v_data    jsonb;
    v_err     text;
    v_out     jsonb;
begin
    select a.* into v_parent
      from public.card_sessions s
      join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
       and s.expires_at > now()
       and a.role = 'parent' and a.status = 'active';
    if not found then return null; end if;

    v_out := jsonb_build_object('parent', jsonb_build_object(
        'id', v_parent.id,
        'first_name', v_parent.first_name,
        'last_name', v_parent.last_name,
        'full_name', btrim(v_parent.first_name || ' ' || v_parent.last_name),
        'email', v_parent.email,
        'phone', v_parent.phone));

    select l.student_id into v_sid from public.parent_student_links l where l.parent_id = v_parent.id limit 1;

    -- Not confirmed yet: tell the page to show the "Link your account?" prompt
    if v_sid is null then
        select p.student_id, s.first_name, s.last_name into v_pend
          from public.parent_pending_links p
          join public.accounts s on s.id = p.student_id
         where p.parent_id = v_parent.id;
        return v_out || jsonb_build_object(
            'linked', false,
            'pending', case when v_pend.student_id is null then null else jsonb_build_object(
                'student_first_name', v_pend.first_name,
                'student_name', btrim(v_pend.first_name || ' ' || v_pend.last_name)) end);
    end if;

    -- Linked: borrow the student's own view for this one call
    v_tok  := encode(gen_random_bytes(32), 'hex');
    v_hash := encode(digest(v_tok, 'sha256'), 'hex');
    insert into public.card_sessions (account_id, token_hash, expires_at)
    values (v_sid, v_hash, now() + interval '1 minute');
    begin
        v_data := public.student_portal(v_tok);
    exception when others then
        v_data := null;
        v_err  := sqlerrm;
    end;
    delete from public.card_sessions where token_hash = v_hash;

    if v_data is null then
        return v_out || jsonb_build_object('linked', true, 'student', null, 'student_error', coalesce(v_err, 'student unavailable'));
    end if;
    v_data := v_data - 'card' - 'pin' - 'pay_later' - 'parent_link';
    return v_out || jsonb_build_object('linked', true, 'student', v_data);
end $function$;


-- 4) "Confirm & Link Account" ---------------------------------------------------
create or replace function public.parent_confirm_link(p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
    v_parent_id uuid;
    v_sid       uuid;
begin
    select a.id into v_parent_id
      from public.card_sessions s
      join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
       and s.expires_at > now()
       and a.role = 'parent' and a.status = 'active';
    if v_parent_id is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select student_id into v_sid from public.parent_pending_links where parent_id = v_parent_id for update;
    if v_sid is null then return jsonb_build_object('ok', false, 'reason', 'none'); end if;

    if exists (select 1 from public.parent_student_links where student_id = v_sid) then
        delete from public.parent_pending_links where parent_id = v_parent_id;
        return jsonb_build_object('ok', false, 'reason', 'taken');
    end if;

    insert into public.parent_student_links (parent_id, student_id) values (v_parent_id, v_sid);
    delete from public.parent_pending_links where parent_id = v_parent_id;
    return jsonb_build_object('ok', true);
end $function$;

grant execute on function public.parent_portal(text)       to anon, authenticated;
grant execute on function public.parent_confirm_link(text) to anon, authenticated;


-- 5) OPTIONAL: to see the prompt again with a parent you already created, move their
--    existing link back to "pending". Replace the email, run it, then log in as them.
--
-- with p as (select id from public.accounts where role = 'parent' and lower(email) = 'PARENT-EMAIL-HERE')
-- , moved as (delete from public.parent_student_links where parent_id in (select id from p) returning parent_id, student_id)
-- insert into public.parent_pending_links (parent_id, student_id) select parent_id, student_id from moved;
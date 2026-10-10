-- ============================================================
-- Parent: link to a student by scanning their QR code (for parents who already have an account,
-- e.g. after an admin unlinked them). Run AFTER parentoverview.sql. Safe to re-run.
--
-- Same safety steps as the sign-up flow:
--   1. parent_scan_link      - checks the scanned code, issues the 4-digit PIN (shown on the student's screen)
--   2. parent_link_with_pin  - parent types that PIN (5 wrong tries kill the code), then the link is parked in
--                              parent_pending_links and the parent confirms it on the dashboard ("Confirm & Link Account").
-- Uses the existing public._find_parent_link, parent_link_codes and parent_signup_failures objects.
-- ============================================================

create or replace function public._parent_session(p_token text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
    select a.id from public.card_sessions s join public.accounts a on a.id = s.account_id
     where s.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
       and s.expires_at > now() and a.role = 'parent' and a.status = 'active'
$$;
revoke execute on function public._parent_session(text) from public, anon, authenticated;

create or replace function public.parent_scan_link(p_token text, p_link text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_parent uuid := public._parent_session(p_token); l record; v_pin text; v_name text;
begin
    if v_parent is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if (select count(*) from public.parent_signup_failures where at > now() - interval '10 minutes') >= 30 then
        return jsonb_build_object('ok', false, 'reason', 'busy');
    end if;
    if exists (select 1 from public.parent_student_links where parent_id = v_parent) then
        return jsonb_build_object('ok', false, 'reason', 'parent_linked');
    end if;

    select * into l from public._find_parent_link(p_link);
    if not found then
        insert into public.parent_signup_failures default values;
        return jsonb_build_object('ok', false, 'reason', 'invalid_link');
    end if;
    if l.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if l.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if exists (select 1 from public.parent_student_links where student_id = l.student_id) then
        return jsonb_build_object('ok', false, 'reason', 'already_linked');
    end if;

    -- issue the PIN the student reads out (the student's page shows it once it exists)
    select issued_pin into v_pin from public.parent_link_codes where qr_token::text = l.qr_token for update;
    if v_pin is null then
        v_pin := lpad(((('x' || encode(gen_random_bytes(3), 'hex'))::bit(24)::int) % 10000)::text, 4, '0');
        update public.parent_link_codes set issued_pin = v_pin where qr_token::text = l.qr_token;
    end if;

    select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name
      from public.accounts where id = l.student_id;
    return jsonb_build_object('ok', true, 'student_name', v_name);
end $$;

create or replace function public.parent_link_with_pin(p_token text, p_link text, p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_parent uuid := public._parent_session(p_token); l record; v_pin text; v_tries int; v_name text;
begin
    if v_parent is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if exists (select 1 from public.parent_student_links where parent_id = v_parent) then
        return jsonb_build_object('ok', false, 'reason', 'parent_linked');
    end if;

    select * into l from public._find_parent_link(p_link);
    if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_link'); end if;
    if l.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
    if l.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
    if exists (select 1 from public.parent_student_links where student_id = l.student_id) then
        return jsonb_build_object('ok', false, 'reason', 'already_linked');
    end if;

    select issued_pin, pin_attempts into v_pin, v_tries
      from public.parent_link_codes where qr_token::text = l.qr_token for update;
    if v_pin is null then return jsonb_build_object('ok', false, 'reason', 'pin_not_issued'); end if;
    if coalesce(p_pin, '') <> v_pin then
        v_tries := coalesce(v_tries, 0) + 1;
        if v_tries >= 5 then
            update public.parent_link_codes set pin_attempts = v_tries, expires_at = now() - interval '1 second'
             where qr_token::text = l.qr_token;
            return jsonb_build_object('ok', false, 'reason', 'locked');
        end if;
        update public.parent_link_codes set pin_attempts = v_tries where qr_token::text = l.qr_token;
        return jsonb_build_object('ok', false, 'reason', 'wrong_pin');
    end if;

    -- park it: the parent still has to press "Confirm & Link Account"
    delete from public.parent_pending_links where student_id = l.student_id or parent_id = v_parent;
    insert into public.parent_pending_links (parent_id, student_id) values (v_parent, l.student_id);
    update public.parent_link_codes set used_at = now() where qr_token::text = l.qr_token;

    select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name
      from public.accounts where id = l.student_id;
    return jsonb_build_object('ok', true, 'student_name', v_name);
end $$;

grant execute on function public.parent_scan_link(text, text) to anon, authenticated;
grant execute on function public.parent_link_with_pin(text, text, text) to anon, authenticated;
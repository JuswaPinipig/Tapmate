-- ============================================================
-- TapMate v7 migration. Run AFTER v6. Safe to re-run.
-- Supabase > SQL Editor > New query.
--
-- Admin profile changes:
--   * profile picture (stored as a small 256x256 JPEG data URL in accounts.avatar)
--   * admins can NO LONGER edit their own name (admin_update_own_profile is removed)
-- ============================================================

alter table public.accounts add column if not exists avatar text;

alter table public.accounts drop constraint if exists accounts_avatar_check;
alter table public.accounts add  constraint accounts_avatar_check
    check (avatar is null or (avatar like 'data:image/jpeg;base64,%' and char_length(avatar) <= 150000));

-- Names are no longer self-editable: remove the old endpoint so it can't be called directly either
drop function if exists public.admin_update_own_profile(text, text, text, text);

-- Same as v6, plus the avatar
create or replace function public.admin_get_own_profile(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts;
begin
    select * into a from public.accounts where id = public._actor_id(actor);
    if not found then raise exception 'Account not found.'; end if;
    return jsonb_build_object(
        'id', a.id, 'first_name', a.first_name, 'middle_name', a.middle_name,
        'last_name', a.last_name, 'email', a.email, 'avatar', a.avatar
    ) || public._pin_allowance(a.id);
end $$;

-- Set (or remove, with null) the admin's own profile picture
create or replace function public.admin_update_own_avatar(p_token text, p_avatar text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts;
begin
    select * into a from public.accounts where id = public._actor_id(actor) for update;
    if not found then raise exception 'Account not found.'; end if;
    if p_avatar is not null and (p_avatar not like 'data:image/jpeg;base64,%' or char_length(p_avatar) > 150000) then
        raise exception 'That picture isn''t valid or is too large.';
    end if;
    update public.accounts set avatar = p_avatar where id = a.id;
    -- the image itself is never written to the audit log
    perform public._admin_audit(actor, 'own_avatar_updated', a,
        jsonb_build_object('change', case when p_avatar is null then 'removed' else 'changed' end));
    return jsonb_build_object('avatar', p_avatar);
end $$;

revoke execute on function public.admin_get_own_profile(text)          from public;
revoke execute on function public.admin_update_own_avatar(text, text)  from public;
grant  execute on function public.admin_get_own_profile(text)          to anon, authenticated;
grant  execute on function public.admin_update_own_avatar(text, text)  to anon, authenticated;
-- ============================================================
-- TapMate v6 migration. Run AFTER v5. Safe to re-run.
-- Supabase > SQL Editor > New query.
--
-- Adds the admin's OWN profile actions (sidebar > profile dialog):
--   * admin_get_own_profile      - name/email + PIN-change allowance
--   * admin_update_own_profile   - edit name (audited)
--   * admin_change_own_pin       - change PIN, max 3 per rolling 24 hours (audited)
--
-- !! ASSUMPTIONS - login.sql wasn't uploaded, so check these 3 lines:
--   1. public._admin_actor(p_token) returns jsonb that has the admin's account id
--      under the key 'id'  (see v_actor_id below).
--   2. PINs are stored in accounts.pin_hash using pgcrypto's crypt()/bf.
--      If your column or hashing differs, edit the two marked spots.
--   3. PINs are 4 digits (the default reset PIN is 1234).
-- ============================================================

create extension if not exists pgcrypto;

-- Every PIN change the admin makes themselves (resets by another admin don't count)
create table if not exists public.admin_pin_changes (
    id         bigint generated always as identity primary key,
    account_id uuid not null references public.accounts (id) on delete cascade,
    changed_at timestamptz not null default now()
);
create index if not exists admin_pin_changes_acct_idx
    on public.admin_pin_changes (account_id, changed_at desc);

alter table public.admin_pin_changes enable row level security;  -- no policies: only the functions below touch it

create or replace function public._actor_id(actor jsonb)
returns uuid language sql immutable as $$ select (actor->>'id')::uuid $$;   -- ASSUMPTION 1

-- Used / limit / when the next change is allowed (rolling 24h window)
create or replace function public._pin_allowance(p_account uuid)
returns jsonb language sql stable security definer set search_path = public as $$
    with recent as (
        select changed_at from public.admin_pin_changes
         where account_id = p_account and changed_at > now() - interval '24 hours'
    )
    select jsonb_build_object(
        'pin_limit', 3,
        'pin_used',  (select count(*) from recent),
        -- when the oldest of the last 3 changes drops out of the window
        'pin_next_at', case when (select count(*) from recent) >= 3
            then (select min(changed_at) + interval '24 hours'
                    from (select changed_at from recent order by changed_at desc limit 3) t)
            else null end
    )
$$;

create or replace function public.admin_get_own_profile(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts;
begin
    select * into a from public.accounts where id = public._actor_id(actor);
    if not found then raise exception 'Account not found.'; end if;
    return jsonb_build_object(
        'id', a.id, 'first_name', a.first_name, 'middle_name', a.middle_name,
        'last_name', a.last_name, 'email', a.email
    ) || public._pin_allowance(a.id);
end $$;

create or replace function public.admin_update_own_profile(
    p_token text, p_first text, p_middle text, p_last text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; old public.accounts;
begin
    select * into old from public.accounts where id = public._actor_id(actor) for update;
    if not found then raise exception 'Account not found.'; end if;
    -- names are validated by the accounts_validate_input trigger (v5)
    update public.accounts
       set first_name = btrim(p_first),
           middle_name = nullif(btrim(coalesce(p_middle, '')), ''),
           last_name = btrim(p_last)
     where id = old.id
     returning * into a;
    perform public._admin_audit(actor, 'own_profile_updated', a,
        jsonb_build_object('before', old.full_name, 'after', a.full_name));
    return jsonb_build_object('first_name', a.first_name, 'middle_name', a.middle_name,
                              'last_name', a.last_name, 'email', a.email);
end $$;

create or replace function public.admin_change_own_pin(
    p_token text, p_current text, p_new text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; allow jsonb;
begin
    select * into a from public.accounts where id = public._actor_id(actor) for update;
    if not found then raise exception 'Account not found.'; end if;

    allow := public._pin_allowance(a.id);
    if (allow->>'pin_used')::int >= (allow->>'pin_limit')::int then
        raise exception 'PIN change limit reached. You can change your PIN again after the cooldown ends.';
    end if;
    if p_new !~ '^[0-9]{4}$' then raise exception 'PIN must be exactly 4 digits.'; end if;
    if p_new = p_current then raise exception 'Your new PIN must be different from your current PIN.'; end if;

    -- ASSUMPTION 2: bcrypt hash in accounts.pin_hash
    if a.pin_hash is null or a.pin_hash <> crypt(p_current, a.pin_hash) then
        raise exception 'Your current PIN is incorrect.';
    end if;
    update public.accounts set pin_hash = crypt(p_new, gen_salt('bf')) where id = a.id;

    insert into public.admin_pin_changes (account_id) values (a.id);
    perform public._admin_audit(actor, 'own_pin_changed', a, '{}'::jsonb);   -- never log the PIN itself
    return public._pin_allowance(a.id);
end $$;

revoke execute on function public.admin_get_own_profile(text)                     from public;
revoke execute on function public.admin_update_own_profile(text, text, text, text) from public;
revoke execute on function public.admin_change_own_pin(text, text, text)          from public;
grant  execute on function public.admin_get_own_profile(text)                     to anon, authenticated;
grant  execute on function public.admin_update_own_profile(text, text, text, text) to anon, authenticated;
grant  execute on function public.admin_change_own_pin(text, text, text)          to anon, authenticated;
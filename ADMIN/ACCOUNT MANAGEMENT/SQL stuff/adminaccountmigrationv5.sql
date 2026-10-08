-- ============================================================
-- TapMate v5 migration. Run AFTER v4 + v4 fix. Safe to re-run.
-- Supabase > SQL Editor > New query.
--
-- Adds: guardians (students), "unarchive" admin action, and server-side
-- input rules (names = letters/single spaces, RFID = digits, guardian rules).
-- Rules are checked only when the field is inserted or changed, so existing
-- rows with older data can still be archived / unlinked / PIN-reset.
-- ============================================================

-- 1) Guardians: up to 3 per student, stored as [{name, method: 'email'|'sms', contact}]
alter table public.accounts add column if not exists guardians jsonb not null default '[]'::jsonb;

alter table public.accounts drop constraint if exists accounts_guardians_check;
alter table public.accounts add  constraint accounts_guardians_check
    check (jsonb_typeof(guardians) = 'array' and jsonb_array_length(guardians) <= 3);

-- login.sql grants SELECT per column, so the new column must be granted too
grant select (guardians) on public.accounts to anon, authenticated;

-- 2) Input rules
create or replace function public._bad_name(p text)
returns boolean language sql immutable as $$
    -- digits, ASCII symbols/quotes, leading/trailing/double spaces, tabs/newlines
    select p ~ '[0-9!-/:-@\[-`{-~]' or p ~ '^ | $|  ' or p ~ '[\t\n\r]'
$$;

create or replace function public.accounts_validate_input()
returns trigger language plpgsql as $$
declare g jsonb;
begin
    if tg_op = 'INSERT'
       or new.first_name  is distinct from old.first_name
       or new.middle_name is distinct from old.middle_name
       or new.last_name   is distinct from old.last_name then
        if public._bad_name(new.first_name) or public._bad_name(new.last_name)
           or (new.middle_name is not null and public._bad_name(new.middle_name)) then
            raise exception 'Names can only contain letters and single spaces.' using errcode = '23514';
        end if;
    end if;

    if (tg_op = 'INSERT' or new.rfid_uid is distinct from old.rfid_uid)
       and new.rfid_uid is not null and new.rfid_uid !~ '^[0-9]+$' then
        raise exception 'RFID numbers can only contain digits.' using errcode = '23514';
    end if;

    if tg_op = 'INSERT' or new.guardians is distinct from old.guardians then
        for g in select * from jsonb_array_elements(new.guardians) loop
            if public._bad_name(coalesce(g->>'name', ''))
               or btrim(coalesce(g->>'name', '')) = ''
               or coalesce(g->>'method', '') not in ('email', 'sms')
               or btrim(coalesce(g->>'contact', '')) = ''
               or (g->>'method' = 'sms' and g->>'contact' !~ '^09[0-9]{9}$') then
                raise exception 'Guardian details are not valid.' using errcode = '23514';
            end if;
        end loop;
    end if;
    return new;
end $$;

drop trigger if exists accounts_validate_input on public.accounts;
create trigger accounts_validate_input
    before insert or update on public.accounts
    for each row execute function public.accounts_validate_input();

-- 3) Unarchive: account becomes active again (its RFID was freed when archived)
create or replace function public.admin_unarchive_account(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts;
begin
    select * into a from public.accounts where id = p_id for update;
    if not found then raise exception 'Account not found.'; end if;
    if a.status <> 'archived' then raise exception 'This account is not archived.'; end if;
    update public.accounts set status = 'active' where id = p_id;
    perform public._admin_audit(actor, 'account_unarchived', a, '{}'::jsonb);
end $$;

revoke execute on function public.admin_unarchive_account(text, uuid) from public;
grant  execute on function public.admin_unarchive_account(text, uuid) to anon, authenticated;
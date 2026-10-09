-- ============================================================
-- TapMate: let parents use any valid email (accounts_email_check blocked it).
-- Run in Supabase > SQL Editor. Safe to re-run.
--
-- Reads your existing accounts_email_check rule and rewrites it as:
--     role = 'parent'  OR  ( <your original rule, unchanged> )
-- so students / faculty / admin / cashier are checked exactly as before,
-- and parents are only required to give a normal-looking email (or none).
-- ============================================================
do $$
declare d text; body text;
begin
    select pg_get_constraintdef(oid) into d
      from pg_constraint
     where conrelid = 'public.accounts'::regclass and conname = 'accounts_email_check';

    if d is null then
        raise notice 'No accounts_email_check found - nothing to change.';
    elsif d ilike '%role%parent%' or d ilike '%parent%' then
        raise notice 'accounts_email_check already mentions parent: %', d;
    else
        raise notice 'Original rule: %', d;
        body := regexp_replace(substr(d, 7), '\s+NOT VALID\s*$', '', 'i');   -- drop the leading "CHECK "
        execute 'alter table public.accounts drop constraint accounts_email_check';
        execute 'alter table public.accounts add constraint accounts_email_check check ('
             || '(role = ''parent'' and (email is null or email ~* ''^[^@\s]+@[^@\s]+\.[^@\s]+$'')) or role <> ''parent'' and '
             || body || ')';
        raise notice 'Rewrote accounts_email_check so parents may use any valid email.';
    end if;
end $$;

-- Every rule on accounts afterwards (send me this if sign-up still fails)
select conname, pg_get_constraintdef(oid) as rule
from pg_constraint
where conrelid = 'public.accounts'::regclass
order by conname;
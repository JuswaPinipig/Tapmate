-- ============================================================
-- TapMate: let parent accounts exist in public.accounts.
-- Run AFTER PARENT_SIGN_UP_v2.sql, in Supabase > SQL Editor. Safe to re-run.
--
--  1. email was NOT NULL, but a parent can sign up with a mobile number only.
--  2. make sure the role rule (if any) allows 'parent'.
-- ============================================================

-- 1) email is optional for parents. A unique index still blocks duplicates
--    (NULLs don't count as duplicates).
alter table public.accounts alter column email drop not null;

-- 2) role rule: replace any SIMPLE "role in (...)" check that lacks 'parent'.
--    (Checks that also mention other columns are left alone and reported.)
do $$
declare c record; replaced boolean := false;
begin
    for c in
        select conname, pg_get_constraintdef(oid) as def
          from pg_constraint
         where conrelid = 'public.accounts'::regclass and contype = 'c'
           and pg_get_constraintdef(oid) ilike '%role%'
    loop
        if c.def ilike '%parent%' then
            raise notice 'Role rule "%" already allows parent.', c.conname;
        elsif c.def ~* '^CHECK \(\(?role\)?(::text)? (= ANY|IN)' and c.def !~* '(student_id|employee_id|email|status)' then
            execute format('alter table public.accounts drop constraint %I', c.conname);
            replaced := true;
            raise notice 'Dropped role rule "%": %', c.conname, c.def;
        else
            raise notice 'LEFT ALONE (mixed rule, check it by hand): "%": %', c.conname, c.def;
        end if;
    end loop;

    if replaced then
        alter table public.accounts add constraint accounts_role_check
            check (role in ('student', 'faculty', 'admin', 'cashier', 'parent'));
        raise notice 'Added accounts_role_check allowing student, faculty, admin, cashier, parent.';
    end if;
end $$;

-- See every rule on accounts afterwards (to send me if sign-up still fails)
select conname, pg_get_constraintdef(oid) as rule
from pg_constraint
where conrelid = 'public.accounts'::regclass
order by conname;
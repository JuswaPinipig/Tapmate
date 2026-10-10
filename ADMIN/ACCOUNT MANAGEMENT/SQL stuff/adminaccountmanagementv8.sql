-- ============================================================
-- TapMate v8 migration. Run AFTER v7, studentwallet2.sql and parentoverview.sql.
-- Safe to re-run.  Supabase > SQL Editor > New query.
--
-- Parent accounts (admin):
--   * list parent accounts with their linked student
--   * edit a parent's email
--   * link / unlink a parent <-> student (uses public.parent_student_links)
-- Every change is written to the audit log through _admin_audit, like the other admin actions.
-- NOTE: if your audit table restricts the allowed action names with a CHECK constraint,
--       add: parent_email_updated, parent_linked, parent_unlinked.
-- ============================================================

-- 1. Parent accounts + their linked student ----------------------
create or replace function public.admin_parent_list(
    p_token text, p_search text default '', p_archived boolean default false,
    p_limit int default 5, p_offset int default 0)
returns table (
    id uuid, role text, status text, first_name text, middle_name text, last_name text,
    suffix text, full_name text, email text, phone text,
    student_uuid uuid, student_id text, student_name text, pending_student_name text,
    total_count bigint)
language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token);
begin
    return query
    with base as (
        select a.id, a.status, a.first_name, a.middle_name, a.last_name, a.email, a.phone,
               coalesce(nullif(btrim(a.full_name), ''), btrim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,''))) as fname,
               s.id as sid, s.student_id as sno,
               coalesce(nullif(btrim(s.full_name), ''), btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,''))) as sname,
               coalesce(nullif(btrim(ps.full_name), ''), btrim(coalesce(ps.first_name,'') || ' ' || coalesce(ps.last_name,''))) as pname,
               a.created_at
          from public.accounts a
          left join public.parent_student_links l on l.parent_id = a.id
          left join public.accounts s on s.id = l.student_id
          left join public.parent_pending_links pp on pp.parent_id = a.id
          left join public.accounts ps on ps.id = pp.student_id
         where a.role = 'parent'
           and ((p_archived and a.status = 'archived') or (not p_archived and a.status <> 'archived'))
           and (coalesce(p_search, '') = ''
                or a.first_name ilike '%' || p_search || '%' or a.last_name ilike '%' || p_search || '%'
                or (coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')) ilike '%' || p_search || '%'
                or a.email ilike '%' || p_search || '%' or a.phone ilike '%' || p_search || '%'
                or s.student_id ilike '%' || p_search || '%' or s.full_name ilike '%' || p_search || '%')
    )
    select b.id, 'parent'::text, b.status, b.first_name, b.middle_name, b.last_name,
           null::text, b.fname, b.email, b.phone,
           b.sid, b.sno, nullif(b.sname, ''), nullif(b.pname, ''),
           count(*) over () as total_count
      from base b
     order by case when coalesce(p_search, '') = '' then null else b.fname end asc,
              b.created_at desc
     limit greatest(p_limit, 1) offset greatest(p_offset, 0);
end $$;

-- 2. One parent, with the linked (or waiting) student -------------
create or replace function public.admin_get_parent(p_token text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; s public.accounts; ps public.accounts;
begin
    select * into a from public.accounts where id = p_id and role = 'parent';
    if not found then raise exception 'Parent account not found.'; end if;
    select x.* into s from public.accounts x join public.parent_student_links l on l.student_id = x.id where l.parent_id = a.id limit 1;
    select x.* into ps from public.accounts x join public.parent_pending_links l on l.student_id = x.id where l.parent_id = a.id limit 1;
    return jsonb_build_object(
        'id', a.id, 'status', a.status, 'first_name', a.first_name, 'last_name', a.last_name,
        'full_name', coalesce(nullif(btrim(a.full_name), ''), btrim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,''))),
        'email', a.email, 'phone', a.phone,
        'student', case when s.id is null then null else jsonb_build_object(
            'id', s.id, 'student_id', s.student_id,
            'full_name', coalesce(nullif(btrim(s.full_name), ''), btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')))) end,
        'pending', case when ps.id is null then null else jsonb_build_object(
            'id', ps.id, 'student_id', ps.student_id,
            'full_name', coalesce(nullif(btrim(ps.full_name), ''), btrim(coalesce(ps.first_name,'') || ' ' || coalesce(ps.last_name,'')))) end);
end $$;

-- 3. Change a parent's email --------------------------------------
create or replace function public.admin_update_parent_email(p_token text, p_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; v text := lower(btrim(coalesce(p_email, '')));
        v_old text;
begin
    select * into a from public.accounts where id = p_id and role = 'parent' for update;
    if not found then raise exception 'Parent account not found.'; end if;
    if v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address.'; end if;
    if exists (select 1 from public.accounts x where lower(x.email) = v and x.id <> a.id) then
        raise exception 'That email is already used by another account.';
    end if;
    v_old := a.email;
    update public.accounts set email = v where id = a.id;
    perform public._admin_audit(actor, 'parent_email_updated', a, jsonb_build_object('from', v_old, 'to', v));
    return jsonb_build_object('email', v);
end $$;

-- 4. Find students to link (shows who already has a parent) --------
create or replace function public.admin_search_students_for_link(p_token text, p_term text)
returns table (id uuid, student_id text, full_name text, suffix text, linked boolean, parent_name text)
language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token);
begin
    if btrim(coalesce(p_term, '')) = '' then return; end if;
    return query
    select s.id, s.student_id, s.full_name, s.suffix, (l.parent_id is not null),
           nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), '')
      from public.accounts s
      left join public.parent_student_links l on l.student_id = s.id
      left join public.accounts p on p.id = l.parent_id
     where s.role = 'student' and s.status <> 'archived'
       and (s.full_name ilike '%' || btrim(p_term) || '%' or s.student_id ilike '%' || btrim(p_term) || '%')
     order by s.full_name asc limit 6;
end $$;

-- 5. Link a parent to a student -----------------------------------
create or replace function public.admin_link_parent(p_token text, p_parent_id uuid, p_student_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; s public.accounts;
begin
    select * into a from public.accounts where id = p_parent_id and role = 'parent' and status = 'active' for update;
    if not found then raise exception 'Parent account not found or not active.'; end if;
    select * into s from public.accounts where id = p_student_id and role = 'student' and status <> 'archived' for update;
    if not found then raise exception 'Student account not found.'; end if;
    if exists (select 1 from public.parent_student_links where parent_id = a.id) then
        raise exception 'This parent is already linked to a student. Unlink them first.';
    end if;
    if exists (select 1 from public.parent_student_links where student_id = s.id) then
        raise exception 'This student already has a linked parent.';
    end if;
    delete from public.parent_pending_links where parent_id = a.id or student_id = s.id;
    insert into public.parent_student_links (parent_id, student_id) values (a.id, s.id);
    perform public._admin_audit(actor, 'parent_linked', a,
        jsonb_build_object('student_id', s.student_id, 'student_name', s.full_name));
end $$;

-- 6. Unlink -------------------------------------------------------
--    Blocked while the student owes Pay Later money. Otherwise Pay Later is switched off,
--    because it needs a linked parent.
create or replace function public.admin_unlink_parent(p_token text, p_parent_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare actor jsonb := public._admin_actor(p_token); a public.accounts; s public.accounts; v_sid uuid;
begin
    select * into a from public.accounts where id = p_parent_id and role = 'parent' for update;
    if not found then raise exception 'Parent account not found.'; end if;
    select student_id into v_sid from public.parent_student_links where parent_id = a.id;
    if v_sid is null then raise exception 'This parent isn''t linked to a student.'; end if;
    select * into s from public.accounts where id = v_sid for update;
    if coalesce(s.pay_later_outstanding, 0) > 0 then
        raise exception 'Can''t unlink: % still has an unpaid Pay Later balance of PHP %. It must be settled first.',
            s.full_name, to_char(s.pay_later_outstanding, 'FM999,999,990.00');
    end if;
    delete from public.parent_student_links where parent_id = a.id;
    update public.accounts set pay_later_enabled = false where id = s.id;
    update public.pay_later_requests set status = 'denied', decided_at = now()
     where account_id = s.id and status = 'pending';
    perform public._admin_audit(actor, 'parent_unlinked', a,
        jsonb_build_object('student_id', s.student_id, 'student_name', s.full_name));
end $$;

-- 7. Permissions --------------------------------------------------
revoke execute on function public.admin_parent_list(text, text, boolean, int, int),
    public.admin_get_parent(text, uuid), public.admin_update_parent_email(text, uuid, text),
    public.admin_search_students_for_link(text, text), public.admin_link_parent(text, uuid, uuid),
    public.admin_unlink_parent(text, uuid) from public;
grant execute on function public.admin_parent_list(text, text, boolean, int, int),
    public.admin_get_parent(text, uuid), public.admin_update_parent_email(text, uuid, text),
    public.admin_search_students_for_link(text, text), public.admin_link_parent(text, uuid, uuid),
    public.admin_unlink_parent(text, uuid) to anon, authenticated;
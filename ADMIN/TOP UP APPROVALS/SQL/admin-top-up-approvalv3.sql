-- ============================================================
-- Admin top-up approval  (safe to re-run)
-- Run AFTER student-top-up.sql, v2 and student-top-upv3.sql.   (v3 of this file: adds the missing approved_by_name column)
--
-- ASSUMPTIONS (change here if your tables differ):
--   * topup_requests has: id, student_id, method, amount, reference_no,
--     proof_path, status ('pending' | 'approved' | 'rejected'),
--     created_at, approved_by_name        (the student page already reads these)
--   * accounts has: student_id, full_name, role, balance
--   * card_session(p_token) returns json(b) with a "role" key
--   * admin_get_own_profile(p_token) returns first_name / middle_name / last_name
-- ============================================================

-- 1. extra columns for the review
-- who reviewed it (shown to the student as "Approved by ..."). Your table did not have this column yet.
alter table topup_requests add column if not exists approved_by_name text;
alter table topup_requests add column if not exists decline_reason text;
alter table topup_requests add column if not exists reviewed_at    timestamptz;
-- advisory note from the receipt reader (written only by the check-topup-receipt Edge Function; it never changes status)
alter table topup_requests add column if not exists ai_check       jsonb;

-- 2. who is calling? returns the admin's display name, or null if the token is not an admin's
create or replace function tapmate_topup_admin(p_token text) returns text
language plpgsql security definer set search_path = public as $$
declare s jsonb; p jsonb;
begin
  if p_token is null or p_token = '' then return null; end if;
  s := to_jsonb(card_session(p_token));
  if s is null or s->>'role' is distinct from 'admin' then return null; end if;
  p := to_jsonb(admin_get_own_profile(p_token));
  return coalesce(nullif(trim(concat_ws(' ', p->>'first_name', p->>'middle_name', p->>'last_name')), ''), 'Admin');
end $$;

-- 3. list (tab = pending / approved / rejected), with search + paging + tab counts
create or replace function admin_topup_list(p_token text, p_status text default 'pending', p_search text default '', p_limit int default 10, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q text := '%' || replace(replace(replace(coalesce(trim(p_search), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
        total int; rows jsonb; counts jsonb;
begin
  if tapmate_topup_admin(p_token) is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  if p_status not in ('pending', 'approved', 'rejected') then p_status := 'pending'; end if;

  select count(*) into total
    from topup_requests t left join accounts a on a.student_id = t.student_id
   where t.status = p_status and (t.student_id ilike q or coalesce(a.full_name, '') ilike q or t.reference_no ilike q);

  select coalesce(jsonb_agg(x order by (x->>'created_at') desc), '[]'::jsonb) into rows from (
    select jsonb_build_object('id', t.id, 'student_id', t.student_id, 'full_name', a.full_name,
                              'amount', t.amount, 'created_at', t.created_at, 'status', t.status) as x
      from topup_requests t left join accounts a on a.student_id = t.student_id
     where t.status = p_status and (t.student_id ilike q or coalesce(a.full_name, '') ilike q or t.reference_no ilike q)
     order by case when p_status = 'pending' then t.created_at end asc, t.created_at desc   -- pending: oldest first
     limit greatest(p_limit, 1) offset greatest(p_offset, 0)
  ) s;

  select jsonb_build_object('pending',  count(*) filter (where status = 'pending'),
                            'approved', count(*) filter (where status = 'approved'),
                            'rejected', count(*) filter (where status = 'rejected')) into counts from topup_requests;

  return jsonb_build_object('ok', true, 'total', total, 'rows', rows, 'counts', counts);
end $$;

-- 4. one request in full (adds reference number + receipt path)
create or replace function admin_topup_detail(p_token text, p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if tapmate_topup_admin(p_token) is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  select jsonb_build_object('id', t.id, 'student_id', t.student_id, 'full_name', a.full_name, 'amount', t.amount,
                            'created_at', t.created_at, 'reference_no', t.reference_no, 'method', t.method,
                            'proof_path', t.proof_path, 'status', t.status, 'decline_reason', t.decline_reason,
                            'approved_by_name', t.approved_by_name, 'reviewed_at', t.reviewed_at,
                            'ai_check', t.ai_check)
    into r from topup_requests t left join accounts a on a.student_id = t.student_id where t.id::text = p_id;
  if r is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'request', r);
end $$;

-- 5. approve (adds the amount to the wallet) or decline (reason required)
--    Row is locked, so two admins can't review the same request twice.
create or replace function admin_topup_review(p_token text, p_id text, p_action text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare who text := tapmate_topup_admin(p_token); t topup_requests; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if who is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  if p_action not in ('approve', 'decline') then return jsonb_build_object('ok', false, 'reason', 'action'); end if;
  if p_action = 'decline' and why is null then return jsonb_build_object('ok', false, 'reason', 'reason_required'); end if;

  select * into t from topup_requests where id::text = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if t.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_reviewed', 'status', t.status); end if;

  if p_action = 'approve' then
    update accounts set balance = balance + t.amount where student_id = t.student_id and role = 'student';
    if not found then return jsonb_build_object('ok', false, 'reason', 'no_account'); end if;
    update topup_requests set status = 'approved', approved_by_name = who, reviewed_at = now() where id = t.id;
  else
    update topup_requests set status = 'rejected', approved_by_name = who, reviewed_at = now(), decline_reason = left(why, 300) where id = t.id;
  end if;

  -- OPTIONAL: write to your audit log here (table/columns not visible to me), e.g.
  -- insert into audit_logs (...) values (...);
  return jsonb_build_object('ok', true, 'status', case when p_action = 'approve' then 'approved' else 'rejected' end);
end $$;

-- 6. let admins (and only admins) open the receipt images in the private bucket.
--    The admin pages send the session token in the x-card-token header, so the policy checks that.
create or replace function tapmate_header_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select tapmate_topup_admin(current_setting('request.headers', true)::json->>'x-card-token') is not null
$$;

drop policy if exists "topup proofs admin read" on storage.objects;
create policy "topup proofs admin read" on storage.objects for select to anon, authenticated
  using (bucket_id = 'topup-proofs' and tapmate_header_is_admin());

-- 7. students can now see WHY a top-up was declined (replaces the v3 function, adds decline_reason)
create or replace function student_topup_history(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sid text := tapmate_student_from_token(p_token); n int := (select history_limit from topup_settings);
begin
  if sid is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'status', status, 'created_at', created_at,
                                                       'approved_by_name', approved_by_name, 'decline_reason', decline_reason) order by created_at desc)
                   from (select * from topup_requests where student_id = sid order by created_at desc limit n) t), '[]'::jsonb);
end $$;

grant execute on function admin_topup_list(text, text, text, int, int) to anon, authenticated;
grant execute on function admin_topup_detail(text, text) to anon, authenticated;
grant execute on function admin_topup_review(text, text, text, text) to anon, authenticated;
grant execute on function tapmate_header_is_admin() to anon, authenticated;
grant execute on function student_topup_history(text) to anon, authenticated;
-- internal helper only. "from public" is needed too: functions are executable by PUBLIC by default,
-- so revoking from anon/authenticated alone would not close it. (Other functions call it as security definer, so they still work.)
revoke execute on function tapmate_topup_admin(text) from public, anon, authenticated;
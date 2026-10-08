-- ============================================================
-- Student top-up AI assist: gate for the read-topup-receipt Edge Function  (safe to re-run)
-- Run AFTER student-top-upv3.sql and admin-top-up-approvalv3.sql.
--
-- Why this exists: the receipt reader costs money on every call (OpenRouter), and it is callable from a
-- student's browser. This one function (a) checks the student's session token and (b) caps how many
-- reads one student can trigger per hour, so nobody can run up the bill by uploading images in a loop.
--
-- ASSUMPTION: tapmate_student_from_token(p_token) returns the student_id (text) or null. Your
-- student_topup_history function already relies on it.
-- ============================================================

create table if not exists topup_receipt_reads (
  id         bigint generated always as identity primary key,
  student_id text        not null,
  created_at timestamptz not null default now()
);
create index if not exists topup_receipt_reads_student_idx on topup_receipt_reads (student_id, created_at desc);

-- RLS on with NO policies = browsers can't read or write this table. Only the function below touches it.
alter table topup_receipt_reads enable row level security;

create or replace function tapmate_receipt_read_gate(p_token text, p_limit int default 10, p_window interval default '1 hour')
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid text; n int;
begin
  sid := tapmate_student_from_token(p_token);
  if sid is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

  select count(*) into n from topup_receipt_reads where student_id = sid and created_at > now() - p_window;
  if n >= p_limit then return jsonb_build_object('ok', false, 'reason', 'limit'); end if;

  insert into topup_receipt_reads (student_id) values (sid);
  delete from topup_receipt_reads where created_at < now() - interval '2 days';   -- housekeeping
  return jsonb_build_object('ok', true, 'student_id', sid);
end $$;

-- Only the Edge Function (service role) may call it. "from public" is needed too, because functions
-- are executable by PUBLIC by default.
revoke execute on function tapmate_receipt_read_gate(text, int, interval) from public, anon, authenticated;
grant  execute on function tapmate_receipt_read_gate(text, int, interval) to service_role;
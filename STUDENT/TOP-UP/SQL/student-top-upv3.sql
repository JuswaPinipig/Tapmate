-- Run after student-top-up.sql and v2 (safe to re-run). Moves every top-up rule into one editable table.
create table if not exists topup_settings (
  id           boolean primary key default true check (id),   -- single row
  amounts      numeric[] not null,
  ref_length   int  not null check (ref_length > 0),
  max_file_mb  int  not null check (max_file_mb > 0),
  max_pending  int  not null check (max_pending > 0),
  history_limit int not null check (history_limit > 0)
);
alter table topup_settings enable row level security;          -- no policies: read through the functions below, edit in the Table Editor
insert into topup_settings (amounts, ref_length, max_file_mb, max_pending, history_limit)
values ('{150,250,500,1000}', 13, 5, 3, 20) on conflict (id) do nothing;   -- starting values only; change the row, not the code

alter table topup_requests drop constraint if exists topup_requests_reference_no_check;   -- length now comes from topup_settings

-- keep the storage bucket's size cap in step with the setting (re-run this line after changing max_file_mb)
update storage.buckets set file_size_limit = (select max_file_mb from topup_settings) * 1048576 where id = 'topup-proofs';

create or replace function student_topup_settings() returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('amounts', amounts, 'ref_length', ref_length, 'max_file_mb', max_file_mb, 'max_pending', max_pending) from topup_settings
$$;

create or replace function student_submit_topup(p_token text, p_method text, p_amount numeric, p_reference text, p_proof_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid text := tapmate_student_from_token(p_token); st topup_settings;
begin
  select * into st from topup_settings;
  if sid is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  if p_method <> 'gcash' or p_reference !~ ('^[0-9]{' || st.ref_length || '}$') or p_proof_path !~ '^[0-9a-f-]{8,}\.(jpg|png)$' then return jsonb_build_object('ok', false, 'reason', 'format'); end if;
  if not (p_amount = any (st.amounts)) then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;
  if (select count(*) from topup_requests where student_id = sid and status = 'pending') >= st.max_pending then return jsonb_build_object('ok', false, 'reason', 'pending_limit'); end if;
  insert into topup_requests (student_id, method, amount, reference_no, proof_path) values (sid, 'gcash', p_amount, p_reference, p_proof_path);
  return jsonb_build_object('ok', true);
exception when unique_violation then return jsonb_build_object('ok', false, 'reason', 'duplicate');
end $$;

create or replace function student_topup_history(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sid text := tapmate_student_from_token(p_token); n int := (select history_limit from topup_settings);
begin
  if sid is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('amount', amount, 'status', status, 'created_at', created_at, 'approved_by_name', approved_by_name) order by created_at desc)
                   from (select * from topup_requests where student_id = sid order by created_at desc limit n) t), '[]'::jsonb);
end $$;

grant execute on function student_topup_settings() to anon, authenticated;
grant execute on function student_submit_topup(text, text, numeric, text, text) to anon, authenticated;
grant execute on function student_topup_history(text) to anon, authenticated;
-- TapMate: student top-up requests (run in the Supabase SQL editor).
-- Needs tapmate_student_from_token() from parent_link.sql (it resolves the session token to the Student ID).

create table if not exists topup_requests (
  id           bigint generated always as identity primary key,
  student_id   text not null,
  method       text not null check (method in ('gcash','bank')),
  amount       numeric(10,2) not null check (amount > 0),
  reference_no text not null check (reference_no ~ '^[0-9]{13}$'),   -- strictly 13 digits
  proof_path   text not null,                                         -- file in the private 'topup-proofs' bucket
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at   timestamptz not null default now(),
  unique (reference_no)                                               -- a reference number can only be used once
);
alter table topup_requests enable row level security;                 -- no policies: only the function below and admins

-- Private bucket: JPG/PNG only, 5 MB max (enforced by Storage itself, not just the page)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('topup-proofs', 'topup-proofs', false, 5242880, array['image/jpeg','image/png'])
on conflict (id) do update set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg','image/png'];

-- Students (anon key) may only add files; they can't list, read, change or delete any
drop policy if exists "topup proofs insert" on storage.objects;
create policy "topup proofs insert" on storage.objects for insert to anon with check (bucket_id = 'topup-proofs');

create or replace function student_submit_topup(p_token text, p_method text, p_amount numeric, p_reference text, p_proof_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare sid text := tapmate_student_from_token(p_token);
begin
  if sid is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
  if p_method not in ('gcash','bank') or p_proof_path !~ '^[0-9a-f-]{8,}\.(jpg|png)$' then return jsonb_build_object('ok', false, 'reason', 'format'); end if;
  if p_reference !~ '^[0-9]{13}$' then return jsonb_build_object('ok', false, 'reason', 'format'); end if;
  if p_amount < 50 or p_amount > 10000 then return jsonb_build_object('ok', false, 'reason', 'amount'); end if;   -- keep in sync with config.js
  if (select count(*) from topup_requests where student_id = sid and status = 'pending') >= 3 then return jsonb_build_object('ok', false, 'reason', 'pending_limit'); end if;
  insert into topup_requests (student_id, method, amount, reference_no, proof_path) values (sid, p_method, p_amount, p_reference, p_proof_path);
  return jsonb_build_object('ok', true);
exception when unique_violation then return jsonb_build_object('ok', false, 'reason', 'duplicate');
end $$;
grant execute on function student_submit_topup(text, text, numeric, text, text) to anon, authenticated;
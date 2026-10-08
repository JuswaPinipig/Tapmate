-- TapMate: parent linking (run in the Supabase SQL editor)
-- ASSUMPTION: your existing RPCs resolve a card-session token to a student somehow.
-- Replace tapmate_student_from_token() below with whatever student_portal /
-- student_change_pin already use, and match the students table / id type.

create extension if not exists pgcrypto;

create table if not exists parent_link_codes (
  id          bigint generated always as identity primary key,
  student_id  uuid not null,                       -- match your students id type
  code        text not null,                       -- 6 digits
  qr_token    text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index if not exists parent_link_codes_code_idx on parent_link_codes (code) where used_at is null;

create table if not exists student_parents (
  student_id uuid not null,
  parent_id  uuid not null,                        -- the parent's auth user id
  linked_at  timestamptz not null default now(),
  primary key (student_id, parent_id)
);

alter table parent_link_codes enable row level security;
alter table student_parents  enable row level security;   -- no policies: only the functions below touch them

-- Resolves the student through your EXISTING student_portal(p_token), so no session table is needed.
-- Assumes student_portal's JSON has profile.id. If your key is different (e.g. profile.student_uuid), change it here.
-- Returns NULL if the token is invalid/expired.
create or replace function tapmate_student_from_token(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  d := student_portal(p_token);
  if d is null then return null; end if;
  return nullif(d->'profile'->>'id', '')::uuid;
end $$;

-- Student: make a fresh code (QR token + 6 digits), valid 5 minutes
create or replace function student_create_parent_link(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sid uuid := tapmate_student_from_token(p_token); c text; t text; exp timestamptz := now() + interval '5 minutes';
begin
  if sid is null then return jsonb_build_object('ok', false, 'reason', 'no_student'); end if;
  if exists (select 1 from student_parents where student_id = sid) then
    return jsonb_build_object('ok', false, 'reason', 'linked');
  end if;
  update parent_link_codes set used_at = now() where student_id = sid and used_at is null;  -- old codes die
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from parent_link_codes where code = c and used_at is null and expires_at > now());
  end loop;
  t := encode(gen_random_bytes(18), 'hex');
  insert into parent_link_codes (student_id, code, qr_token, expires_at) values (sid, c, t, exp);
  return jsonb_build_object('ok', true, 'code', c, 'qr_token', t, 'expires_at', exp);
end $$;

-- Parent: redeem by QR token OR 6-digit code (call from the parent page, parent signed in)
create or replace function parent_redeem_link(p_code text default null, p_qr_token text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r parent_link_codes; pid uuid := auth.uid();
begin
  if pid is null then return jsonb_build_object('ok', false, 'reason', 'auth'); end if;
  select * into r from parent_link_codes
   where used_at is null and expires_at > now()
     and ((p_qr_token is not null and qr_token = p_qr_token) or (p_code is not null and code = p_code))
   order by id desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_or_expired'); end if;
  update parent_link_codes set used_at = now() where id = r.id;
  insert into student_parents (student_id, parent_id) values (r.student_id, pid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;
-- NOTE: a 6-digit code is guessable; add attempt rate-limiting per parent before going live.

grant execute on function student_create_parent_link(text) to anon, authenticated;
grant execute on function parent_redeem_link(text, text)   to authenticated;

-- ---- PATCH 1: student_portal must return parent_link, e.g. add to its jsonb:
--   'parent_link', (select jsonb_build_object('linked', true, 'linked_at', sp.linked_at)
--                   from student_parents sp where sp.student_id = <current student> limit 1)
--   -- if no row: return jsonb_build_object('linked', false)
--   -- (optionally add 'parent_name' from your parents/profile table)

-- ---- PATCH 2: enforce the lock server-side. At the top of student_activate_pay_later:
--   if not exists (select 1 from student_parents where student_id = <current student>) then
--     return jsonb_build_object('ok', false, 'reason', 'no_parent');
--   end if;
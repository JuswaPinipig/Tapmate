-- TapMate: phone link + order tally on the phone.
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run. (Safe to run again.)

create table if not exists public.kiosk_phone_links (
  code         text primary key,
  created_at   timestamptz not null default now(),
  connected_at timestamptz
);
alter table public.kiosk_phone_links add column if not exists student         text;
alter table public.kiosk_phone_links add column if not exists currency        text;
alter table public.kiosk_phone_links add column if not exists items           jsonb   not null default '[]'::jsonb;
alter table public.kiosk_phone_links add column if not exists total           numeric not null default 0;
alter table public.kiosk_phone_links add column if not exists remove_requests jsonb   not null default '[]'::jsonb;
alter table public.kiosk_phone_links add column if not exists updated_at      timestamptz;

-- Nobody can read or write the table directly; only the functions below can.
alter table public.kiosk_phone_links enable row level security;

-- ---------- kiosk side ----------
create or replace function public.kiosk_phone_open(p_code text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_code is null or length(p_code) < 16 then return jsonb_build_object('ok', false); end if;
  delete from kiosk_phone_links where created_at < now() - interval '2 hours';
  insert into kiosk_phone_links(code) values (p_code) on conflict (code) do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kiosk_phone_status(p_code text, p_token text default null)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'exists',    exists (select 1 from kiosk_phone_links where code = p_code),
    'connected', exists (select 1 from kiosk_phone_links where code = p_code and connected_at is not null));
$$;

-- the kiosk sends the current order (names, quantities, prices) so the phone can show it
create or replace function public.kiosk_phone_push(p_code text, p_student text, p_currency text, p_items jsonb, p_total numeric, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update kiosk_phone_links
     set student = p_student, currency = p_currency, items = coalesce(p_items, '[]'::jsonb),
         total = coalesce(p_total, 0), updated_at = now()
   where code = p_code;
  return jsonb_build_object('ok', found);
end $$;

-- the kiosk collects (and clears) the "remove" requests the student made on the phone
create or replace function public.kiosk_phone_take_removals(p_code text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  select remove_requests into r from kiosk_phone_links where code = p_code for update;
  if r is null then return '[]'::jsonb; end if;
  update kiosk_phone_links set remove_requests = '[]'::jsonb where code = p_code;
  return r;
end $$;

create or replace function public.kiosk_phone_close(p_code text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  delete from kiosk_phone_links where code = p_code;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- phone side ----------
create or replace function public.kiosk_phone_connect(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update kiosk_phone_links set connected_at = coalesce(connected_at, now())
   where code = p_code and created_at > now() - interval '2 hours';
  return jsonb_build_object('ok', found);
end $$;

-- what the phone shows: the order tally
create or replace function public.kiosk_phone_view(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r kiosk_phone_links%rowtype;
begin
  select * into r from kiosk_phone_links where code = p_code and created_at > now() - interval '2 hours';
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'student', coalesce(r.student, ''), 'currency', coalesce(r.currency, ''),
                            'items', r.items, 'total', r.total, 'ready', r.updated_at is not null);
end $$;

-- the student removes an item (one unit, or all of it) from the phone
create or replace function public.kiosk_phone_remove(p_code text, p_pid text, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  update kiosk_phone_links
     set remove_requests = remove_requests || jsonb_build_array(jsonb_build_object('pid', p_pid, 'all', coalesce(p_all, false)))
   where code = p_code and created_at > now() - interval '2 hours' and jsonb_array_length(remove_requests) < 50;
  return jsonb_build_object('ok', found);
end $$;

grant execute on function public.kiosk_phone_open(text, text)                              to anon, authenticated;
grant execute on function public.kiosk_phone_status(text, text)                            to anon, authenticated;
grant execute on function public.kiosk_phone_push(text, text, text, jsonb, numeric, text) to anon, authenticated;
grant execute on function public.kiosk_phone_take_removals(text, text)                     to anon, authenticated;
grant execute on function public.kiosk_phone_close(text, text)                             to anon, authenticated;
grant execute on function public.kiosk_phone_connect(text)                                 to anon, authenticated;
grant execute on function public.kiosk_phone_view(text)                                    to anon, authenticated;
grant execute on function public.kiosk_phone_remove(text, text, boolean)                   to anon, authenticated;

notify pgrst, 'reload schema';
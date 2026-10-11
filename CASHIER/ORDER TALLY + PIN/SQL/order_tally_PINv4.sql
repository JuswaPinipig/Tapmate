-- TapMate: every PIN request gets its own number ("req"), so the phone can tell "the PIN screen I just cancelled"
-- from "a new PIN request" and never reopens a cancelled one. Run AFTER order_tally_PINv3.sql. Safe to re-run.
-- Replaces kiosk_phone_set_phase and kiosk_phone_get_phase (same names and arguments as before).

alter table public.kiosk_phone_pay add column if not exists req int not null default 0;

create or replace function public.kiosk_phone_set_phase(p_code text, p_phase text, p_total numeric default 0, p_pin_len int default 4)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_phase not in ('browse','pin') then return jsonb_build_object('ok', false); end if;
  delete from kiosk_phone_pay where updated_at < now() - interval '1 day';
  insert into kiosk_phone_pay(code, phase, total, pin_len, pin, cancel, result, req, updated_at)
  values (p_code, p_phase, coalesce(p_total,0), coalesce(p_pin_len,4), null, false, null,
          case when p_phase = 'pin' then 1 else 0 end, now())
  on conflict (code) do update set
    phase = excluded.phase, total = excluded.total, pin_len = excluded.pin_len, pin = null, cancel = false,
    result = case when excluded.phase = 'pin' then null else kiosk_phone_pay.result end,
    req = case when excluded.phase = 'pin' then kiosk_phone_pay.req + 1 else kiosk_phone_pay.req end,
    updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kiosk_phone_get_phase(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r kiosk_phone_pay%rowtype;
begin
  select * into r from kiosk_phone_pay where code = p_code;
  if not found then
    return jsonb_build_object('ok', true, 'phase', 'browse', 'req', 0, 'total', 0, 'pin_len', 4, 'result', null,
                              'payment', null, 'paylater', 'unknown', 'parent_name', '');
  end if;
  return jsonb_build_object('ok', true, 'phase', r.phase, 'req', r.req, 'total', r.total, 'pin_len', r.pin_len, 'result', r.result,
                            'payment', r.payment, 'paylater', coalesce(r.paylater,'unknown'), 'parent_name', coalesce(r.parent_name,''));
end $$;

grant execute on function public.kiosk_phone_set_phase(text,text,numeric,int), public.kiosk_phone_get_phase(text) to anon, authenticated;
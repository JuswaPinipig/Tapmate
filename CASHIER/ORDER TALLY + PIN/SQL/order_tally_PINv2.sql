-- TapMate: payment method (RFID payment / Pay Later) chosen on the phone.
-- Run AFTER order_tally_PIN_phase.sql. It adds columns and replaces two functions from that file
-- (same names and arguments, so nothing else needs to change).

alter table public.kiosk_phone_pay
  add column if not exists payment      text,    -- kiosk -> phone: the order's current method ('rfid' / 'paylater')
  add column if not exists paylater     text,    -- kiosk -> phone: ok / no_parent / not_active / unknown
  add column if not exists parent_name  text,
  add column if not exists want_payment text;    -- phone -> kiosk: the method the student just picked

-- kiosk -> phone
create or replace function public.kiosk_phone_set_pay(p_code text, p_payment text, p_paylater text, p_parent text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_payment not in ('rfid','paylater') or p_paylater not in ('ok','no_parent','not_active','unknown') then
    return jsonb_build_object('ok', false);
  end if;
  insert into kiosk_phone_pay(code, payment, paylater, parent_name, updated_at)
  values (p_code, p_payment, p_paylater, left(coalesce(p_parent,''), 80), now())
  on conflict (code) do update set payment = excluded.payment, paylater = excluded.paylater,
    parent_name = excluded.parent_name, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;

-- phone -> kiosk
create or replace function public.kiosk_phone_choose_payment(p_code text, p_method text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if p_method not in ('rfid','paylater') then return jsonb_build_object('ok', false); end if;
  update kiosk_phone_pay set want_payment = p_method, updated_at = now() where code = p_code;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', n > 0);
end $$;

-- replaces the version in order_tally_PIN_phase.sql: also returns the payment info
create or replace function public.kiosk_phone_get_phase(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r kiosk_phone_pay%rowtype;
begin
  select * into r from kiosk_phone_pay where code = p_code;
  if not found then
    return jsonb_build_object('ok', true, 'phase', 'browse', 'total', 0, 'pin_len', 4, 'result', null,
                              'payment', null, 'paylater', 'unknown', 'parent_name', '');
  end if;
  return jsonb_build_object('ok', true, 'phase', r.phase, 'total', r.total, 'pin_len', r.pin_len, 'result', r.result,
                            'payment', r.payment, 'paylater', coalesce(r.paylater,'unknown'), 'parent_name', coalesce(r.parent_name,''));
end $$;

-- replaces the version in order_tally_PIN_phase.sql: also hands over the chosen payment method
create or replace function public.kiosk_phone_take_input(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_pin text; v_cancel boolean; v_pay text;
begin
  select pin, cancel, want_payment into v_pin, v_cancel, v_pay from kiosk_phone_pay where code = p_code for update;
  if not found then return jsonb_build_object('pin', null, 'cancel', false, 'payment', null); end if;
  update kiosk_phone_pay set pin = null, cancel = false, want_payment = null where code = p_code;
  return jsonb_build_object('pin', v_pin, 'cancel', coalesce(v_cancel, false), 'payment', v_pay);
end $$;

grant execute on function public.kiosk_phone_set_pay(text,text,text,text), public.kiosk_phone_choose_payment(text,text),
  public.kiosk_phone_get_phase(text), public.kiosk_phone_take_input(text) to anon, authenticated;
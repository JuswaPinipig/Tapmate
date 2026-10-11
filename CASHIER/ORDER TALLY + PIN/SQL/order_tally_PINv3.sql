-- TapMate: is this student allowed to use Pay Later? (kiosk -> phone)
-- Run AFTER order_tally_PINv2.sql. Uses your real data, nothing new is stored:
--   parent link   = public.parent_student_links (student_id, parent_id) + the parent's row in public.accounts
--   activated     = public.accounts.pay_later_enabled  (only the linked parent can switch it on)
-- Result 'state':
--   no_parent  -> not linked to any parent
--   not_active -> linked, but Pay Later is not activated
--   ok         -> linked AND activated
-- Only a signed-in cashier/admin kiosk session can ask (same check style as pay-later-ledgersv2.sql).

create or replace function public.kiosk_paylater_status(p_rfid text, p_token text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_role   text := coalesce((public.card_session(p_token))->>'role', '');
  v_id     uuid;
  v_enable boolean;
  v_parent text;
  v_linked boolean;
begin
  if v_role not in ('cashier', 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'session');
  end if;

  select a.id, coalesce(a.pay_later_enabled, false) into v_id, v_enable
    from public.accounts a
   where a.rfid_uid = p_rfid and a.role = 'student' and a.status = 'active'
   limit 1;
  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown_card');
  end if;

  select true, nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into v_linked, v_parent
    from public.parent_student_links l
    join public.accounts p on p.id = l.parent_id
   where l.student_id = v_id
   limit 1;
  v_linked := coalesce(v_linked, false);

  return jsonb_build_object(
    'ok', true,
    'state', case when not v_linked then 'no_parent' when not v_enable then 'not_active' else 'ok' end,
    'parent_name', coalesce(v_parent, ''));
end $$;

grant execute on function public.kiosk_paylater_status(text, text) to anon, authenticated;
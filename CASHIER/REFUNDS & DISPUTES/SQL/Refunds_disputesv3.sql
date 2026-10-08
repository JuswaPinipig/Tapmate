-- =====================================================================
--  TapMate - Refunds & disputes  v3 patch
--  Run AFTER Refunds_disputesv2.sql, once, in the Supabase SQL editor.
--  Adds: partial refunds (p_amount) + AI recommendation logging.
--  cashier_transactions() and tm_staff_id() are unchanged.
-- =====================================================================

-- 1) Record what the AI suggested next to the cashier's decision.
alter table public.refunds add column if not exists ai_action  text;
alter table public.refunds add column if not exists ai_summary text;

-- 2) Remove the old 3-argument version so the API has only one to choose from.
drop function if exists public.cashier_issue_refund(text, uuid, text);

-- 3) New version. Still one refund per sale (unique purchase_id), but the
--    amount can be less than the total when items are unticked.
create or replace function public.cashier_issue_refund(
    p_token      text,
    p_purchase_id uuid,
    p_amount     numeric default null,
    p_reason     text    default null,
    p_ai_action  text    default null,
    p_ai_summary text    default null
)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
    v_staff uuid := public.tm_staff_id(p_token);
    v_s     record;
    v_ref   public.refunds;
    v_amt   numeric(12,2);
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into v_s from public.kiosk_sales where id = p_purchase_id for update;   -- locks the row
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if exists (select 1 from public.refunds where purchase_id = p_purchase_id) then
        return jsonb_build_object('ok', false, 'reason', 'already');
    end if;

    v_amt := round(coalesce(p_amount, v_s.total), 2);
    if v_amt is null or v_amt <= 0 or v_amt > v_s.total then
        return jsonb_build_object('ok', false, 'reason', 'amount');
    end if;

    insert into public.refunds (purchase_id, amount, method, reason, refunded_by, ai_action, ai_summary)
    values (v_s.id, v_amt, v_s.method, nullif(trim(p_reason), ''), v_staff,
            nullif(trim(p_ai_action), ''), nullif(trim(p_ai_summary), ''))
    returning * into v_ref;

    if lower(coalesce(v_s.method, '')) like '%later%' then
        update public.accounts
           set pay_later_outstanding = greatest(coalesce(pay_later_outstanding, 0) - v_amt, 0),
               updated_at = now()
         where id = v_s.account_id;
    else
        update public.accounts
           set balance = coalesce(balance, 0) + v_amt,
               updated_at = now()
         where id = v_s.account_id;
    end if;

    return jsonb_build_object('ok', true, 'refunded_at', v_ref.created_at, 'amount', v_amt);
end $$;

revoke all on function public.cashier_issue_refund(text, uuid, numeric, text, text, text) from public;
grant execute on function public.cashier_issue_refund(text, uuid, numeric, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
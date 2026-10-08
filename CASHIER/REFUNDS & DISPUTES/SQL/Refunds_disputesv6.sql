-- =====================================================================
--  TapMate - Refunds & disputes  v6: student refund requests for cashiers/admins + AI visual assessment
--  Run once in the Supabase SQL editor, AFTER studentrefunds.sql and Refunds_disputesv5.sql. Safe to re-run.
--
--   * refund_requests gets two columns that store the AI photo assessment (so it is only paid for once).
--   * staff_refund_requests        -> the Requests / Rejected lists (no photo, light)
--   * staff_refund_request_detail  -> one request WITH the photo (+ the kiosk products, for the edge function)
--   * staff_save_refund_assessment -> called by the refund-ai edge function to store its result
--   * staff_review_refund_request  -> approve / reject a pending request
--
--  All of them use public.tm_staff_id(p_token), the same check cashier_transactions() already uses.
--  Approving does NOT move money here: the page first calls your existing cashier_issue_refund, then marks the
--  request approved. That keeps one single place that touches balances.
-- =====================================================================

alter table public.refund_requests add column if not exists ai_assessment  jsonb;
alter table public.refund_requests add column if not exists ai_assessed_at timestamptz;

-- ---------- list (no photo: it is heavy) ----------
create or replace function public.staff_refund_requests(p_token text, p_limit int default 300)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_staff uuid := public.tm_staff_id(p_token);
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    return jsonb_build_object('ok', true, 'requests', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
            select r.id, r.sale_id, r.reference, r.amount, r.reason, r.details, r.status,
                   r.review_note, r.reviewed_at, r.created_at,
                   coalesce(a.full_name, a.first_name) as student_name, a.student_id,
                   s.items, s.method, s.created_at as purchased_at,
                   exists (select 1 from public.refunds rf where rf.purchase_id = s.id) as sale_refunded,
                   r.ai_assessment->>'visual_similarity' as ai_similarity,
                   r.ai_assessment->>'matched_item'      as ai_matched
            from public.refund_requests r
            join public.kiosk_sales s on s.id = r.sale_id
            join public.accounts a    on a.id = r.account_id
            order by r.created_at desc
            limit greatest(least(coalesce(p_limit, 300), 1000), 1)
        ) x), '[]'::jsonb));
end $$;

revoke all on function public.staff_refund_requests(text, int) from public;
grant execute on function public.staff_refund_requests(text, int) to anon, authenticated;

-- ---------- one request, with the photo ----------
create or replace function public.staff_refund_request_detail(
    p_token text, p_id uuid, p_with_products boolean default false)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions as $$
declare v_staff uuid := public.tm_staff_id(p_token); v_req jsonb; v_prod jsonb := '[]'::jsonb;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select to_jsonb(q) into v_req from (
        select r.id, r.sale_id, r.reference, r.amount, r.reason, r.details, r.image, r.status,
               r.review_note, r.reviewed_at, r.created_at, r.ai_assessment, r.ai_assessed_at,
               coalesce(a.full_name, a.first_name) as student_name, a.student_id,
               s.items, s.method, s.created_at as purchased_at
        from public.refund_requests r
        join public.kiosk_sales s on s.id = r.sale_id
        join public.accounts a    on a.id = r.account_id
        where r.id = p_id
    ) q;
    if v_req is null then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

    if p_with_products then
        -- the kiosk's own listing of every item in that sale (whatever columns your products table has)
        select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_prod
        from public.products p
        where p.name in (select i->>'name' from jsonb_array_elements(coalesce(v_req->'items', '[]'::jsonb)) i);
    end if;

    return jsonb_build_object('ok', true, 'request', v_req, 'products', v_prod);
end $$;

revoke all on function public.staff_refund_request_detail(text, uuid, boolean) from public;
grant execute on function public.staff_refund_request_detail(text, uuid, boolean) to anon, authenticated;

-- ---------- the edge function stores the AI result here ----------
create or replace function public.staff_save_refund_assessment(p_token text, p_id uuid, p_assessment jsonb)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
begin
    if public.tm_staff_id(p_token) is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    update public.refund_requests set ai_assessment = p_assessment, ai_assessed_at = now() where id = p_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function public.staff_save_refund_assessment(text, uuid, jsonb) from public;
grant execute on function public.staff_save_refund_assessment(text, uuid, jsonb) to anon, authenticated;

-- ---------- approve / reject ----------
create or replace function public.staff_review_refund_request(
    p_token text, p_id uuid, p_decision text, p_note text default null)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare v_staff uuid := public.tm_staff_id(p_token); r public.refund_requests;
begin
    if v_staff is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    if p_decision not in ('approved', 'rejected') then return jsonb_build_object('ok', false, 'reason', 'decision'); end if;

    select * into r from public.refund_requests where id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
    if r.status <> 'pending' then return jsonb_build_object('ok', false, 'reason', 'already_reviewed'); end if;

    update public.refund_requests
       set status = p_decision, review_note = nullif(btrim(coalesce(p_note, '')), ''),
           reviewed_by = v_staff, reviewed_at = now()
     where id = p_id;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function public.staff_review_refund_request(text, uuid, text, text) from public;
grant execute on function public.staff_review_refund_request(text, uuid, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
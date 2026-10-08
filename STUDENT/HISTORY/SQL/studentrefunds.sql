-- =====================================================================
-- TapMate · Refund requests  (run AFTER studenthistoryv2.sql, safe to re-run)
--
--   * Student taps the eye icon -> e-receipt -> "Request refund" (only within 24 h of the purchase).
--   * The request (reason, details, photo) is saved in public.refund_requests, linked to the kiosk sale.
--   * The cashier who made the sale sees it through kiosk_refund_requests(token).
--   * Admin sees every request through admin_refund_requests(token), or by reading the table directly.
--   * student_history is re-created so each purchase also carries its refund status.
-- =====================================================================

create table if not exists public.refund_requests (
    id           uuid primary key default gen_random_uuid(),
    sale_id      uuid not null unique references public.kiosk_sales(id) on delete cascade,   -- one request per purchase
    account_id   uuid not null references public.accounts(id),                               -- the student
    cashier_id   uuid,                                                                       -- who rang up the sale
    reference    text not null,                                                              -- TM-XXXXXXXX
    amount       numeric(12,2) not null,
    reason       text not null,
    details      text not null,
    image        text not null,                                                              -- compressed photo as a data URL
    status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    review_note  text,
    reviewed_by  uuid,
    reviewed_at  timestamptz,
    created_at   timestamptz not null default now()
);
create index if not exists refund_requests_cashier_idx on public.refund_requests (cashier_id, created_at desc);
create index if not exists refund_requests_status_idx  on public.refund_requests (status, created_at desc);

-- Nobody reads or writes this table straight from the browser; everything goes through the functions below.
alter table public.refund_requests enable row level security;

-- ---------- student sends a request ----------
create or replace function public.student_request_refund(
    p_token text, p_sale uuid, p_reason text, p_details text, p_image text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
    v uuid := public._token_account(p_token);
    s public.kiosk_sales;
    v_reasons text[] := array['Product was expired', 'Product appeared spoiled/moldy', 'Wrong product received',
                              'Incorrect amount charged', 'Duplicate charge', 'Other'];
    v_details text := btrim(coalesce(p_details, ''));
begin
    if v is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select * into s from public.kiosk_sales where id = p_sale and account_id = v for update;
    if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

    if now() > s.created_at + interval '24 hours' then
        return jsonb_build_object('ok', false, 'reason', 'expired');          -- the 24 h window is enforced here, not just in the browser
    end if;
    if exists (select 1 from public.refund_requests where sale_id = s.id) then
        return jsonb_build_object('ok', false, 'reason', 'duplicate');
    end if;
    if p_reason is null or not (p_reason = any (v_reasons)) then
        return jsonb_build_object('ok', false, 'reason', 'reason');
    end if;
    if length(v_details) < 5 or length(v_details) > 500 then
        return jsonb_build_object('ok', false, 'reason', 'details');
    end if;
    if p_image is null or p_image not like 'data:image/%' or length(p_image) > 2500000 then
        return jsonb_build_object('ok', false, 'reason', 'image');
    end if;

    insert into public.refund_requests (sale_id, account_id, cashier_id, reference, amount, reason, details, image)
    values (s.id, v, s.cashier_id, 'TM-' || upper(left(replace(s.id::text, '-', ''), 8)), s.total,
            p_reason, v_details, p_image);

    return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.student_request_refund(text, uuid, text, text, text) from public;
grant execute on function public.student_request_refund(text, uuid, text, text, text) to anon, authenticated;

-- ---------- cashier inbox: refund requests on sales this cashier rang up ----------
create or replace function public.kiosk_refund_requests(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c uuid := public._kiosk_cashier(p_token);
begin
    if c is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;
    return jsonb_build_object('ok', true, 'requests', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
            select r.id, r.reference, r.amount, r.reason, r.details, r.image, r.status, r.created_at,
                   coalesce(a.full_name, a.first_name) as student_name, a.student_id,
                   s.items, s.method, s.created_at as purchased_at
            from public.refund_requests r
            join public.kiosk_sales s on s.id = r.sale_id
            join public.accounts a on a.id = r.account_id
            where r.cashier_id = c
            order by r.created_at desc limit 100
        ) x), '[]'::jsonb));
end $$;

revoke execute on function public.kiosk_refund_requests(text) from public;
grant execute on function public.kiosk_refund_requests(text) to anon, authenticated;

-- ---------- admin inbox: every request ----------
-- ASSUMPTION: the admin page signs in with the same card/token session and the account's role is 'admin'.
-- If your admin portal authenticates differently, keep the table and change only the check on the next line.
create or replace function public.admin_refund_requests(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v uuid := public._token_account(p_token);
begin
    if v is null or not exists (select 1 from public.accounts where id = v and lower(role::text) = 'admin') then
        return jsonb_build_object('ok', false, 'reason', 'session');
    end if;
    return jsonb_build_object('ok', true, 'requests', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.created_at desc) from (
            select r.id, r.reference, r.amount, r.reason, r.details, r.image, r.status, r.created_at,
                   coalesce(a.full_name, a.first_name) as student_name, a.student_id,
                   coalesce(c.full_name, c.first_name) as cashier_name,
                   s.items, s.method, s.created_at as purchased_at
            from public.refund_requests r
            join public.kiosk_sales s on s.id = r.sale_id
            join public.accounts a on a.id = r.account_id
            left join public.accounts c on c.id = r.cashier_id
            order by r.created_at desc limit 200
        ) x), '[]'::jsonb));
end $$;

revoke execute on function public.admin_refund_requests(text) from public;
grant execute on function public.admin_refund_requests(text) to anon, authenticated;

-- ---------- student_history: same as v2, plus each purchase's refund status ----------
create or replace function public.student_history(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
    v uuid := public._token_account(p_token);
    v_purchases jsonb;
    v_topups jsonb;
begin
    if v is null then return jsonb_build_object('ok', false, 'reason', 'session'); end if;

    select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_purchases
    from (
        select s.id,
               'TM-' || upper(left(replace(s.id::text, '-', ''), 8)) as reference,
               s.created_at, s.total, s.method,
               coalesce(c.full_name, c.first_name) as cashier_name,
               s.balance_after, s.pay_later_available, s.remaining_today,
               s.items,
               r.status as refund_status, r.created_at as refund_requested_at
        from public.kiosk_sales s
        left join public.accounts c on c.id = s.cashier_id
        left join public.refund_requests r on r.sale_id = s.id          -- the photo is NOT sent here, it's heavy
        where s.account_id = v
        order by s.created_at desc
        limit 200
    ) x;

    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_topups
    from (
        select q.id, q.amount, coalesce(q.location, q.description) as method, null::text as reference_no,
               'approved'::text as status, q.created_at
        from public.transactions q
        where q.account_id = v and q.type = 'topup'
        order by q.created_at desc
        limit 200
    ) t;

    return jsonb_build_object('ok', true, 'purchases', v_purchases, 'topups', v_topups, 'topups_ok', true);
end $$;

revoke execute on function public.student_history(text) from public;
grant execute on function public.student_history(text) to anon, authenticated;

notify pgrst, 'reload schema';
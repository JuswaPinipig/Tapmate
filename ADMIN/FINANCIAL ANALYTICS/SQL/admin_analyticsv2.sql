-- ============================================================
-- TapMate | Financial Analytics (admin_analytics.sql)
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- The page only talks to three RPCs (all admin-only, token based like the
-- other admin pages):
--   admin_analytics_summary(p_token, p_range)
--   admin_analytics_transactions(p_token, p_range, p_search, p_method, p_limit, p_offset)
--   admin_analytics_refunds(p_token, p_range, p_search, p_status, p_limit, p_offset)
-- p_range = 'today' | 'week' | 'month' | 'all'   (Asia/Manila time, weeks start Monday)
--
-- ------------------------------------------------------------
-- STEP 0 (only if something below errors): see your real columns
--   select table_name, column_name, data_type
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name in ('kiosk_sales','accounts','refunds')
--   order by table_name, ordinal_position;
--
-- Everything that depends on your table/column names lives in the two
-- views in section 1. If a name differs, change it THERE and nothing else.
-- ============================================================


-- ============================================================
-- 1. COLUMN MAPPING  (ADJUST HERE IF YOUR NAMES DIFFER)
-- ============================================================

-- One row per completed sale.
--   assumes kiosk_sales(id, created_at, account_id, total, method, items jsonb, cashier_id)
--   items = array like [{"name":"Chicken Adobo","qty":2,"price":55}]  (also accepts product_name / quantity)
--   cashier_id = accounts.id of the cashier who confirmed the sale
create or replace view public.analytics_sales_v as
select
    s.id::text                                         as id,
    s.created_at                                       as created_at,
    s.account_id                                       as account_id,
    s.total::numeric                                   as amount,
    lower(coalesce(nullif(trim(s.method::text), ''), 'unknown')) as method,
    case when jsonb_typeof(s.items) = 'array' then s.items else '[]'::jsonb end as items,
    s.cashier_id                                       as cashier_id
from public.kiosk_sales s;

-- One row per refund request.
--   assumes refunds(id, created_at, account_id, amount, reason, status, items jsonb, decided_by, decided_at)
--   status   = 'pending' | 'approved' | 'rejected'
--   decided_by = accounts.id of the cashier who approved / rejected it
create or replace view public.analytics_refunds_v as
select
    r.id::text                                         as id,
    r.created_at                                       as created_at,
    r.account_id                                       as account_id,
    r.amount::numeric                                  as amount,
    r.reason::text                                     as reason,
    lower(coalesce(nullif(trim(r.status::text), ''), 'pending')) as status,
    case when jsonb_typeof(r.items) = 'array' then r.items else '[]'::jsonb end as items,
    r.decided_by                                       as decided_by,
    r.decided_at                                       as decided_at
from public.refunds r;

-- accounts columns used: id, first_name, middle_name, last_name, student_id
-- (student_id is the YYYY-NNNNNN number; rename below if your column differs)

-- The views are internal. Nobody reads them directly; only the RPCs below do.
revoke all on public.analytics_sales_v   from public, anon, authenticated;
revoke all on public.analytics_refunds_v from public, anon, authenticated;


-- ============================================================
-- 2. HELPERS (internal)
-- ============================================================

-- Admin-only guard, same card session the other admin pages use.
create or replace function public._an_require_admin(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_role text;
begin
    select (public.card_session(p_token))->>'role' into v_role;
    if v_role is distinct from 'admin' then
        raise exception 'Admins only' using errcode = '42501';
    end if;
end $$;

-- [from, to) for a range name, in Philippine time.
create or replace function public._an_range(p_range text, out r_from timestamptz, out r_to timestamptz)
language plpgsql
stable
as $$
declare n timestamp := (now() at time zone 'Asia/Manila');
begin
    case lower(coalesce(p_range, 'month'))
        when 'today' then
            r_from := date_trunc('day',   n) at time zone 'Asia/Manila';
            r_to   := (date_trunc('day',   n) + interval '1 day')   at time zone 'Asia/Manila';
        when 'week' then
            r_from := date_trunc('week',  n) at time zone 'Asia/Manila';
            r_to   := (date_trunc('week',  n) + interval '7 days')  at time zone 'Asia/Manila';
        when 'all' then
            r_from := '-infinity'; r_to := 'infinity';
        else
            r_from := date_trunc('month', n) at time zone 'Asia/Manila';
            r_to   := (date_trunc('month', n) + interval '1 month') at time zone 'Asia/Manila';
    end case;
end $$;

-- Escapes % _ \ so a search term is matched literally.
create or replace function public._an_like(p_term text)
returns text
language sql
immutable
as $$
    select '%' || replace(replace(replace(coalesce(trim(p_term), ''), '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

-- revenue / count / approved-refund total for one window
create or replace function public._an_period(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'revenue',  coalesce((select sum(amount) from public.analytics_sales_v
                              where created_at >= p_from and created_at < p_to), 0),
        'count',    (select count(*) from public.analytics_sales_v
                     where created_at >= p_from and created_at < p_to),
        'refunded', coalesce((select sum(amount) from public.analytics_refunds_v
                              where status = 'approved' and created_at >= p_from and created_at < p_to), 0)
    )
$$;

revoke all on function public._an_require_admin(text)              from public, anon, authenticated;
revoke all on function public._an_period(timestamptz, timestamptz) from public, anon, authenticated;


-- ============================================================
-- 3. SUMMARY: revenue cards, best sellers, payment methods, refunds
--    Revenue = sales total (refunds are shown next to it, not subtracted).
-- ============================================================
create or replace function public.admin_analytics_summary(p_token text, p_range text default 'month')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    n        timestamp := (now() at time zone 'Asia/Manila');
    d_from   timestamptz := date_trunc('day',   n) at time zone 'Asia/Manila';
    d_to     timestamptz := (date_trunc('day',   n) + interval '1 day')   at time zone 'Asia/Manila';
    w_from   timestamptz := date_trunc('week',  n) at time zone 'Asia/Manila';
    w_to     timestamptz := (date_trunc('week',  n) + interval '7 days')  at time zone 'Asia/Manila';
    m_from   timestamptz := date_trunc('month', n) at time zone 'Asia/Manila';
    m_to     timestamptz := (date_trunc('month', n) + interval '1 month') at time zone 'Asia/Manila';
    r_from   timestamptz;
    r_to     timestamptz;
    v_range  jsonb;
    v_top    jsonb;
    v_methods jsonb;
    v_refunds jsonb;
    v_rf_top  jsonb;
begin
    perform public._an_require_admin(p_token);
    select x.r_from, x.r_to into r_from, r_to from public._an_range(p_range) x;

    -- selected range: totals + average sale
    select jsonb_build_object(
               'revenue', coalesce(sum(amount), 0),
               'count',   count(*),
               'avg',     coalesce(round(avg(amount), 2), 0))
      into v_range
      from public.analytics_sales_v
     where created_at >= r_from and created_at < r_to;

    -- best-selling items (by quantity)
    select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty) order by t.qty desc, t.name), '[]'::jsonb)
      into v_top
      from (
          select coalesce(nullif(i->>'name', ''), nullif(i->>'product_name', ''), 'Item') as name,
                 sum(coalesce(nullif(i->>'qty', '')::numeric, nullif(i->>'quantity', '')::numeric, 1)) as qty
            from public.analytics_sales_v s
            cross join lateral jsonb_array_elements(s.items) i
           where s.created_at >= r_from and s.created_at < r_to
           group by 1
           order by 2 desc, 1
           limit 5
      ) t;

    -- payment methods
    select coalesce(jsonb_agg(jsonb_build_object('method', t.method, 'count', t.cnt, 'amount', t.amt) order by t.amt desc), '[]'::jsonb)
      into v_methods
      from (
          select method, count(*) as cnt, coalesce(sum(amount), 0) as amt
            from public.analytics_sales_v
           where created_at >= r_from and created_at < r_to
           group by method
      ) t;

    -- items most often refunded
    select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'qty', t.qty) order by t.qty desc, t.name), '[]'::jsonb)
      into v_rf_top
      from (
          select coalesce(nullif(i->>'name', ''), nullif(i->>'product_name', ''), 'Item') as name,
                 sum(coalesce(nullif(i->>'qty', '')::numeric, nullif(i->>'quantity', '')::numeric, 1)) as qty
            from public.analytics_refunds_v f
            cross join lateral jsonb_array_elements(f.items) i
           where f.created_at >= r_from and f.created_at < r_to
           group by 1
           order by 2 desc, 1
           limit 5
      ) t;

    -- refunds & disputes counts (amount = approved refunds only)
    select jsonb_build_object(
               'count',    count(*),
               'pending',  count(*) filter (where status = 'pending'),
               'approved', count(*) filter (where status = 'approved'),
               'rejected', count(*) filter (where status = 'rejected'),
               'amount',   coalesce(sum(amount) filter (where status = 'approved'), 0),
               'top_items', v_rf_top)
      into v_refunds
      from public.analytics_refunds_v
     where created_at >= r_from and created_at < r_to;

    return jsonb_build_object(
        'today',     public._an_period(d_from, d_to),
        'week',      public._an_period(w_from, w_to),
        'month',     public._an_period(m_from, m_to),
        'range',     v_range,
        'top_items', v_top,
        'methods',   v_methods,
        'refunds',   v_refunds
    );
end $$;


-- ============================================================
-- 4. STUDENT TRANSACTIONS (+ the cashier who confirmed each one)
-- ============================================================
create or replace function public.admin_analytics_transactions(
    p_token text,
    p_range text default 'month',
    p_search text default '',
    p_method text default '',
    p_limit int default 8,
    p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    r_from timestamptz;
    r_to   timestamptz;
    v_like text := public._an_like(p_search);
    v_has  boolean := length(trim(coalesce(p_search, ''))) > 0;
    v_lim  int := least(greatest(coalesce(p_limit, 8), 1), 1000);
    v_off  int := greatest(coalesce(p_offset, 0), 0);
    v_total bigint;
    v_rows  jsonb;
begin
    perform public._an_require_admin(p_token);
    select x.r_from, x.r_to into r_from, r_to from public._an_range(p_range) x;

    with base as (
        select s.id, s.created_at, s.amount, s.method, s.items,
               trim(concat_ws(' ', a.first_name, a.middle_name, a.last_name)) as student_name,
               a.student_id::text                                             as student_no,
               trim(concat_ws(' ', c.first_name, c.middle_name, c.last_name)) as cashier_name
          from public.analytics_sales_v s
          left join public.accounts a on a.id = s.account_id
          left join public.accounts c on c.id = s.cashier_id
         where s.created_at >= r_from and s.created_at < r_to
           and (coalesce(p_method, '') = '' or s.method = lower(p_method))
           and (not v_has or
                concat_ws(' ', a.first_name, a.middle_name, a.last_name) ilike v_like
             or a.student_id::text ilike v_like
             or concat_ws(' ', c.first_name, c.middle_name, c.last_name) ilike v_like
             or s.items::text ilike v_like)
    )
    select (select count(*) from base),
           coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc)
                       from (select * from base order by created_at desc limit v_lim offset v_off) p), '[]'::jsonb)
      into v_total, v_rows;

    return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;


-- ============================================================
-- 5. REFUNDS (+ the cashier who approved / rejected each one)
-- ============================================================
create or replace function public.admin_analytics_refunds(
    p_token text,
    p_range text default 'month',
    p_search text default '',
    p_status text default '',
    p_limit int default 8,
    p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    r_from timestamptz;
    r_to   timestamptz;
    v_like text := public._an_like(p_search);
    v_has  boolean := length(trim(coalesce(p_search, ''))) > 0;
    v_lim  int := least(greatest(coalesce(p_limit, 8), 1), 1000);
    v_off  int := greatest(coalesce(p_offset, 0), 0);
    v_total bigint;
    v_rows  jsonb;
begin
    perform public._an_require_admin(p_token);
    select x.r_from, x.r_to into r_from, r_to from public._an_range(p_range) x;

    with base as (
        select f.id, f.created_at, f.amount, f.reason, f.status, f.items, f.decided_at,
               trim(concat_ws(' ', a.first_name, a.middle_name, a.last_name)) as student_name,
               a.student_id::text                                             as student_no,
               trim(concat_ws(' ', c.first_name, c.middle_name, c.last_name)) as decided_by_name
          from public.analytics_refunds_v f
          left join public.accounts a on a.id = f.account_id
          left join public.accounts c on c.id = f.decided_by
         where f.created_at >= r_from and f.created_at < r_to
           and (coalesce(p_status, '') = '' or f.status = lower(p_status))
           and (not v_has or
                concat_ws(' ', a.first_name, a.middle_name, a.last_name) ilike v_like
             or a.student_id::text ilike v_like
             or concat_ws(' ', c.first_name, c.middle_name, c.last_name) ilike v_like
             or coalesce(f.reason, '') ilike v_like
             or f.items::text ilike v_like)
    )
    select (select count(*) from base),
           coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc)
                       from (select * from base order by created_at desc limit v_lim offset v_off) p), '[]'::jsonb)
      into v_total, v_rows;

    return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;


-- ============================================================
-- 6. PERMISSIONS: callable from the browser, but each RPC checks admin itself
-- ============================================================
revoke all on function public.admin_analytics_summary(text, text)                              from public;
revoke all on function public.admin_analytics_transactions(text, text, text, text, int, int)   from public;
revoke all on function public.admin_analytics_refunds(text, text, text, text, int, int)        from public;

grant execute on function public.admin_analytics_summary(text, text)                              to anon, authenticated;
grant execute on function public.admin_analytics_transactions(text, text, text, text, int, int)   to anon, authenticated;
grant execute on function public.admin_analytics_refunds(text, text, text, text, int, int)        to anon, authenticated;

-- make PostgREST see the new functions right away
notify pgrst, 'reload schema';
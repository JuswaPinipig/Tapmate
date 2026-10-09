/* =====================================================================
   TapMate Admin | Audit Logs
   Read-only viewer for the `audit_logs` table (see adminauditlogs.sql).
   If SUPABASE_URL / SUPABASE_ANON_KEY are empty, the page runs on sample
   data so you can preview the design.
   ===================================================================== */
(() => {
    'use strict';

    /* ---------------- Config ---------------- */
    const SUPABASE_URL = 'https://inoafkspgsxzxarzboqq.supabase.co';        // e.g. https://xxxx.supabase.co
    const SUPABASE_ANON_KEY = 'sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z';   // your anon / publishable key
    const LOGIN_URL = '../../LOGIN/login.html';   // TODO: where "Log out" should go
    const PROFILE_PORTAL_URL = '#';               // TODO: same value as your account management page
    const SIZE_OPTIONS = [10, 15, 25, 50, 100];
    const SIZE_KEY = 'tm_audit_pagesize';
    let PAGE_SIZE = (() => { try { const n = Number(localStorage.getItem(SIZE_KEY)); return SIZE_OPTIONS.includes(n) ? n : 15; } catch (e) { return 15; } })();
    const EXPORT_LIMIT = 5000;
    // AI runs in a Supabase edge function (see supabase/functions/audit-ai). The OpenRouter key lives there, never here.
    const AI_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/audit-ai` : '';
    const AI_TIMEOUT_MS = 60000;

    // Admins sign in with RFID + PIN; the login page stores a session token. Send it with every request.
    function cardToken() {
        try { return (JSON.parse(sessionStorage.getItem('tapmate_session')) || {}).token || ''; }
        catch (_) { return ''; }
    }
    const sb = (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase)
        ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            global: { headers: { 'x-card-token': cardToken() } }
        })
        : null;

    // True only if the stored token belongs to an active admin
    async function requireAdmin() {
        if (!sb) return true; // demo mode
        if (!cardToken()) return false;
        try {
            const { data, error } = await sb.rpc('card_session', { p_token: cardToken() });
            return !error && !!data && data.role === 'admin';
        } catch (_) { return false; }
    }

    /* ---------------- Labels ---------------- */
    const MODULES = {
        accounts: 'Accounts',
        products: 'Products',
        pay_later: 'Pay later',
        top_up: 'Top ups',
        security: 'Security'
    };

    // tone maps to the badge colour: ok = green, warn = amber, bad = red, none = grey
    const ACTIONS = {
        create: { label: 'Created', tone: 'ok' },
        update: { label: 'Edited', tone: 'warn' },
        archive: { label: 'Archived', tone: 'bad' },
        restore: { label: 'Restored', tone: 'ok' },
        rfid_assign: { label: 'Assigned RFID', tone: 'warn' },
        freeze: { label: 'Froze card', tone: 'bad' },
        unfreeze: { label: 'Unfroze card', tone: 'ok' },
        pin_reset: { label: 'Reset PIN', tone: 'warn' },
        balance_adjust: { label: 'Adjusted balance', tone: 'warn' },
        approve: { label: 'Approved', tone: 'ok' },
        reject: { label: 'Rejected', tone: 'bad' },
        settle: { label: 'Settled', tone: 'ok' },
        login: { label: 'Logged in', tone: 'none' }
    };

    const MONEY_KEYS = /(balance|amount|price|limit|cap|outstanding|cost)/i;
    const SECRET_KEYS = /(pin|password|secret|token)/i;

    /* ---------------- Helpers ---------------- */
    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join('').toUpperCase() || '?';
    const humanize = (k) => { const s = String(k).replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
    const peso = (n) => '\u20B1' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const fmtTime = (iso, sec) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}) });
    const actionInfo = (a) => ACTIONS[a] || { label: humanize(a), tone: 'none' };

    function debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.cancel = () => clearTimeout(t); return d; }

    function formatValue(key, v) {
        if (v === null || v === undefined || v === '') return '<span class="none">None</span>';
        if (SECRET_KEYS.test(key)) return '\u2022\u2022\u2022\u2022';
        if (typeof v === 'boolean') return v ? 'Yes' : 'No';
        if (typeof v === 'number' && MONEY_KEYS.test(key)) return esc(peso(v));
        if (typeof v === 'object') return esc(JSON.stringify(v));
        return esc(v);
    }

    /** Build the field-by-field comparison for one log entry. */
    function buildDiff(before, after) {
        const b = before && typeof before === 'object' ? before : {};
        const a = after && typeof after === 'object' ? after : {};
        const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
        return keys.map((key) => ({
            key,
            before: b[key],
            after: a[key],
            changed: JSON.stringify(b[key] ?? null) !== JSON.stringify(a[key] ?? null)
        }));
    }
    const changedCount = (row) => buildDiff(row.before_data, row.after_data).filter((d) => d.changed).length;

    /* ---------------- State ---------------- */
    const state = {
        module: '', action: '', admin: '', from: '', to: '', q: '', page: 1, rows: [], total: 0, loading: false,
        actions: [], modules: [], ids: null, riskFilter: '', aiNote: '', aiQuery: ''
    };
    let adminList = [];
    let reqId = 0;

    /* ---------------- Demo data (only used when Supabase isn't configured) ---------------- */
    const DEMO = (() => {
        const admins = [
            { code: 'ADM-0001', rfid: '0012345678', name: 'Maria Santos' },
            { code: 'ADM-0002', rfid: '0098765432', name: 'Jose Ramirez' },
            { code: 'ADM-0003', rfid: '0045678123', name: 'Angela Reyes' }
        ];
        // [minutes ago, admin index, module, action, summary, before, after]
        const T = [
            [14, 0, 'accounts', 'update', 'Edited the account of Juan Dela Cruz (2024-001234)',
                { daily_limit: 150, pay_later: false, phone: '09171234567' }, { daily_limit: 300, pay_later: true, phone: '09171234567' }],
            [52, 1, 'top_up', 'approve', 'Approved a \u20B1500.00 top up for Ana Lim (2026-000412)',
                { status: 'pending', balance: 120 }, { status: 'approved', balance: 620 }],
            [95, 1, 'top_up', 'reject', 'Rejected a \u20B11,000.00 top up for Paolo Garcia (2025-000871)',
                { status: 'pending' }, { status: 'rejected' }],
            [140, 2, 'accounts', 'create', 'Created a student account for Ana Lim (2026-000412)',
                null, { full_name: 'Ana Lim', role: 'student', email: 'ana.lim@sjc.edu.ph', student_id: '2026-000412', rfid: '0034556677', balance: 0, daily_limit: 200 }],
            [260, 0, 'products', 'update', 'Edited the price of Chicken Adobo Meal',
                { price: 65, stock: 40 }, { price: 70, stock: 40 }],
            [410, 2, 'accounts', 'freeze', 'Froze the card of Mark Villanueva (2023-004410)',
                { card_frozen: false }, { card_frozen: true }],
            [600, 0, 'security', 'pin_reset', 'Reset the PIN of Katrina Bautista (2024-002287) to the default',
                { pin_status: 'custom' }, { pin_status: 'default' }],
            [1130, 1, 'accounts', 'rfid_assign', 'Assigned an RFID card to Ana Lim (2026-000412)',
                { rfid: null }, { rfid: '0034556677' }],
            [1500, 2, 'pay_later', 'settle', 'Marked the pay later balance of Leo Mercado (2025-001905) as settled',
                { status: 'unpaid', outstanding: 85 }, { status: 'settled', outstanding: 0 }],
            [1710, 0, 'products', 'create', 'Added a new product: Banana Cue',
                null, { name: 'Banana Cue', category: 'Snacks', price: 15, stock: 60 }],
            [2900, 1, 'accounts', 'balance_adjust', 'Adjusted the balance of Rica Navarro (2024-003350)',
                { balance: 45.5 }, { balance: 145.5 }],
            [3300, 2, 'accounts', 'archive', 'Archived the account of Daniel Cruz (2021-000118)',
                { status: 'active' }, { status: 'archived' }],
            [4400, 0, 'accounts', 'restore', 'Restored the account of Daniel Cruz (2021-000118)',
                { status: 'archived' }, { status: 'active' }],
            [5100, 1, 'products', 'archive', 'Archived the product Iced Coffee 16oz',
                { status: 'available' }, { status: 'archived' }],
            [6000, 2, 'security', 'login', 'Logged in to the admin portal', null, null],
            [7200, 0, 'accounts', 'update', 'Edited the account of Carla Mendoza (faculty)',
                { first_name: 'Carla', last_name: 'Mendoza', phone: '09175550123', email: 'carla.m@sjc.edu.ph' },
                { first_name: 'Carla', last_name: 'Mendoza-Reyes', phone: '09175550999', email: 'carla.m@sjc.edu.ph' }],
            [8600, 1, 'top_up', 'approve', 'Approved a \u20B1200.00 top up for Leo Mercado (2025-001905)',
                { status: 'pending', balance: 35 }, { status: 'approved', balance: 235 }],
            [9800, 2, 'accounts', 'unfreeze', 'Unfroze the card of Mark Villanueva (2023-004410)',
                { card_frozen: true }, { card_frozen: false }]
        ];
        const now = Date.now();
        return T.map((t, i) => {
            const ad = admins[t[1]];
            return {
                id: 1000 - i,
                created_at: new Date(now - t[0] * 60000).toISOString(),
                admin_code: ad.code, admin_rfid: ad.rfid, admin_name: ad.name,
                module: t[2], action: t[3], summary: t[4], before_data: t[5], after_data: t[6]
            };
        });
    })();

    function demoQuery(opts = {}) {
        const q = state.q.toLowerCase();
        const from = state.from ? new Date(state.from + 'T00:00:00').getTime() : null;
        const to = state.to ? new Date(state.to + 'T00:00:00').getTime() + 86400000 : null;
        const all = DEMO.filter((r) => {
            const t = new Date(r.created_at).getTime();
            if (state.module && r.module !== state.module) return false;
            if (state.action && r.action !== state.action) return false;
            if (state.admin && r.admin_code !== state.admin) return false;
            if (state.actions.length && !state.actions.includes(r.action)) return false;
            if (state.modules.length && !state.modules.includes(r.module)) return false;
            if (state.ids && !state.ids.includes(Number(r.id))) return false;
            if (from !== null && t < from) return false;
            if (to !== null && t >= to) return false;
            if (q && ![r.admin_name, r.admin_code, r.admin_rfid, r.summary].some((s) => String(s || '').toLowerCase().includes(q))) return false;
            return true;
        });
        const start = opts.all ? 0 : (state.page - 1) * PAGE_SIZE;
        return { rows: opts.all ? all : all.slice(start, start + PAGE_SIZE), total: all.length };
    }

    /* ---------------- Data ---------------- */
    // incident bookkeeping (resolve / status changes) is not an admin edit, so it stays out of the log and the analysis
    const HIDDEN_ACTIONS = '(incident_resolve,incident_dismiss,incident_status)';

    async function query(opts = {}) {
        if (!sb) return demoQuery(opts);

        let q = sb.from('audit_logs').select('*', { count: 'exact' }).not('action', 'in', HIDDEN_ACTIONS).order('created_at', { ascending: false });
        if (state.module) q = q.eq('module', state.module);
        if (state.action) q = q.eq('action', state.action);
        if (state.admin) q = q.eq('admin_code', state.admin);
        if (state.actions.length) q = q.in('action', state.actions);
        if (state.modules.length) q = q.in('module', state.modules);
        if (state.ids) q = q.in('id', state.ids);
        if (state.from) q = q.gte('created_at', new Date(state.from + 'T00:00:00').toISOString());
        if (state.to) {
            const end = new Date(state.to + 'T00:00:00'); end.setDate(end.getDate() + 1);
            q = q.lt('created_at', end.toISOString());
        }
        const term = state.q.replace(/[%,()*\\]/g, ' ').trim();
        if (term) {
            const p = `%${term}%`;
            q = q.or(`admin_name.ilike.${p},admin_code.ilike.${p},admin_rfid.ilike.${p},summary.ilike.${p},target_label.ilike.${p},target_id.ilike.${p}`);
        }
        if (opts.all) q = q.limit(EXPORT_LIMIT);
        else q = q.range((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE - 1);

        const { data, count, error } = await q;
        if (error) throw error;
        return { rows: data || [], total: count ?? (data || []).length };
    }

    async function loadAdmins() {
        let list = [];
        if (!sb) {
            const m = new Map(); DEMO.forEach((r) => m.set(r.admin_code, r.admin_name));
            list = [...m].map(([admin_code, admin_name]) => ({ admin_code, admin_name }));
        } else {
            const { data } = await sb.from('audit_admins').select('admin_code, admin_name').order('admin_name');
            list = data || [];
        }
        adminList = list;
        $('fAdmin').insertAdjacentHTML('beforeend',
            list.map((a) => `<option value="${esc(a.admin_code)}">${esc(a.admin_name)} (${esc(a.admin_code)})</option>`).join(''));
    }

    async function load() {
        const my = ++reqId;
        state.loading = true;
        renderSkeleton();
        try {
            const res = await query();
            if (my !== reqId) return;
            state.rows = res.rows; state.total = res.total; state.loading = false;
            // page went out of range (e.g. after filtering): jump back
            const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
            if (state.page > pages) { state.page = pages; return load(); }
            hideBanner(); render(); scheduleAnalyze();
        } catch (err) {
            if (my !== reqId) return;
            console.error(err);
            state.loading = false; state.rows = []; state.total = 0;
            render();
            showBanner('Could not load the audit logs. Check your connection and that you are signed in as an admin, then refresh the page.');
        }
    }

    /* ---------------- Rendering ---------------- */
    function renderSkeleton() {
        $('emptyState').hidden = true; $('pager').hidden = true;
        $('rows').innerHTML = Array.from({ length: 6 }, () =>
            `<tr class="skeleton"><td colspan="7"><span></span></td></tr>`).join('');
    }

    function filtersActive() {
        return !!(state.module || state.action || state.admin || state.from || state.to || state.q || state.actions.length || state.modules.length || state.ids);
    }

    function render() {
        const rows = state.rows;
        const title = state.module ? `${MODULES[state.module]} activity` : 'All activity';
        $('resultsTitle').textContent = state.riskFilter ? `${RISK_LABEL[state.riskFilter]} entries` : title;
        $('resultsCount').textContent = state.total ? `${state.total.toLocaleString()} ${state.total === 1 ? 'entry' : 'entries'}` : '';
        $('resetBtn').hidden = !filtersActive();
        $('exportBtn').disabled = !state.total;

        $('rows').innerHTML = rows.map((r) => {
            const a = actionInfo(r.action);
            const n = changedCount(r);
            return `<tr data-id="${esc(r.id)}">
                <td><span class="when">${esc(fmtDate(r.created_at))}</span><span class="when-sub">${esc(fmtTime(r.created_at))}</span></td>
                <td class="code">${esc(r.admin_code)}</td>
                <td class="code">${r.admin_rfid ? esc(r.admin_rfid) : '<span class="rfid-missing" title="No RFID was recorded for this admin when the action was logged">Not recorded</span>'}</td>
                <td class="who">${esc(r.admin_name)}</td>
                <td class="what-cell"><span class="badge ${a.tone}">${esc(a.label)}</span><span class="txt">${esc(r.summary)}</span></td>
                <td>${aiBadge(r.id)}</td>
                <td class="right"><div class="row-actions"><button type="button" class="btn ghost small" data-view="${esc(r.id)}">View changes</button>
                    ${investigable(r.id) ? `<button type="button" class="btn small investigate-btn" data-investigate="${esc(r.id)}" title="Go to the incident this entry belongs to">Investigate</button>` : ''}</div>
                    <span class="chg-count">${n ? `${n} ${n === 1 ? 'field' : 'fields'} changed` : 'No field changes'}</span></td>
            </tr>`;
        }).join('');

        const empty = $('emptyState');
        if (!rows.length) {
            empty.hidden = false;
            empty.textContent = filtersActive()
                ? 'No entries match these filters. Try a different search or reset the filters.'
                : 'No admin activity has been recorded yet. Changes made by admins will appear here.';
        } else empty.hidden = true;

        renderPager(); renderBar(); renderAiPanel();
    }

    const PG_ICON = {
        first: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/></svg>',
        prev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
        next: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
        last: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 17 5-5-5-5M6 17l5-5-5-5"/></svg>'
    };

    function renderPager() {
        const pager = $('pager');
        if (!state.total) { pager.hidden = true; pager.innerHTML = ''; return; }
        const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
        const cur = Math.min(state.page, pages);
        const from = (cur - 1) * PAGE_SIZE + 1;
        const to = Math.min(cur * PAGE_SIZE, state.total);

        // numbers: first, last and two either side of the current page, with ellipses between
        const set = new Set([1, pages]);
        for (let p = cur - 2; p <= cur + 2; p++) if (p >= 1 && p <= pages) set.add(p);
        const nums = [];
        let last = 0;
        [...set].sort((x, y) => x - y).forEach((p) => {
            if (p - last === 2) nums.push(`<button type="button" data-page="${last + 1}" aria-label="Page ${last + 1}">${last + 1}</button>`);
            else if (p - last > 2) nums.push('<span class="gap" aria-hidden="true">\u2026</span>');
            nums.push(`<button type="button" data-page="${p}" class="${p === cur ? 'on' : ''}" aria-label="Page ${p}" ${p === cur ? 'aria-current="page"' : ''}>${p}</button>`);
            last = p;
        });

        const nav = (target, icon, label, off) => `<button type="button" class="nav" data-page="${target}" ${off ? 'disabled' : ''} aria-label="${label}" title="${label}">${icon}</button>`;
        const sizeOpts = SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === PAGE_SIZE ? 'selected' : ''}>${n}</option>`).join('');

        pager.hidden = false;
        pager.innerHTML = `
            <div class="pg-left">
                <span class="info">Showing <b>${from.toLocaleString()}\u2013${to.toLocaleString()}</b> of <b>${state.total.toLocaleString()}</b> ${state.total === 1 ? 'entry' : 'entries'}</span>
                <label class="pg-size"><span>Rows per page</span>
                    <select id="pgSize" class="select" aria-label="Rows per page">${sizeOpts}</select>
                </label>
            </div>
            ${pages > 1 ? `<div class="pg-right">
                <span class="pages">
                    ${nav(1, PG_ICON.first, 'First page', cur === 1)}${nav(cur - 1, PG_ICON.prev, 'Previous page', cur === 1)}
                    ${nums.join('')}
                    ${nav(cur + 1, PG_ICON.next, 'Next page', cur === pages)}${nav(pages, PG_ICON.last, 'Last page', cur === pages)}
                </span>
                ${pages > 7 ? `<label class="pg-jump"><span>Go to</span><input id="pgJump" type="number" min="1" max="${pages}" inputmode="numeric" placeholder="${cur}" aria-label="Go to page (1 to ${pages})"></label>` : ''}
            </div>` : ''}`;
    }

    function changePageSize(n) {
        if (!SIZE_OPTIONS.includes(n) || n === PAGE_SIZE) return;
        const firstIndex = (state.page - 1) * PAGE_SIZE;     // keep the first visible entry on screen
        PAGE_SIZE = n;
        state.page = Math.floor(firstIndex / n) + 1;
        try { localStorage.setItem(SIZE_KEY, String(n)); } catch (e) { }
        load();
    }

    /* ---------------- AI assistant (advisory only) ----------------
       The browser never talks to OpenRouter. It calls the `audit-ai` edge function,
       which checks the admin session, reads the audit log itself, strips personal
       details, and asks OpenRouter. If anything fails, the audit log keeps working. */
    const RISK_LABEL = { routine: 'Routine', review: 'Review', unusual: 'Unusual', critical: 'Critical' };
    const RISK_ORDER = { routine: 0, review: 1, unusual: 2, critical: 3 };
    const STATUS_LABEL = { needs_review: 'Needs review', under_investigation: 'Under investigation', resolved: 'Resolved', dismissed: 'Dismissed' };
    const ai = { status: 'idle', data: null, risk: new Map(), resolution: new Map(), analyzed: new Set(), scope: null, error: '' };
    const SPARK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z"/></svg>';
    const AI_DOWN = 'AI analysis unavailable.';

    async function aiCall(mode, payload) {
        if (!sb || !AI_URL) throw new Error('AI is not available in sample mode');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
        try {
            const res = await fetch(AI_URL, {
                method: 'POST',
                signal: ctrl.signal,
                headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, 'x-card-token': cardToken() },
                body: JSON.stringify({ mode, ...payload })
            });
            const json = await res.json().catch(() => null);
            if (!res.ok || !json || json.ok === false) throw new Error((json && json.error) || `AI request failed (${res.status})`);
            return json.data;
        } finally { clearTimeout(timer); }
    }

    function aiChip(level) {
        return level && RISK_LABEL[level]
            ? `<span class="ai-chip ${level}">${RISK_LABEL[level]}</span>`
            : '<span class="ai-chip none">\u2014</span>';
    }
    const resolvedLine = (r) => `Resolved by ${r.resolved_by_name || r.resolved_by_code || 'an admin'}`;
    function aiBadge(id) {
        if (!ai.data && ai.status === 'loading') return '<span class="ai-chip none">Analyzing\u2026</span>';
        if (!ai.data || ai.status === 'error') return aiChip(null);
        const k = String(id);
        const level = ai.risk.get(k) || (ai.analyzed.has(k) ? 'routine' : null);
        const res = level === 'routine' ? ai.resolution.get(k) : null;
        if (!res) return aiChip(level);
        const label = res.status === 'dismissed' ? 'Dismissed by' : 'Resolved by';
        const who = res.resolved_by_name || res.resolved_by_code || 'an admin';
        return `${aiChip('routine')}<span class="ai-resolved-note" title="${esc(res.ref)} \u00B7 ${esc(fmtDate(res.resolved_at))}">${label} ${esc(who)}</span>`;
    }

    function dayRange() {
        const out = { from: null, to: null };
        if (state.from) out.from = new Date(state.from + 'T00:00:00').toISOString();
        if (state.to) { const e = new Date(state.to + 'T00:00:00'); e.setDate(e.getDate() + 1); out.to = e.toISOString(); }
        return out;
    }
    const scopePayload = () => ({ ...dayRange(), module: state.module || null, action: state.action || null, admin: state.admin || null });
    const scopeKey = () => JSON.stringify(scopePayload());

    /* ---- collapsible panel (smooth open/close handled by CSS grid-rows transition) ---- */
    const AI_COLLAPSE_KEY = 'tm_ai_collapsed';
    function setAiCollapsed(collapsed, instant) {
        const panel = $('aiPanel'), t = $('aiToggle'), inner = $('aiInner');
        if (instant) panel.classList.add('no-anim');
        panel.classList.toggle('collapsed', collapsed);
        t.setAttribute('aria-expanded', String(!collapsed));
        t.setAttribute('aria-label', collapsed ? 'Expand AI audit insights' : 'Collapse AI audit insights');
        inner.toggleAttribute('inert', collapsed);
        inner.setAttribute('aria-hidden', String(collapsed));
        try { localStorage.setItem(AI_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) { }
        if (instant) requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('no-anim')));
    }
    const aiIsCollapsed = () => $('aiPanel').classList.contains('collapsed');

    function updateAiMini() {
        let t = '';
        if (ai.status === 'loading') t = 'Analyzing\u2026';
        else if (ai.status === 'error') t = AI_DOWN;
        else if (ai.status === 'done' && ai.data) {
            const c = ai.data.counts || {};
            t = `${Number(ai.data.analyzed || 0).toLocaleString()} analyzed \u00B7 ${c.review || 0} review \u00B7 ${c.unusual || 0} unusual${c.critical ? ` \u00B7 ${c.critical} critical` : ''}`;
        }
        $('aiMini').textContent = t;
    }

    /* ---- which audit entries belong to each count ---- */
    function idsForRisk(level) {
        const all = [...ai.analyzed].map(Number);
        if (level === 'routine') return all.filter((id) => !ai.risk.get(String(id)));
        return all.filter((id) => ai.risk.get(String(id)) === level);
    }

    function statChip(level, n, label) {
        n = Number(n || 0);
        const on = level !== 'all' && state.riskFilter === level;
        const off = level !== 'all' && n === 0;
        const tip = off ? `No ${label.toLowerCase()} entries` : on ? 'Click to show all entries again' : `Show these ${n.toLocaleString()} entries in the table`;
        return `<button type="button" class="ai-stat ${level} ${on ? 'on' : ''}" data-risk="${level}" ${off ? 'disabled' : ''} aria-pressed="${on}" title="${esc(tip)}"><b>${n.toLocaleString()}</b><span>${label}</span></button>`;
    }

    /* ---- cards ---- */
    // swap "account #<long id>" for the account holder's name when we know it
    function nameAccounts(text, label) {
        const t = String(text ?? '');
        if (!label) return t;
        return t
            .replace(/\bon account #[\w-]+/g, `on the account of ${label}`)
            .replace(/\bAccount #[\w-]+/g, label)
            .replace(/\baccount #[\w-]+/g, label);
    }

    function incActions(c) {
        if (!ai.data || !ai.data.can_resolve || c.status === 'resolved' || c.status === 'dismissed') return '';
        return `<button type="button" class="btn primary small" data-inc="${c.id}" data-status="resolved">Mark resolved</button>`;
    }

    function incCard(c) {
        const ids = c.event_ids || [];
        const closed = c.status === 'resolved' || c.status === 'dismissed';
        const flag = c.is_new ? '<span class="ai-new">New</span>' : c.has_new_evidence ? '<span class="ai-new">New activity</span>' : '';
        const done = closed
            ? `<p class="ai-done">\u2713 ${c.status === 'dismissed' ? 'Dismissed' : 'Resolved'} by <b>${esc(c.resolved_by_name || c.resolved_by_code || 'an admin')}</b>${c.resolved_by_code && c.resolved_by_name ? ` (${esc(c.resolved_by_code)})` : ''} on ${esc(fmtDate(c.resolved_at))}${c.resolution_note ? ` \u2014 \u201C${esc(c.resolution_note)}\u201D` : ''}</p>` : '';
        const follows = c.follows ? `<p class="ai-why">This follows the earlier incident ${esc(c.follows.ref)}${c.follows.status === 'resolved' ? `, which ${esc(c.follows.resolved_by_name || 'an admin')} resolved` : ''}.</p>` : '';
        return `<article class="ai-card ${esc(c.severity)} ${closed ? 'closed' : ''}" id="inc-${esc(c.id)}">
            <div class="ai-card-top">${aiChip(c.severity)}<span class="ai-kind">${esc(c.ref)} \u00B7 ${esc(STATUS_LABEL[c.status] || c.status)}</span>${flag}
                <span class="ai-conf">Detected ${esc(fmtDate(c.first_detected_at))}</span></div>
            <p><b>${esc(nameAccounts(c.summary, c.account_label))}</b></p>
            <p class="ai-why">${esc(nameAccounts(c.reason, c.account_label))}</p>
            ${closed ? '' : `<p class="ai-rec">${esc(c.steps)}</p>`}
            ${follows}${done}
            <div class="ai-card-btns">
                ${ids.length ? `<button type="button" class="btn ghost small" data-related="${esc(ids.join(','))}">View related logs (${ids.length})</button>` : ''}
                ${incActions(c)}
            </div>
        </article>`;
    }

    function obsCard(it, i) {
        const ids = it.related_event_ids || [];
        return `<article class="ai-card ${esc(it.risk_level)}">
            <div class="ai-card-top">${aiChip(it.risk_level)}<span class="ai-kind">${i === 0 ? 'Latest observation' : 'Observation'}</span>
                <span class="ai-conf">Confidence ${Math.round((it.confidence || 0) * 100)}%</span></div>
            <p><b>${esc(nameAccounts(it.summary, it.account_label))}</b></p><p class="ai-why">${esc(nameAccounts(it.reason, it.account_label))}</p><p class="ai-rec">${esc(it.recommended_action)}</p>
            ${ids.length ? `<div class="ai-card-btns"><button type="button" class="btn ghost small" data-related="${esc(ids.join(','))}">View related logs (${ids.length})</button></div>` : ''}
        </article>`;
    }

    // "That problem I flagged earlier has been resolved by <admin>."
    // "Dismiss" only hides the item in this browser; the incident and its record stay as they are
    const HIDE_KEY = 'tm_audit_resolved_hidden';
    const hiddenRes = (() => { try { return new Set((JSON.parse(localStorage.getItem(HIDE_KEY)) || []).map(String)); } catch (e) { return new Set(); } })();
    const saveHidden = () => { try { localStorage.setItem(HIDE_KEY, JSON.stringify([...hiddenRes].slice(-500))); } catch (e) { } };

    function resolvedStory(list) {
        list = list.filter((c) => !hiddenRes.has(String(c.id)));
        if (!list.length) return '';
        const line = (c) => `<li><span class="ok-tick">\u2713</span><span>Earlier finding \u201C${esc(nameAccounts(c.summary, c.account_label))}\u201D has been resolved by <b>${esc(c.resolved_by_name || c.resolved_by_code || 'an admin')}</b> on ${esc(fmtDate(c.resolved_at))}${c.resolution_note && c.resolution_note !== 'Marked as resolved' ? ` \u2014 ${esc(c.resolution_note)}` : ''}. Its entries now count as Routine.
            ${(c.event_ids || []).length ? `<button type="button" class="link-btn" data-chg="${esc(c.id)}">${chgOpen.has(String(c.id)) ? 'Hide changes' : 'Show changes'}</button>` : ''}
            ${chgOpen.has(String(c.id)) ? `<span class="ai-changes">${chgCache.get(String(c.id)) || '<em>Loading\u2026</em>'}</span>` : ''}</span>
            <button type="button" class="res-x" data-res-hide="${esc(c.id)}" aria-label="Dismiss this item" title="Dismiss">\u00D7</button></li>`;
        return `<div class="ai-resolved"><div class="ai-resolved-head"><h4>Resolved since flagged</h4><button type="button" class="link-btn" data-res-clear>Dismiss all</button></div><ul>${list.slice(0, 3).map(line).join('')}</ul>
            ${list.length > 3 ? `<details class="ai-fold"><summary>Show ${list.length - 3} more</summary><ul>${list.slice(3).map(line).join('')}</ul></details>` : ''}</div>`;
    }

    // the real edits behind a resolved incident: field, before, after (never the status / note bookkeeping)
    const chgOpen = new Set(), chgCache = new Map();
    async function toggleChanges(id) {
        id = String(id);
        if (chgOpen.has(id)) { chgOpen.delete(id); renderAiPanel(); return; }
        chgOpen.add(id); renderAiPanel();
        if (chgCache.has(id)) return;
        const c = [...(ai.data.resolved || []), ...(ai.data.dismissed || [])].find((x) => String(x.id) === id);
        let html = '<em>No recorded field changes.</em>';
        try {
            if (c && sb) {
                const { data, error } = await sb.from('audit_logs').select('id,created_at,admin_name,summary,before_data,after_data')
                    .in('id', c.event_ids || []).not('action', 'in', HIDDEN_ACTIONS).order('created_at');
                if (error) throw error;
                const blocks = (data || []).map((r) => {
                    const ch = buildDiff(r.before_data, r.after_data).filter((d) => d.changed);
                    if (!ch.length) return '';
                    return `<span class="chg-entry"><b>${esc(fmtDate(r.created_at))} ${esc(fmtTime(r.created_at))}</b> \u00B7 ${esc(r.admin_name)}<table class="chg-table"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>${ch.map((d) => `<tr><td>${esc(humanize(d.key))}</td><td>${formatValue(d.key, d.before)}</td><td>${formatValue(d.key, d.after)}</td></tr>`).join('')}</tbody></table></span>`;
                }).filter(Boolean);
                if (blocks.length) html = blocks.join('');
            }
        } catch (err) { console.error(err); html = '<em>Could not load the changes.</em>'; }
        chgCache.set(id, html);
        if (chgOpen.has(id)) renderAiPanel();
    }

    function renderAiPanel() {
        updateAiMini();
        const body = $('aiBody'), btn = $('aiAnalyze');
        btn.disabled = ai.status === 'loading';
        btn.textContent = ai.status === 'loading' ? 'Analyzing\u2026' : 'Analyze again';

        if (ai.status === 'idle') {
            body.innerHTML = sb ? '<div class="ai-loading"><span class="ai-spin"></span>Starting the analysis\u2026</div>'
                : '<p class="ai-idle">AI analysis runs automatically on the live site. It is switched off in sample mode.</p>';
            return;
        }
        if (ai.status === 'loading' && !ai.data) {
            body.innerHTML = '<div class="ai-loading"><span class="ai-spin"></span>Reading the audit entries\u2026 this can take a few seconds.</div>';
            return;
        }
        if (ai.status === 'error') {
            body.innerHTML = `<p class="ai-fail"><b>${AI_DOWN}</b> The audit log below is unaffected and still works normally. Press <b>Analyze again</b> to retry.</p>`;
            return;
        }
        const d = ai.data, c = d.counts || {};
        const open = [...(d.new_findings || []), ...(d.unresolved || [])].sort((a, b) => (RISK_ORDER[b.severity] - RISK_ORDER[a.severity]));
        const resolved = d.resolved || [], dismissed = d.dismissed || [];
        const obs = [...(d.observations || [])].sort((a, b) => (RISK_ORDER[b.risk_level] - RISK_ORDER[a.risk_level]) || (b.confidence - a.confidence));
        const stale = ai.scope !== scopeKey() ? '<p class="ai-meta">Your filters changed. The analysis will refresh in a moment.</p>' : '';
        const routineNote = c.closed ? `<small class="ai-stat-sub">${c.closed} resolved</small>` : '';

        body.innerHTML = `
            <div class="ai-stats" role="group" aria-label="Jump to analyzed entries">
                ${statChip('all', d.analyzed, 'actions analyzed')}${statChip('routine', c.routine, 'Routine')}${statChip('review', c.review, 'Review')}${statChip('unusual', c.unusual, 'Unusual')}${statChip('critical', c.critical, 'Critical')}
            </div>
            ${routineNote ? `<p class="ai-stat-hint">Routine includes ${c.closed} ${c.closed === 1 ? 'entry' : 'entries'} from incidents that an admin already resolved.</p>` : ''}
            <p class="ai-summary">${esc(d.summary)}</p>
            ${resolvedStory([...resolved, ...dismissed].sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at))))}
            ${open.length ? `<h4 class="ai-sec">Needs review (${open.length})</h4><div class="ai-list">${open.map(incCard).join('')}</div>` : ''}
            ${obs.length ? `<h4 class="ai-sec">Observations (${obs.length})</h4><div class="ai-list">${obs.map(obsCard).join('')}</div>` : ''}
            ${!open.length && !obs.length ? '<p class="ai-idle">Nothing needs review in the selected period.</p>' : ''}
            ${stale}
            <p class="ai-meta">${d.cached ? 'Saved analysis reused (nothing new to analyze)' : 'New analysis'} \u00B7 ${esc(d.model || 'AI model')} \u00B7 ${d.truncated ? 'latest 200 entries only' : 'all matching entries'}</p>`;
    }

    async function analyze() {
        if (ai.status === 'loading' || !sb) return;
        ai.status = 'loading'; ai.error = ''; renderAiPanel();
        const scope = scopeKey();
        try {
            const data = await aiCall('analyze', scopePayload());
            ai.data = data;
            ai.risk = new Map(Object.entries(data.event_risk || {}));
            ai.resolution = new Map(Object.entries(data.event_resolution || {}));
            ai.analyzed = new Set((data.analyzed_ids || []).map(String));
            ai.status = 'done';
        } catch (err) {
            console.error('AI analyze failed:', err);
            ai.status = 'error'; ai.error = String(err && err.message || '').slice(0, 200);
        }
        ai.scope = scope;                                  // never retry in a loop; "Analyze again" is always there
        renderAiPanel(); render();
        if (scopeKey() !== ai.scope) scheduleAnalyze();    // filters changed while we were working
    }

    // runs by itself: when the page opens and whenever the date / area / action / admin filters change
    const scheduleAnalyze = debounce(() => { if (sb && scopeKey() !== ai.scope) analyze(); }, 600);

    /* ---- Investigate: from a critical / unusual row to its open incident ---- */
    function investigable(id) {
        if (!ai.data || ai.status === 'error') return false;
        const l = ai.risk.get(String(id));
        return l === 'critical' || l === 'unusual';
    }
    function investigate(id) {
        const n = Number(id);
        const list = [...(ai.data.new_findings || []), ...(ai.data.unresolved || [])]
            .filter((c) => (c.event_ids || []).includes(n))
            .sort((a, b) => RISK_ORDER[b.severity] - RISK_ORDER[a.severity]);
        const inc = list[0]; if (!inc) return false;
        const wasCollapsed = aiIsCollapsed();
        if (wasCollapsed) setAiCollapsed(false);
        setTimeout(() => {
            const el = document.getElementById(`inc-${inc.id}`); if (!el) return;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
        }, wasCollapsed ? 380 : 0);
        return true;
    }

    /* ---- jump from a count to its entries ---- */
    function scrollToResults() {
        const bar = $('relatedBar');
        const target = bar.hidden ? document.querySelector('.card') : bar;
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    function focusRisk(level) {
        if (level === 'all' || state.riskFilter === level) { state.ids = null; state.riskFilter = ''; }
        else {
            const ids = idsForRisk(level);
            if (!ids.length) return;
            state.ids = ids; state.riskFilter = level;
        }
        state.page = 1; renderAiPanel();
        Promise.resolve(load()).then(scrollToResults);
    }

    /* ---- resolve / dismiss / reopen (humans only; the AI never does this) ---- */
    let pendingInc = null;
    function askIncident(id, status) {
        const c = [...(ai.data.new_findings || []), ...(ai.data.unresolved || [])].find((x) => String(x.id) === String(id));
        if (!c) return;
        pendingInc = { id, status: 'resolved' };
        $('incTitle').textContent = 'Mark as resolved';
        $('incWhat').textContent = `${c.ref}: ${nameAccounts(c.summary, c.account_label)}`;
        $('incNote').value = '';
        $('incErr').hidden = true;
        $('incDialog').showModal(); $('incNote').focus();
    }
    async function saveIncident() {
        if (!pendingInc) return;
        const btn = $('incSave'); btn.disabled = true;
        try {
            await aiCall('incident_status', { id: pendingInc.id, status: 'resolved', note: $('incNote').value.trim() || 'Marked as resolved' });
            $('incDialog').close(); toast('Marked as resolved');
            ai.scope = null; analyze();                    // re-read from the database so counts and badges move to Routine
        } catch (err) { $('incErr').textContent = err.message || 'Could not update the incident.'; $('incErr').hidden = false; }
        finally { btn.disabled = false; }
    }

    /* ---- related logs (these are the real Supabase rows, never AI-made) ---- */
    function showRelated(ids) {
        state.ids = ids.map(Number).filter(Number.isFinite); state.riskFilter = ''; state.page = 1;
        renderAiPanel();
        Promise.resolve(load()).then(scrollToResults);
    }

    function renderBar() {
        const el = $('relatedBar');
        if (state.ids) {
            el.hidden = false;
            el.innerHTML = `<span class="rb-txt">${state.riskFilter
                ? `Showing the <b>${state.ids.length}</b> <b>${RISK_LABEL[state.riskFilter]}</b> ${state.ids.length === 1 ? 'entry' : 'entries'} from the AI analysis.`
                : `Showing the <b>${state.ids.length}</b> audit ${state.ids.length === 1 ? 'entry' : 'entries'} linked to this finding.`} These are the original records.</span>
                <button type="button" class="btn ghost small" data-clear="ids">Show all entries</button>`;
        } else if (state.aiNote) {
            el.hidden = false;
            el.innerHTML = `<span class="rb-txt">${SPARK.replace('width="18" height="18"', 'width="16" height="16" style="vertical-align:-3px"')} <b>AI search</b> read \u201C${esc(state.aiQuery)}\u201D as: ${esc(state.aiNote)}. Results come straight from the audit log.</span>
                <button type="button" class="btn ghost small" data-clear="ai">Clear</button>`;
        } else el.hidden = true;
    }

    /* ---- AI search: plain English -> a small, validated filter set ---- */
    function resolveAdmin(v) {
        if (!v) return '';
        const s = String(v).trim().toLowerCase();
        const num = s.replace(/\D/g, '').replace(/^0+/, '');
        const hit = adminList.find((a) => a.admin_code.toLowerCase() === s)
            || (num && adminList.find((a) => a.admin_code.replace(/\D/g, '').replace(/^0+/, '') === num))
            || adminList.find((a) => String(a.admin_name).toLowerCase().includes(s));
        return hit ? hit.admin_code : '';
    }

    function syncControls() {
        $('searchInput').value = state.q; $('clearSearch').hidden = !state.q;
        $('fAction').value = state.action; $('fAdmin').value = state.admin;
        $('fFrom').value = state.from; $('fTo').value = state.to;
        document.querySelectorAll('#modulePills .pill').forEach((p) => {
            const on = p.dataset.module === state.module;
            p.classList.toggle('on', on); p.setAttribute('aria-selected', String(on));
        });
        moveSlider();
    }

    async function runAiSearch(text) {
        text = String(text || '').trim(); if (!text) return;
        saveRecent(text);
        const bar = $('relatedBar');
        bar.hidden = false;
        bar.innerHTML = '<span class="rb-txt"><span class="ai-spin" style="display:inline-block;vertical-align:-4px;margin-right:8px"></span>AI is reading your search\u2026</span>';
        try {
            const f = await aiCall('search', { query: text.slice(0, 200), today: new Date().toLocaleDateString('en-CA'), weekday: new Date().toLocaleDateString('en-US', { weekday: 'long' }) });
            const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(d));
            const acts = (f.actions || []).filter((a) => ACTIONS[a]);
            const mods = (f.modules || []).filter((m) => MODULES[m]);
            Object.assign(state, { module: '', action: '', admin: '', from: '', to: '', q: '', actions: [], modules: [], ids: null, riskFilter: '', page: 1 });
            if (mods.length === 1) state.module = mods[0]; else state.modules = mods;
            if (acts.length === 1) state.action = acts[0]; else state.actions = acts;
            if (isDay(f.date_from)) state.from = f.date_from;
            if (isDay(f.date_to)) state.to = f.date_to;
            if (state.from && state.to && state.from > state.to) [state.from, state.to] = [state.to, state.from];
            const parts = [];
            if (mods.length) parts.push(mods.map((m) => MODULES[m]).join(' / '));
            if (acts.length) parts.push(acts.map((a) => actionInfo(a).label).join(' / '));
            if (f.admin) {
                const code = resolveAdmin(f.admin);
                if (code) { state.admin = code; parts.push(`admin ${code}`); }
                else { state.q = String(f.admin).slice(0, 60); parts.push(`text \u201C${state.q}\u201D`); }
            }
            if (f.text && !state.q) { state.q = String(f.text).slice(0, 60); parts.push(`text \u201C${state.q}\u201D`); }
            if (state.from || state.to) parts.push(state.from === state.to || !state.to ? `from ${state.from}` : `${state.from || '\u2026'} to ${state.to || 'today'}`);
            state.aiQuery = text; state.aiNote = parts.length ? parts.join(' \u00B7 ') : 'no specific filters (showing everything)';
            syncControls(); load();
        } catch (err) {
            console.error('AI search failed:', err);
            state.aiNote = ''; renderBar();
            toast(`${AI_DOWN} Using normal search instead.`, true);
            $('searchInput').value = text; state.q = text; state.page = 1; $('clearSearch').hidden = false; load();
        }
    }

    /* ---------------- Search autocomplete (YouTube-style) ----------------
       Recent searches, live matches from the log, action/area shortcuts,
       arrow-key preview, "fill without searching" arrow, and an Ask AI row. */
    const RECENT_KEY = 'tm_audit_recent';
    const getRecent = () => { try { const r = JSON.parse(localStorage.getItem(RECENT_KEY)); return Array.isArray(r) ? r : []; } catch (e) { return []; } };
    const setRecent = (list) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (e) { } };
    function saveRecent(t) {
        t = String(t || '').trim(); if (t.length < 2) return;
        setRecent([t, ...getRecent().filter((x) => x.toLowerCase() !== t.toLowerCase())]);
    }
    function removeRecent(t) { setRecent(getRecent().filter((x) => x !== t)); }

    const sg = { items: [], index: -1, typed: '', open: false, req: 0 };
    const IC = {
        search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
        clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
        fill: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>'
    };

    const looksLikeQuestion = (t) => {
        const w = t.trim().split(/\s+/).length;
        return w >= 4 || (w >= 3 && /^(show|what|find|list|who|which|how|when|any|did|were)\b/i.test(t.trim()));
    };

    // YouTube bolds what you did NOT type: keep the match light, bold the rest
    function emph(label, term) {
        const i = label.toLowerCase().indexOf(term.toLowerCase());
        if (i < 0 || !term) return esc(label);
        const b = label.slice(0, i), m = label.slice(i, i + term.length), a = label.slice(i + term.length);
        return `${b ? `<b>${esc(b)}</b>` : ''}${esc(m)}${a ? `<b>${esc(a)}</b>` : ''}`;
    }

    async function fetchTextSuggestions(term) {
        let rows = [];
        if (!sb) {
            const t = term.toLowerCase();
            rows = DEMO.filter((r) => [r.admin_name, r.admin_code, r.admin_rfid, r.summary].some((s) => String(s || '').toLowerCase().includes(t)));
        } else {
            const clean = term.replace(/[%,()*\\]/g, ' ').trim();
            if (!clean) return [];
            const p = `%${clean}%`;
            const { data, error } = await sb.from('audit_logs')
                .select('admin_name,admin_code,admin_rfid,target_label,summary')
                .or(`admin_name.ilike.${p},admin_code.ilike.${p},admin_rfid.ilike.${p},target_label.ilike.${p},summary.ilike.${p}`)
                .order('created_at', { ascending: false }).limit(60);
            if (error) throw error;
            rows = data || [];
        }
        const t = term.toLowerCase();
        const map = new Map();
        const add = (label, tag, value) => {
            const k = label.toLowerCase(); const cur = map.get(k);
            if (cur) cur.count++; else map.set(k, { kind: 'text', label, value: value || label, tag, count: 1 });
        };
        rows.forEach((r) => {
            [[r.admin_name, 'Admin'], [r.admin_code, 'Admin ID'], [r.admin_rfid, 'RFID'], [r.target_label, 'Target']]
                .forEach(([v, tag]) => { if (v && String(v).toLowerCase().includes(t)) add(String(v), tag); });
        });
        if (map.size < 4) {
            rows.forEach((r) => {
                const s = String(r.summary || ''), i = s.toLowerCase().indexOf(t);
                if (i < 0) return;
                const start = s.lastIndexOf(' ', i) + 1;
                const cut = s.length > start + 60;
                let piece = s.slice(start, start + 60);
                if (cut) piece = piece.replace(/\s+\S*$/, '');
                add(piece + (cut ? '\u2026' : ''), 'Details', piece);
            });
        }
        return [...map.values()];
    }

    function rankScore(label, t) {
        const l = label.toLowerCase();
        if (l.startsWith(t)) return 0;
        if (l.split(/[\s\-(]+/).some((w) => w.startsWith(t))) return 1;
        return 2;
    }

    async function buildSuggestions(term) {
        const t = term.toLowerCase();
        const items = [];
        getRecent().filter((r) => r.toLowerCase().includes(t) && r.toLowerCase() !== t).slice(0, 3)
            .forEach((r) => items.push({ kind: 'recent', label: r }));

        const pool = [];
        Object.entries(ACTIONS).forEach(([k, v]) => { if (v.label.toLowerCase().includes(t)) pool.push({ kind: 'action', label: v.label, value: k, tag: 'Action', count: 99 }); });
        Object.entries(MODULES).forEach(([k, v]) => { if (v.toLowerCase().includes(t)) pool.push({ kind: 'module', label: v, value: k, tag: 'Area', count: 99 }); });
        try { pool.push(...await fetchTextSuggestions(term)); } catch (e) { console.warn('Suggestions unavailable:', e); }
        pool.sort((a, b) => rankScore(a.label, t) - rankScore(b.label, t) || b.count - a.count || a.label.length - b.label.length);
        const seen = new Set(items.map((i) => i.label.toLowerCase()));
        for (const p of pool) { if (items.length >= 8) break; if (!seen.has(p.label.toLowerCase())) { seen.add(p.label.toLowerCase()); items.push(p); } }
        if (looksLikeQuestion(term)) items.push({ kind: 'ai', label: term });
        return items;
    }

    function renderSuggest() {
        const box = $('suggest'), input = $('searchInput');
        const show = sg.open && sg.items.length;
        box.hidden = !show;
        input.setAttribute('aria-expanded', String(!!show));
        if (!show) { input.removeAttribute('aria-activedescendant'); return; }
        const term = sg.typed.trim();
        const head = !term ? '<div class="sg-head">Recent searches</div>' : '';
        box.innerHTML = head + sg.items.map((it, i) => {
            const on = i === sg.index ? ' on' : '';
            const base = `class="sg-item ${it.kind}${on}" role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === sg.index}"`;
            if (it.kind === 'recent') return `<div ${base}><span class="sg-ico">${IC.clock}</span><span class="sg-text">${term ? emph(it.label, term) : esc(it.label)}</span><button type="button" class="sg-btn" data-remove="${i}" aria-label="Remove from recent searches" title="Remove">${IC.x}</button></div>`;
            if (it.kind === 'ai') return `<div class="sg-sep"></div><div ${base}><span class="sg-ico">${SPARK}</span><span class="sg-text">Ask AI: \u201C${esc(it.label)}\u201D</span><span class="sg-tag">AI search</span></div>`;
            return `<div ${base}><span class="sg-ico">${IC.search}</span><span class="sg-text">${emph(it.label, term)}</span><span class="sg-tag">${esc(it.tag || '')}</span><button type="button" class="sg-btn" data-insert="${i}" aria-label="Put this in the search box" title="Put in search box">${IC.fill}</button></div>`;
        }).join('');
        if (sg.index >= 0) input.setAttribute('aria-activedescendant', `sg-${sg.index}`); else input.removeAttribute('aria-activedescendant');
    }

    async function refreshSuggest() {
        const my = ++sg.req;
        const term = $('searchInput').value.trim();
        sg.typed = $('searchInput').value;
        if (!term) {
            sg.items = getRecent().map((r) => ({ kind: 'recent', label: r }));
        } else {
            sg.items = await buildSuggestions(term);
            if (my !== sg.req) return;
        }
        sg.index = -1; sg.open = true; renderSuggest();
    }
    const refreshSuggestSoon = debounce(refreshSuggest, 120);

    function closeSuggest() { sg.open = false; sg.req++; refreshSuggestSoon.cancel(); renderSuggest(); }

    function setActive(i, preview) {
        sg.index = i;
        const input = $('searchInput');
        document.querySelectorAll('#suggest .sg-item').forEach((el) => {
            const on = Number(el.dataset.i) === i; el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on));
            if (on) el.scrollIntoView({ block: 'nearest' });
        });
        if (i >= 0) input.setAttribute('aria-activedescendant', `sg-${i}`); else input.removeAttribute('aria-activedescendant');
        if (preview) {
            const it = sg.items[i];
            input.value = it && it.kind !== 'ai' ? it.label : sg.typed;   // like YouTube: the box follows the arrow keys
            $('clearSearch').hidden = !input.value;
        }
    }

    function commitText(val) {
        const input = $('searchInput');
        refreshSuggestSoon.cancel();
        input.value = val; state.q = val.trim(); state.page = 1; state.aiNote = '';
        $('clearSearch').hidden = !val;
        saveRecent(state.q); closeSuggest(); load();
    }

    function pickSuggestion(it) {
        if (!it) return;
        if (it.kind === 'ai') { closeSuggest(); runAiSearch(it.label); return; }
        if (it.kind === 'action' || it.kind === 'module') {
            // these narrow by filter, not by text
            state.q = ''; state.aiNote = ''; $('searchInput').value = ''; $('clearSearch').hidden = true;
            if (it.kind === 'action') { state.action = it.value; $('fAction').value = it.value; }
            else {
                state.module = it.value; state.page = 1;
                document.querySelectorAll('#modulePills .pill').forEach((p) => { const on = p.dataset.module === it.value; p.classList.toggle('on', on); p.setAttribute('aria-selected', String(on)); });
                moveSlider();
            }
            state.page = 1; closeSuggest(); load(); return;
        }
        commitText(it.value || it.label);
    }

    function initSuggest(runLive) {
        const input = $('searchInput'), box = $('suggest'), wrap = input.closest('.search-wrap');

        input.addEventListener('focus', refreshSuggest);
        input.addEventListener('input', () => { sg.typed = input.value; refreshSuggestSoon(); });

        input.addEventListener('keydown', (e) => {
            const n = sg.items.length;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!sg.open) { refreshSuggest(); return; }
                if (!n) return;
                let next = sg.index + (e.key === 'ArrowDown' ? 1 : -1);
                if (next >= n) next = -1; else if (next < -1) next = n - 1;
                setActive(next, true);
            } else if (e.key === 'Enter') {
                if (sg.open && sg.index >= 0) { e.preventDefault(); pickSuggestion(sg.items[sg.index]); }
                else { e.preventDefault(); runLive.cancel(); commitText(input.value); }
            } else if (e.key === 'Escape') {
                if (sg.open) { e.preventDefault(); input.value = sg.typed; closeSuggest(); }
            } else if (e.key === 'Tab') closeSuggest();
        });

        box.addEventListener('mousedown', (e) => e.preventDefault());           // keep focus in the input
        box.addEventListener('mouseover', (e) => { const el = e.target.closest('.sg-item'); if (el) setActive(Number(el.dataset.i), false); });
        box.addEventListener('click', (e) => {
            const rm = e.target.closest('[data-remove]');
            if (rm) { removeRecent(sg.items[Number(rm.dataset.remove)].label); refreshSuggest(); return; }
            const ins = e.target.closest('[data-insert]');
            if (ins) {
                const it = sg.items[Number(ins.dataset.insert)];
                input.value = it.kind === 'text' ? it.value : it.label; sg.typed = input.value; $('clearSearch').hidden = false;
                input.focus(); refreshSuggest(); return;
            }
            const el = e.target.closest('.sg-item'); if (el) pickSuggestion(sg.items[Number(el.dataset.i)]);
        });
        wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) closeSuggest(); });
        document.addEventListener('mousedown', (e) => { if (sg.open && !wrap.contains(e.target)) closeSuggest(); });
    }

    /* ---------------- Details dialog ---------------- */
    let showUnchanged = false;
    let openRow = null;
    let moreTimer = 0;
    const CHEV = '<svg class="chev" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    function openDetails(row) {
        openRow = row; showUnchanged = false;
        clearTimeout(moreTimer);
        const a = actionInfo(row.action);
        $('dtAvatar').textContent = initials(row.admin_name);
        $('dtAdmin').textContent = row.admin_name;
        const badge = $('dtBadge'); badge.textContent = a.label; badge.className = `badge ${a.tone}`;
        $('dtWhen').textContent = `${fmtDate(row.created_at)} at ${fmtTime(row.created_at, true)}`;
        $('dtCode').textContent = row.admin_code;
        $('dtRfid').textContent = row.admin_rfid || 'Not recorded';
        $('dtWhat').textContent = row.summary;
        renderDiff();
        const dlg = $('detailDialog');
        if (!dlg.open) dlg.showModal();
        $('dtDiffWrap').scrollTop = 0;
        $('dtDone').focus();
    }

    function renderDiff() {
        const diff = buildDiff(openRow.before_data, openRow.after_data);
        const changed = diff.filter((d) => d.changed);
        const same = diff.filter((d) => !d.changed);
        const isCreate = !openRow.before_data && openRow.after_data;

        $('dtDiffTitle').textContent = changed.length
            ? `${changed.length} ${changed.length === 1 ? 'field' : 'fields'} ${isCreate ? 'recorded' : 'changed'}`
            : 'Changes';

        const empty = $('dtEmpty'), wrap = $('dtDiffWrap');
        if (!diff.length) {
            wrap.hidden = true; $('dtToggle').hidden = true;
            empty.hidden = false;
            empty.textContent = 'This action doesn\u2019t change any saved fields, so there are no before and after values.';
            return;
        }
        wrap.hidden = false; empty.hidden = true;

        const row = (d, i, cls) => `<tr class="${cls}" style="--i:${Math.min(i, 10)}">
            <td class="field-name">${esc(humanize(d.key))}</td>
            <td class="v-before">${formatValue(d.key, d.before)}</td>
            <td class="v-after">${formatValue(d.key, d.after)}</td>
        </tr>`;
        $('dtDiffRows').innerHTML = changed.length
            ? changed.map((d, i) => row(d, i, '')).join('')
            : '<tr><td colspan="3" class="diff-none">Nothing was changed in this action.</td></tr>';
        // unchanged rows always sit in the collapsible block; opening it animates their height
        $('dtSameRows').innerHTML = same.map((d, i) => row(d, i, 'same')).join('');

        const toggle = $('dtToggle');
        toggle.hidden = !same.length;
        setUnchanged(false, true);
    }

    function setUnchanged(open, instant) {
        showUnchanged = open;
        const more = $('dtMore'), toggle = $('dtToggle');
        more.classList.toggle('open', open);
        more.setAttribute('aria-hidden', String(!open));
        toggle.setAttribute('aria-expanded', String(open));
        toggle.innerHTML = `${open ? 'Hide' : 'Show'} unchanged fields ${CHEV}`;
        if (open && !instant) {
            // once the block has grown, glide the list down so the new rows are in view
            clearTimeout(moreTimer);
            moreTimer = setTimeout(() => {
                const wrap = $('dtDiffWrap');
                wrap.scrollTo({ top: Math.max(0, more.offsetTop - 56), behavior: 'smooth' });
            }, 260);
        }
    }

    /* ---------------- Export ---------------- */
    function csvCell(v) {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    // keep secret-looking fields out of the file too
    function safeJson(obj) {
        if (!obj) return '';
        const copy = {};
        Object.keys(obj).forEach((k) => { copy[k] = SECRET_KEYS.test(k) ? '****' : obj[k]; });
        return JSON.stringify(copy);
    }

    async function exportCsv() {
        const btn = $('exportBtn'); btn.disabled = true;
        try {
            const { rows } = await query({ all: true });
            const head = ['Date & time', 'Admin ID', 'RFID', 'Admin name', 'Area', 'Action', 'Details', 'Before', 'After'];
            const lines = [head.map(csvCell).join(',')];
            rows.forEach((r) => lines.push([
                `${fmtDate(r.created_at)} ${fmtTime(r.created_at, true)}`,
                r.admin_code, r.admin_rfid || '', r.admin_name,
                MODULES[r.module] || r.module, actionInfo(r.action).label, r.summary,
                safeJson(r.before_data), safeJson(r.after_data)
            ].map(csvCell).join(',')));
            const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `tapmate-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast(`Exported ${rows.length.toLocaleString()} ${rows.length === 1 ? 'entry' : 'entries'}`);
        } catch (err) {
            console.error(err); toast('Could not export the logs. Try again.', true);
        } finally { btn.disabled = !state.total; }
    }

    /* ---------------- Banner + toast ---------------- */
    function showBanner(msg, info) {
        const b = $('banner'); b.textContent = msg; b.classList.toggle('info', !!info); b.hidden = false;
    }
    function hideBanner() { if (sb) $('banner').hidden = true; }

    let toastTimer;
    function toast(msg, isErr) {
        const t = $('toast');
        t.textContent = msg; t.classList.toggle('err', !!isErr); t.classList.remove('out'); t.hidden = false;
        try { t.hidePopover(); } catch (e) { /* not open */ }
        try { t.showPopover(); } catch (e) { /* popover unsupported */ }
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            t.classList.add('out');
            setTimeout(() => { try { t.hidePopover(); } catch (e) { } t.hidden = true; }, 300);
        }, 3000);
    }

    /* ---------------- Pills (sliding highlight) ---------------- */
    function moveSlider(first) {
        const on = document.querySelector('#modulePills .pill.on');
        const s = $('pillSlider');
        if (!on) return;
        s.style.width = on.offsetWidth + 'px';
        s.style.transform = `translateX(${on.offsetLeft}px)`;
        if (first) requestAnimationFrame(() => s.classList.add('ready'));
    }

    /* ---------------- Sidebar ---------------- */
    function initSidebar() {
        const app = $('app'), scrim = $('scrim');
        const KEY = 'tm_sidebar_collapsed';
        try { if (localStorage.getItem(KEY) === '1') app.classList.add('collapsed'); } catch (e) { }
        const sync = () => {
            const c = app.classList.contains('collapsed');
            $('collapseBtn').setAttribute('aria-expanded', String(!c));
            $('collapseBtn').setAttribute('aria-label', c ? 'Expand sidebar' : 'Collapse sidebar');
        };
        sync();
        $('collapseBtn').addEventListener('click', () => {
            if (window.matchMedia('(max-width: 860px)').matches) { closeDrawer(); return; }
            app.classList.toggle('collapsed'); sync();
            try { localStorage.setItem(KEY, app.classList.contains('collapsed') ? '1' : '0'); } catch (e) { }
        });
        const openDrawer = () => { app.classList.add('drawer-open'); scrim.hidden = false; };
        function closeDrawer() { app.classList.remove('drawer-open'); scrim.hidden = true; }
        $('menuBtn').addEventListener('click', openDrawer);
        scrim.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && app.classList.contains('drawer-open')) closeDrawer(); });

        $('profileBtn').setAttribute('href', PROFILE_PORTAL_URL);
        $('logoutBtn').addEventListener('click', async () => {
            try { sessionStorage.removeItem('tapmate_session'); } catch (e) { }
            window.location.href = LOGIN_URL;
        });
    }

    // Shows who is signed in. Adjust if your admin name lives somewhere else.
    async function initProfile() {
        if (!sb) { $('pfName').textContent = 'Maria Santos'; $('pfAvatar').textContent = 'MS'; return; }
        try {
            const { data } = await sb.rpc('card_session', { p_token: cardToken() });
            const name = (data && (data.full_name || data.name)) || 'Admin';
            $('pfName').textContent = name; $('pfAvatar').textContent = initials(name);
        } catch (e) { /* keep defaults */ }
    }

    /* ---------------- Wiring ---------------- */
    function setPage(p) { state.page = p; load(); $('resultsTitle').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }

    function resetFilters() {
        Object.assign(state, { module: '', action: '', admin: '', from: '', to: '', q: '', page: 1, actions: [], modules: [], ids: null, riskFilter: '', aiNote: '', aiQuery: '' });
        syncControls(); renderAiPanel(); load();
    }

    function init() {
        initSidebar(); initProfile();

        // action filter options
        $('fAction').insertAdjacentHTML('beforeend',
            Object.entries(ACTIONS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join(''));
        loadAdmins();

        // pills
        $('modulePills').addEventListener('click', (e) => {
            const b = e.target.closest('.pill'); if (!b) return;
            document.querySelectorAll('#modulePills .pill').forEach((p) => {
                const on = p === b; p.classList.toggle('on', on); p.setAttribute('aria-selected', String(on));
            });
            state.module = b.dataset.module; state.modules = []; state.aiNote = ''; state.page = 1; moveSlider(); load();
        });
        moveSlider(true);
        window.addEventListener('resize', () => moveSlider());
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveSlider());

        // search
        const input = $('searchInput');
        const run = debounce(() => { state.q = input.value.trim(); state.page = 1; state.aiNote = ''; load(); }, 250);
        input.addEventListener('input', () => { $('clearSearch').hidden = !input.value; run(); });
        $('clearSearch').addEventListener('click', () => { input.value = ''; $('clearSearch').hidden = true; state.q = ''; state.page = 1; state.aiNote = ''; load(); input.focus(); });
        initSuggest(run);

        // filters
        $('fAction').addEventListener('change', (e) => { state.action = e.target.value; state.actions = []; state.aiNote = ''; state.page = 1; load(); });
        $('fAdmin').addEventListener('change', (e) => { state.admin = e.target.value; state.page = 1; load(); });
        $('fFrom').addEventListener('change', (e) => {
            state.from = e.target.value;
            if (state.to && state.from > state.to) { state.to = state.from; $('fTo').value = state.to; }
            state.page = 1; load();
        });
        $('fTo').addEventListener('change', (e) => {
            state.to = e.target.value;
            if (state.from && state.to < state.from) { state.from = state.to; $('fFrom').value = state.from; }
            state.page = 1; load();
        });
        $('resetBtn').addEventListener('click', resetFilters);

        // table + pager
        $('rows').addEventListener('click', (e) => {
            const b = e.target.closest('[data-view],[data-investigate]'); if (!b) return;
            if (b.dataset.investigate) { if (!investigate(b.dataset.investigate)) toast('No open incident found for this entry.', true); return; }
            const id = b.dataset.view;
            const row = state.rows.find((r) => String(r.id) === id);
            if (row) openDetails(row);
        });
        $('pager').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-page]'); if (!b || b.disabled) return;
            setPage(Number(b.dataset.page));
        });
        $('pager').addEventListener('change', (e) => { if (e.target.id === 'pgSize') changePageSize(Number(e.target.value)); });
        $('pager').addEventListener('keydown', (e) => {
            if (e.target.id !== 'pgJump' || e.key !== 'Enter') return;
            const max = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
            const n = Math.min(max, Math.max(1, parseInt(e.target.value, 10) || 0));
            if (n) setPage(n);
        });

        // dialog
        $('dtClose').addEventListener('click', () => $('detailDialog').close());
        $('dtDone').addEventListener('click', () => $('detailDialog').close());
        $('detailDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
        $('dtToggle').addEventListener('click', () => setUnchanged(!showUnchanged));

        // AI panel + related-logs bar
        try { if (localStorage.getItem(AI_COLLAPSE_KEY) === '1') setAiCollapsed(true, true); } catch (e) { }
        $('aiTitle').addEventListener('click', () => setAiCollapsed(!aiIsCollapsed()));
        renderAiPanel();
        $('aiAnalyze').addEventListener('click', () => { ai.scope = null; analyze(); });
        $('aiBody').addEventListener('click', (e) => {
            const stat = e.target.closest('[data-risk]');
            if (stat && !stat.disabled) { focusRisk(stat.dataset.risk); return; }
            const hide = e.target.closest('[data-res-hide]');
            if (hide) { hiddenRes.add(String(hide.dataset.resHide)); saveHidden(); renderAiPanel(); return; }
            if (e.target.closest('[data-res-clear]')) {
                [...(ai.data.resolved || []), ...(ai.data.dismissed || [])].forEach((c) => hiddenRes.add(String(c.id)));
                saveHidden(); renderAiPanel(); return;
            }
            const chg = e.target.closest('[data-chg]');
            if (chg) { toggleChanges(chg.dataset.chg); return; }
            const act = e.target.closest('[data-inc]');
            if (act) { askIncident(act.dataset.inc, act.dataset.status); return; }
            const b = e.target.closest('[data-related]'); if (!b) return;
            showRelated(b.dataset.related.split(','));
        });
        $('incSave').addEventListener('click', saveIncident);
        $('incCancel').addEventListener('click', () => $('incDialog').close());
        $('relatedBar').addEventListener('click', (e) => {
            const b = e.target.closest('[data-clear]'); if (!b) return;
            if (b.dataset.clear === 'ids') { state.ids = null; state.riskFilter = ''; state.page = 1; renderAiPanel(); load(); } else resetFilters();
        });

        $('exportBtn').addEventListener('click', exportCsv);

        if (!sb) showBanner('Showing sample data. Add your Supabase URL and key at the top of adminauditlogs.js to see real activity.', true);
        requireAdmin().then((ok) => {
            if (!ok) { window.location.replace(LOGIN_URL); return; }
            load();
        });
    }

    init();
})();
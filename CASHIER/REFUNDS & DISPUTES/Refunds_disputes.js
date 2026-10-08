(() => {
    'use strict';

    /* ============================================================
       SETTINGS - the only part you need to edit.
       ============================================================ */
    const CONFIG = {
        supabaseUrl: 'https://inoafkspgsxzxarzboqq.supabase.co',
        supabaseKey: 'sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z',
        tokenStorageKey: '',        // name your account page uses to save the RFID login token (optional)
        sessionKey: 'tapmate_session', // same session the student page uses (optional, used for name/email/token)
        // Where cashiers go when not logged in / after log out. Paths are relative to this page and tried in
        // order; the first page that exists wins. Put your REAL login page first, e.g. '../LOGIN/Login.html'.
        loginPages: [
            'login.html', 'Login.html', 'index.html',
            '../LOGIN/login.html', '../LOGIN/Login.html', '../LOGIN/index.html',
            '../login.html', '../index.html',
            '../../LOGIN/login.html', '../../LOGIN/index.html', '../../index.html'
        ],
        kioskScheme: 'tapmate-kiosk', // desktop kiosk program (registered by TapMateKiosk/install.bat)
        storeName: 'TapMate',
        // Logo paths are tried in order; the first one that loads wins. Put your real path first.
        logo: [
            '../REGISTER (KIOSK)/Assets/tapmate logo.png',
            'Assets/tapmate logo.png',
            'assets/tapmate logo.png',
            '../LOGIN/assets/tapmate logo.png',
            '../../LOGIN/assets/tapmate logo.png'
        ],
        listRpc: 'cashier_transactions',   // returns every kiosk purchase (see Refunds_disputes.sql)
        refundRpc: 'cashier_issue_refund', // refunds one purchase (p_token, p_purchase_id, p_reason, p_amount, ...)
        requestsRpc: 'staff_refund_requests',        // student refund requests (Refunds_disputesv6.sql)
        requestRpc: 'staff_refund_request_detail',   // one request, with the photo
        reviewRpc: 'staff_review_refund_request',    // approve / reject
        aiFunction: 'refund-ai',                     // Supabase edge function (index.ts)
        pollMs: 5000,
        pageSize: 10,
        pinRpc: 'student_change_pin', // RPC that changes a card PIN (p_token, p_current, p_new)
        currency: '₱',
        cabinet: [                  // each module is its own page; icon: register | refunds | analytics | audit
            { label: 'Register', href: '../REGISTER (KIOSK)/Register.html', icon: 'register' },
            { label: 'Refunds & disputes', href: 'Refunds_disputes.html', icon: 'refunds' },
            { label: 'Items sold analytics', href: 'Analytics.html', icon: 'analytics' },
            { label: 'Audit logs', href: 'AuditLogs.html', icon: 'audit' }
        ]
    };
    /* ============================================================ */

    const $ = id => document.getElementById(id);
    const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
    const ICON = {
        register: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
        refunds: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
        analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
        audit: '<path d="M9 3h6l1 2h3v16H5V5h3z"/><path d="M9 12h6M9 16h4"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        bag: '<path d="M6 8h12l-1 12H7z"/><path d="M9 8a3 3 0 0 1 6 0"/>'
    };
    const svg = d => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[d] || ICON.register}</svg>`;

    const COLLAPSE_KEY = 'tm_cabinet_collapsed';
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (_) { } }
    };
    const state = { tx: [], ok: true, loaded: false, rq: [], rqOk: true, tab: 'requests', q: '', page: 1, sig: '' };
    const BASE = CONFIG.supabaseUrl.replace(/\/$/, '');
    const session = () => { try { return JSON.parse(sessionStorage.getItem(CONFIG.sessionKey) || 'null'); } catch (_) { return null; } };
    const getToken = () => (CONFIG.tokenStorageKey
        ? (sessionStorage.getItem(CONFIG.tokenStorageKey) || localStorage.getItem(CONFIG.tokenStorageKey)) : null)
        || (session() && session().token) || null;

    const setStatus = (msg, err) => { $('status').textContent = msg; $('status').classList.toggle('error', !!err); };
    const money = n => `${CONFIG.currency}${(Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let tm; const toast = m => { const t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tm); tm = setTimeout(() => t.classList.remove('show'), 2200); };

    async function api(path) {
        const headers = { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}` };
        const tok = getToken(); if (tok) headers['x-card-token'] = tok;
        const res = await fetch(`${BASE}/rest/v1/${path}`, { headers });
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        return res.json();
    }

    async function rpc(name, args = {}) {
        const res = await fetch(`${BASE}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_token: getToken(), ...args })
        });
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        return res.json();
    }

    /* ---------- Cabinet ---------- */
    const mq = window.matchMedia('(max-width:1000px)');
    const toggleCabinet = open => {
        $('cabinet').classList.toggle('open', open); $('scrim').hidden = !open;
        $('cabinetBtn').setAttribute('aria-expanded', open);
    };
    function identity() {
        const s = session() || {}, p = s.profile || s.user || s;
        return { name: p.full_name || p.name || 'Cashier', email: p.email || '', role: p.role || 'Cashier', avatar: p.avatar_url || '' };
    }
    const initials = n => n.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
    function paintAvatar(node, id) {
        node.textContent = '';
        if (id.avatar) {
            const img = new Image(); img.alt = ''; img.src = id.avatar;
            img.onerror = () => { img.remove(); node.textContent = initials(id.name); };
            node.append(img);
        } else node.textContent = initials(id.name);
    }
    function renderIdentity() {
        const id = identity();
        $('sideName').textContent = id.name; $('sideRole').textContent = id.role;
        $('pfName').textContent = id.name; $('pfEmail').textContent = id.email; $('pfRole').textContent = id.role;
        paintAvatar($('sideAv'), id); paintAvatar($('pfAv'), id);
    }
    function setupChrome() {
        document.title = `${CONFIG.storeName} Refunds & disputes`;
        const logo = $('logo');
        const srcs = [].concat(CONFIG.logo || []).map(encodeURI);
        let i = 0;
        logo.alt = CONFIG.storeName;
        logo.onerror = () => {
            if (++i < srcs.length) logo.src = srcs[i];
            else logo.replaceWith(el('b', { className: 'logo-text', textContent: CONFIG.storeName }));
        };
        if (srcs.length) logo.src = srcs[0]; else logo.onerror();
        const here = location.pathname.split('/').pop() || 'Refunds_disputes.html';
        $('cabinetLinks').replaceChildren(...CONFIG.cabinet.map(l => {
            const a = el('a', { href: l.href, title: l.label });
            a.innerHTML = svg(l.icon);
            a.append(el('span', { className: 'lbl', textContent: l.label }));
            if (l.href === here) a.setAttribute('aria-current', 'page');
            return a;
        }));
        if (store.get(COLLAPSE_KEY) === '1') $('app').classList.add('collapsed');
        requestAnimationFrame(() => $('app').classList.remove('init'));
        renderIdentity();
    }
    $('collapse').onclick = () => {
        const c = $('app').classList.toggle('collapsed');
        store.set(COLLAPSE_KEY, c ? '1' : '0');
        $('collapse').setAttribute('aria-expanded', !c);
        $('collapse').setAttribute('aria-label', c ? 'Expand menu' : 'Collapse menu');
    };
    $('cabinetBtn').onclick = () => toggleCabinet(!$('cabinet').classList.contains('open'));
    $('scrim').onclick = () => toggleCabinet(false);
    $('logout').onclick = async () => {
        const t = getToken();
        if (t) { try { await fetch(`${BASE}/rest/v1/rpc/card_logout`, { method: 'POST', headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_token: t }) }); } catch (_) { } }
        try {
            sessionStorage.removeItem(CONFIG.sessionKey);
            if (CONFIG.tokenStorageKey) { sessionStorage.removeItem(CONFIG.tokenStorageKey); localStorage.removeItem(CONFIG.tokenStorageKey); }
        } catch (_) { }
        goLogin();
    };
    async function goLogin() {
        for (const p of CONFIG.loginPages) {
            try {
                const r = await fetch(p, { method: 'HEAD', cache: 'no-store' });
                if (r.ok) return location.replace(p);
            } catch (_) { return location.replace(CONFIG.loginPages[0]); }   // can't probe (e.g. file://): trust the first path
        }
        setStatus('Could not find the login page. Put its real path first in loginPages (top of Refunds_disputes.js).', true);
    }

    /* ---------- Modals (smooth open / close, same as the student wallet) ---------- */
    function openModal(m) {
        m._ret = document.activeElement; m.hidden = false;
        requestAnimationFrame(() => m.classList.add('open'));
        const f = m.querySelector('[data-focus]') || m.querySelector('input:not([disabled])') || m.querySelector('[data-close]');
        setTimeout(() => f && f.focus(), 60);
    }
    function closeModal(m) {
        m.classList.remove('open');
        setTimeout(() => { m.hidden = true; }, 260);
        if (m._ret && m._ret.focus) { try { m._ret.focus(); } catch (_) { } }
    }
    let cfResolve = null;
    function ask(title, text, yes) {
        $('cfTitle').textContent = title; $('cfText').textContent = text; $('cfOk').textContent = yes || 'Confirm';
        openModal($('confirm'));
        return new Promise(r => { cfResolve = r; });
    }
    function answer(v) { closeModal($('confirm')); const r = cfResolve; cfResolve = null; if (r) r(v); }
    $('cfBack').onclick = () => answer(false);
    $('cfOk').onclick = () => answer(true);

    /* ---------- Profile: cashiers can only change their PIN (name/email/role are the admin's job) ---------- */
    const pf = $('profile');
    const pinIds = ['pinCur', 'pinNew', 'pinNew2'];
    const setErr = (node, msg) => { node.textContent = msg || ''; node.hidden = !msg; };
    const resetPin = () => { $('pinForm').reset(); setErr($('pinMsg'), ''); };
    const closeProfile = () => { resetPin(); closeModal(pf); };
    function renderPin(p) {
        if (!p) return;
        const out = p.remaining <= 0;
        $('pinRemaining').textContent = `PIN changes remaining: ${p.remaining}/${p.limit}`;
        $('pinNote').textContent = `You can change your PIN up to ${p.limit} times within a 24-hour period.`;
        $('pinMeter').hidden = out; $('pinLimit').hidden = !out;
        $('pinLimitText').textContent = `You have reached the maximum of ${p.limit} PIN changes within 24 hours. You can change your PIN again after the cooldown period ends`
            + (p.next_available_at ? ` (${new Date(p.next_available_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}).` : '.');
        pinIds.concat('pinSave').forEach(id => { $(id).disabled = out; });
    }
    $('openProfile').onclick = () => { resetPin(); openModal(pf); };
    pf.querySelector('[data-close]').onclick = closeProfile;
    pf.addEventListener('mousedown', e => { if (e.target === pf) closeProfile(); });
    pinIds.forEach(id => $(id).addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 4); }));

    $('pinForm').addEventListener('submit', async e => {
        e.preventDefault();
        const cur = $('pinCur').value, n1 = $('pinNew').value, n2 = $('pinNew2').value;
        const msg = cur.length !== 4 ? 'Enter your current 4-digit PIN.'
            : n1.length !== 4 ? 'Your new PIN must be exactly 4 digits.'
                : n1 === cur ? 'Your new PIN must be different from your current PIN.'
                    : n1 !== n2 ? "The new PINs don't match." : '';
        setErr($('pinMsg'), msg);
        if (msg) return;
        if (!getToken()) return setErr($('pinMsg'), 'Your session has expired. Please log in again.');
        if (!await ask('Change your PIN?', 'This uses 1 of your PIN changes for this 24-hour period.', 'Change PIN')) return;
        let r;
        try {
            const res = await fetch(`${BASE}/rest/v1/rpc/${CONFIG.pinRpc}`, {
                method: 'POST',
                headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ p_token: getToken(), p_current: cur, p_new: n1 })
            });
            if (!res.ok) throw new Error(res.status);
            r = (await res.json()) || {};
        } catch (err) { console.error(err); return setErr($('pinMsg'), "Can't reach TapMate right now. Please try again."); }
        if (r.ok) {
            if (r.remaining != null) renderPin({ remaining: r.remaining, limit: r.limit || 3, next_available_at: r.next_available_at });
            resetPin(); toast('PIN changed.'); return;
        }
        const M = {
            session: 'Your session has expired. Please log in again.',
            wrong_pin: 'Your current PIN is incorrect.', locked: 'Too many wrong PINs. Try again in a few minutes.',
            limit: 'PIN change limit reached. Try again later.',
            format: 'Your new PIN must be exactly 4 digits.', same: 'Your new PIN must be different from your current PIN.',
            no_pin: 'No PIN is set yet. Ask an admin to set one.'
        };
        setErr($('pinMsg'), M[r.reason] || 'Could not change your PIN.');
    });
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        const open = [...document.querySelectorAll('.modal.open')].pop();
        if (open) { if (open.id === 'confirm') answer(false); else closeProfile(); }
        else toggleCabinet(false);
    });

    /* ---------- Search ---------- */
    const input = $('search');
    const apply = q => { state.q = q; state.page = 1; $('searchClear').hidden = !q; renderList(); };
    input.oninput = () => apply(input.value);
    input.onkeydown = e => { if (e.key === 'Escape' && input.value) { input.value = ''; apply(''); e.stopPropagation(); } };
    $('searchClear').onclick = () => { input.value = ''; apply(''); input.focus(); };

    /* ---------- Transactions ---------- */
    const TABS = [['requests', 'Requests'], ['refunds', 'Refunds'], ['completed', 'Completed'], ['rejected', 'Rejected']];
    const methodLabel = m => m === 'paylater' ? 'Pay Later' : 'RFID wallet';
    const when = iso => iso ? new Date(iso).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
    const itemsOf = t => Array.isArray(t.items) ? t.items : [];
    const countTab = k => k === 'requests' ? state.rq.filter(r => r.status === 'pending').length
        : k === 'rejected' ? state.rq.filter(r => r.status === 'rejected').length
            : state.tx.filter(t => k === 'completed' ? t.refunded : !t.refunded).length;

    let tabKey = '';
    function moveInd() {
        const host = $('tabs'), ind = host.querySelector('.tab-ind'), sel = host.querySelector('[aria-selected="true"]');
        if (!ind || !sel || !sel.offsetWidth) return;
        ind.style.width = sel.offsetWidth + 'px';
        ind.style.transform = `translateX(${sel.offsetLeft}px)`;
        if (ind.classList.contains('no-anim')) requestAnimationFrame(() => requestAnimationFrame(() => ind.classList.remove('no-anim')));
    }
    function renderTabs() {
        const host = $('tabs'), key = JSON.stringify(TABS.map(([k]) => countTab(k)));
        if (key !== tabKey) {
            tabKey = key;
            const ind = el('i', { className: 'tab-ind no-anim' }); ind.setAttribute('aria-hidden', 'true');
            host.replaceChildren(ind, ...TABS.map(([k, name]) => {
                const b = el('button', { role: 'tab', type: 'button' }, name, el('small', { textContent: countTab(k) }));
                b._k = k;
                b.onclick = () => { state.tab = k; state.page = 1; renderTabs(); renderList(); };
                return b;
            }));
        }
        host.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b._k === state.tab));
        moveInd();
        if (typeof renderSummary === 'function') renderSummary();
    }
    window.addEventListener('resize', moveInd);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);

    const isReqTab = () => state.tab === 'requests' || state.tab === 'rejected';
    function visible() {
        const q = state.q.trim().toLowerCase();
        const hit = (...v) => !q || v.some(x => String(x || '').toLowerCase().includes(q));
        if (isReqTab()) {
            const want = state.tab === 'requests' ? 'pending' : 'rejected';
            return state.rq.filter(r => r.status === want && hit(r.reference, r.student_name, r.student_id, r.reason, ...itemsOf(r).map(i => i.name)));
        }
        return state.tx.filter(t => {
            if (state.tab === 'refunds' && t.refunded) return false;
            if (state.tab === 'completed' && !t.refunded) return false;
            return hit(t.reference, t.customer_name, ...itemsOf(t).map(i => i.name));
        });
    }

    /* A student's refund request, shown in the same table layout */
    function reqRow(r) {
        const lines = itemsOf(r).map(i => el('div', { className: 'it' }, el('span', { textContent: `${i.name} ×${i.qty}` })));
        const sim = r.ai_similarity ? el('span', { className: 'sim ' + String(r.ai_similarity).toLowerCase(), textContent: `AI photo match: ${r.ai_similarity}` }) : null;
        const b = el('button', { className: 'btn-fill', type: 'button', textContent: r.status === 'pending' ? 'Review' : 'View' });
        b.setAttribute('aria-label', `Review refund request ${r.reference}`);
        b.onclick = () => openReview(r, b);
        return el('li', { className: 'tx-row req', role: 'row' },
            el('div', { className: 'ref', textContent: r.reference || '–' }),
            el('div', { className: 'cust' }, r.student_name || 'Student', el('small', { className: 'sid', textContent: r.student_id || '' })),
            el('div', { className: 'its' }, ...lines, el('div', { className: 'why', textContent: `“${r.reason}”` }), ...(sim ? [sim] : []),
                ...(r.sale_refunded && r.status === 'pending' ? [el('span', { className: 'sim already', textContent: 'Already refunded at the counter' })] : [])),
            el('div', { className: 'when', textContent: when(r.created_at) }),
            el('div', { className: 'price r' }, el('b', { textContent: money(Number(r.amount)) }), el('small', { textContent: methodLabel(r.method) })),
            el('div', { className: 'act r' }, b));
    }

    function row(t) {
        const lines = itemsOf(t).map(i => el('div', { className: 'it' }, el('span', { textContent: `${i.name} ×${i.qty}` })));
        const act = el('div', { className: 'act r' });
        if (t.refunded) act.append(el('span', { className: 'badge-rf', textContent: 'Refunded', title: t.refunded_at ? `Refunded ${when(t.refunded_at)}` : '' }));
        else {
            const b = el('button', { className: 'btn-fill', type: 'button', textContent: 'Issue refund' });
            b.setAttribute('aria-label', `Issue refund for ${t.reference}`);
            b.onclick = () => openRefund(t, b);
            act.append(b);
        }
        return el('li', { className: 'tx-row' + (t.refunded ? ' refunded' : ''), role: 'row' },
            el('div', { className: 'ref', textContent: t.reference || '–' }),
            el('div', { className: 'cust', textContent: t.customer_name || 'Walk-in' }),
            el('div', { className: 'its' }, ...(lines.length ? lines : [el('span', { textContent: 'Purchase' })])),
            el('div', { className: 'when', textContent: when(t.created_at) }),
            el('div', { className: 'price r' }, el('b', { textContent: money(Number(t.total)) }), el('small', { textContent: methodLabel(t.method) })),
            act);
    }

    function renderList() {
        const list = visible(), size = CONFIG.pageSize, pages = Math.max(Math.ceil(list.length / size), 1);
        const req = isReqTab();
        $('rsum').hidden = req;
        $('colCust').textContent = req ? 'Student' : 'Customer';
        $('colItems').textContent = req ? 'Items & reason' : 'Purchased item & amount';
        $('colWhen').textContent = req ? 'Requested' : 'Date & time';
        if (state.page > pages) state.page = pages;
        const label = TABS.find(([k]) => k === state.tab)[1];
        $('secTitle').textContent = state.q.trim() ? `Results for “${state.q.trim()}”`
            : state.tab === 'requests' ? 'Student refund requests' : state.tab === 'rejected' ? 'Rejected requests' : `${label} transactions`;
        const noun = req ? 'request' : 'transaction';
        $('secCount').textContent = `${list.length} ${noun}${list.length === 1 ? '' : 's'}`;
        if (req && !state.rqOk) setStatus("Refund requests aren't available yet. Run Refunds_disputesv6.sql in Supabase.", true);
        else if (!req && !state.ok) setStatus("Transactions aren't available yet. Run Refunds_disputes.sql in Supabase.", true);
        else setStatus('');
        const slice = list.slice((state.page - 1) * size, state.page * size);
        $('txList').replaceChildren(...(slice.length ? slice.map(req ? reqRow : row) : [el('li', {
            className: 'tx-empty', textContent:
                !state.loaded ? 'Loading…'
                    : req ? (state.q.trim() ? 'No requests match.' : state.tab === 'requests' ? 'No pending refund requests. Student requests will show up here.' : 'No rejected requests.')
                        : !state.tx.length ? 'No purchases yet. Everything bought at the kiosk will show up here.'
                            : 'No transactions match.'
        })]));
        renderPager(pages, list.length);
    }

    function renderPager(pages, total) {
        const nav = $('pages'); nav.replaceChildren();
        nav.hidden = !total; if (!total) return;
        const size = CONFIG.pageSize, from = (state.page - 1) * size + 1, to = Math.min(state.page * size, total);
        const go = page => { state.page = page; renderList(); document.querySelector('.panel').scrollIntoView({ block: 'start', behavior: 'smooth' }); };
        const btn = (label, page, o = {}) => {
            const b = el('button', { className: 'pg' + (o.cur ? ' cur' : ''), type: 'button', textContent: label, disabled: !!o.off });
            if (o.aria) b.setAttribute('aria-label', o.aria);
            if (o.cur) b.setAttribute('aria-current', 'page');
            b.onclick = () => go(page);
            nav.append(b);
        };
        btn('‹', state.page - 1, { aria: 'Previous page', off: state.page === 1 });
        // sliding window of up to 5 page numbers: 1 2 3 4 5, then 2 3 4 5 6 ...
        let lo = Math.max(1, Math.min(state.page - 2, pages - 4)), hi = Math.min(pages, lo + 4);
        for (let n = lo; n <= hi; n++) btn(String(n), n, { cur: n === state.page, aria: `Page ${n}` });
        btn('›', state.page + 1, { aria: 'Next page', off: state.page === pages });
        nav.append(el('span', { className: 'pg-info', textContent: `Showing ${from}–${to} of ${total}` }));
    }

    /* ---------- Refund reports: refunds per day, by week (+ CSV download) ---------- */
    const DAY = 864e5;
    const dkey = d => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const weekStart = (d, off = 0) => { const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + off * 7); return s; };
    const refundAmt = t => Number(t.refunded_amount != null ? t.refunded_amount : t.total) || 0;
    const fmtD = (d, o) => d.toLocaleDateString('en-PH', o);
    let wkOff = 0;

    /* Lines that were actually refunded in a sale. A full refund = every line; a partial refund = the lines whose
       totals add up to the refunded amount (falls back to every line if that can't be worked out). */
    function refundedLines(t) {
        const its = itemsOf(t); if (!its.length) return [];
        const amt = refundAmt(t), tot = its.reduce((s, i) => s + lineTotal(i), 0);
        if (Math.abs(amt - tot) < 0.005 || its.length > 12) return its;
        for (let m = 1; m < (1 << its.length); m++) {
            let s = 0; its.forEach((i, b) => { if (m >> b & 1) s += lineTotal(i); });
            if (Math.abs(s - amt) < 0.005) return its.filter((_, b) => m >> b & 1);
        }
        return its;
    }
    /* Most refunded items across a set of refunded sales (ranked by units refunded) */
    function topRefunded(list) {
        const c = {};
        list.forEach(t => refundedLines(t).forEach(i => { if (i.name) c[i.name] = (c[i.name] || 0) + (Number(i.qty) || 1); }));
        return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
    }
    function renderSummary() {
        const now = new Date(), todayK = dkey(now);
        const per = {};                                   // day key -> { n, amt }
        state.tx.forEach(t => {
            if (!t.refunded || !t.refunded_at) return;
            const k = dkey(new Date(t.refunded_at)); const o = per[k] || (per[k] = { n: 0, amt: 0, tx: [] });
            o.n++; o.amt += refundAmt(t); o.tx.push(t);
        });
        const sumWeek = off => { const s = weekStart(now, off); let n = 0, amt = 0; for (let i = 0; i < 7; i++) { const o = per[dkey(new Date(s.getFullYear(), s.getMonth(), s.getDate() + i))]; if (o) { n += o.n; amt += o.amt; } } return { n, amt }; };
        const start = weekStart(now, wkOff), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
        $('rsRange').textContent = `${fmtD(start, { month: 'short', day: 'numeric' })} – ${fmtD(end, { month: 'short', day: 'numeric', year: 'numeric' })}` + (wkOff === 0 ? ' · this week' : wkOff === -1 ? ' · last week' : wkOff === 1 ? ' · next week' : '');
        $('rsNow').disabled = wkOff === 0;

        const today = per[todayK] || { n: 0, amt: 0 }, wk = sumWeek(wkOff), prev = sumWeek(wkOff - 1);
        const stat = (label, o, note) => el('div', { className: 'rs-stat' }, el('small', { textContent: label }),
            el('b', { textContent: `${o.n} refund${o.n === 1 ? '' : 's'}` }), el('span', { textContent: o.n ? `${money(o.amt)}${note ? ' · ' + note : ''}` : (note || 'None yet') }));
        $('rsStats').replaceChildren(
            stat('Today', today),
            stat(wkOff === 0 ? 'This week' : 'Selected week', wk),
            stat('Week before', prev));

        const days = [...Array(7)].map((_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
        const max = Math.max(1, ...days.map(d => (per[dkey(d)] || { n: 0 }).n));
        $('rsDays').replaceChildren(...days.map(d => {
            const k = dkey(d), o = per[k] || { n: 0, amt: 0 }, fut = d > now && k !== todayK;
            const bar = el('i', { className: 'rs-bar' }); bar.style.setProperty('--h', `${o.n ? Math.max(12, Math.round(o.n / max * 100)) : 0}%`);
            const b = el('button', { type: 'button', className: 'rs-day' + (k === todayK ? ' today' : '') + (fut ? ' future' : '') + (o.n ? ' has' : '') },
                el('div', { className: 'rs-barwrap' }, bar),
                el('b', { textContent: fut && !o.n ? '–' : String(o.n) }),
                el('span', { textContent: fmtD(d, { weekday: 'short' }) }),
                el('small', { textContent: fmtD(d, { month: 'short', day: 'numeric' }) }),
                el('em', { textContent: o.n ? money(o.amt) : '' }));
            b.setAttribute('aria-haspopup', 'dialog');
            b.setAttribute('aria-label', `${fmtD(d, { weekday: 'long', month: 'long', day: 'numeric' })}: ${o.n} refund${o.n === 1 ? '' : 's'}${o.n ? ', ' + money(o.amt) : ''}. Open day report`);
            b.onclick = () => openDay(d, b);
            return b;
        }));
    }

    /* ---------- Day report popup: refunds made that day + most requested items ---------- */
    const dym = $('dayModal');
    const rankRows = rows => {
        const mx = rows.length ? rows[0][1] : 1;
        return el('ol', { className: 'tp-list' }, ...rows.map(([name, n], i) => {
            const bar = el('i', { className: 'tp-bar' }); bar.style.setProperty('--w', `${Math.max(8, Math.round(n / mx * 100))}%`);
            return el('li', { className: 'tp-row' }, el('span', { className: 'tp-rank', textContent: String(i + 1) }), el('span', { className: 'tp-name', textContent: name, title: name }),
                el('span', { className: 'tp-track' }, bar), el('b', { className: 'tp-n', textContent: `${n}×` }));
        }));
    };
    /* Items most asked for in student refund requests (the item the AI matched the photo to, else every item in the sale) */
    function topRequested(list) {
        const c = {};
        list.forEach(r => (r.ai_matched ? [r.ai_matched] : [...new Set(itemsOf(r).map(i => i.name))]).forEach(n => { if (n) c[n] = (c[n] || 0) + 1; }));
        return Object.entries(c).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
    }
    function openDay(d, trigger) {
        const k = dkey(d);
        const done = state.tx.filter(t => t.refunded && t.refunded_at && dkey(new Date(t.refunded_at)) === k);
        const asked = state.rq.filter(r => r.created_at && dkey(new Date(r.created_at)) === k);
        const amt = done.reduce((s, t) => s + refundAmt(t), 0);
        $('dyTitle').textContent = fmtD(d, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        const stat = (label, big, note) => el('div', { className: 'dy-stat' }, el('small', { textContent: label }), el('b', { textContent: big }), el('span', { textContent: note }));
        const sect = (title, sub, body) => el('section', { className: 'dy-sec' }, el('h3', { textContent: title }), el('p', { textContent: sub }), body);
        const empty = msg => el('p', { className: 'tp-empty', textContent: msg });
        const tr = topRefunded(done), tq = topRequested(asked);
        $('dyBody').replaceChildren(
            el('div', { className: 'dy-stats' },
                stat('Refunded', money(amt), `${done.length} refund${done.length === 1 ? '' : 's'} issued`),
                stat('Student requests', String(asked.length), asked.length === 1 ? 'request received' : 'requests received')),
            sect('Most requested for refund', 'Items students asked to have refunded',
                tq.length ? rankRows(tq) : empty('No student refund requests on this day.')),
            sect('Most refunded items', 'Items refunded on this day',
                tr.length ? rankRows(tr) : empty(done.length ? 'No item details were recorded for these refunds.' : 'No refunds were made on this day.')));
        dym._ret = trigger; openModal(dym);
    }
    const closeDay = () => closeModal(dym);
    $('dyClose').onclick = closeDay; $('dyBack').onclick = closeDay;
    dym.addEventListener('mousedown', e => { if (e.target === dym) closeDay(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !dym.hidden && dym.classList.contains('open')) { e.stopImmediatePropagation(); closeDay(); }
    }, true);
    $('rsPrev').onclick = () => { wkOff--; renderSummary(); };
    $('rsNext').onclick = () => { wkOff++; renderSummary(); };
    $('rsNow').onclick = () => { wkOff = 0; renderSummary(); };

    /* CSV download of the selected week: daily totals first, then one row per refund */
    const csvCell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const isoD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const num = n => (Math.round(n * 100) / 100).toFixed(2);
    function downloadCsv() {
        const now = new Date(), start = weekStart(now, wkOff);
        const days = [...Array(7)].map((_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
        const inWeek = state.tx.filter(t => t.refunded && t.refunded_at).filter(t => { const k = dkey(new Date(t.refunded_at)); return days.some(d => dkey(d) === k); })
            .sort((a, b) => new Date(a.refunded_at) - new Date(b.refunded_at));
        const rows = [['TapMate refund report'], ['Week', `${isoD(days[0])} to ${isoD(days[6])}`], ['Generated', new Date().toLocaleString('en-PH')], [],
        ['DAILY SUMMARY'], ['Date', 'Day', 'Refunds', `Amount refunded (${CONFIG.currency})`]];
        let n = 0, amt = 0;
        days.forEach(d => {
            const list = inWeek.filter(t => dkey(new Date(t.refunded_at)) === dkey(d)), a = list.reduce((s, t) => s + refundAmt(t), 0);
            n += list.length; amt += a;
            rows.push([isoD(d), fmtD(d, { weekday: 'long' }), list.length, num(a)]);
        });
        rows.push(['TOTAL', '', n, num(amt)], [], ['REFUND DETAILS'],
            ['Reference', 'Customer', 'Items', 'Payment', 'Purchased', 'Refunded', `Purchase total (${CONFIG.currency})`, `Amount refunded (${CONFIG.currency})`]);
        inWeek.forEach(t => rows.push([t.reference || '', t.customer_name || 'Walk-in', itemsOf(t).map(i => `${i.name} x${i.qty}`).join('; '), methodLabel(t.method),
        new Date(t.created_at).toLocaleString('en-PH'), new Date(t.refunded_at).toLocaleString('en-PH'), num(Number(t.total)), num(refundAmt(t))]));
        if (!inWeek.length) rows.push(['No refunds issued this week.']);
        const blob = new Blob(['\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `tapmate-refund-report-${isoD(days[0])}_to_${isoD(days[6])}.csv` });
        document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast('Report downloaded.');
    }
    $('rsCsv').onclick = downloadCsv;

    /* ---------- Issue refund: receipt-style slip ---------- */
    const rfm = $('refundModal');
    let rfTx = null, rfBusy = false;
    const lineTotal = i => Number(i.price) * Number(i.qty);
    const boxes = () => [...$('rfItems').querySelectorAll('input[type=checkbox]')];
    const amountNow = () => {
        const its = itemsOf(rfTx);
        if (!its.length) return Number(rfTx.total);
        return Math.min(boxes().reduce((s, c) => s + (c.checked ? lineTotal(its[+c.dataset.i]) : 0), 0), Number(rfTx.total));
    };
    const paintTotal = () => { $('rfTotal').textContent = money(amountNow()); };
    function barcode(seed) {
        let x = 0, h = 7, bars = '';
        for (const c of seed.repeat(3)) {
            h = (h * 31 + c.charCodeAt(0)) >>> 0;
            const w = 1 + (h % 3), g = 1 + ((h >> 4) % 2);
            bars += `<rect x="${x}" width="${w}" height="34"/>`; x += w + g;
        }
        return `<svg viewBox="0 0 ${x} 34" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
    }
    function openRefund(t, trigger) {
        rfTx = t; rfm._ret = trigger;
        const meta = [['Reference', t.reference || '–'], ['Date', when(t.created_at)], ['Customer', t.customer_name || 'Walk-in'], ['Cashier', identity().name], ['Payment', methodLabel(t.method)]];
        $('rfMeta').replaceChildren(...meta.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
        const its = itemsOf(t);
        $('rfItems').replaceChildren(...(its.length ? its.map((i, n) => {
            const cb = el('input', { type: 'checkbox', checked: true }); cb.dataset.i = n; cb.onchange = paintTotal;
            cb.setAttribute('aria-label', `Refund ${i.name}`);
            return el('label', { className: 'rc-line' }, cb, el('span', { textContent: `${i.qty} × ${i.name}` }), el('span', { textContent: money(lineTotal(i)) }));
        }) : [el('div', { className: 'rc-line nocb' }, el('span', { textContent: 'Whole purchase' }), el('span', { textContent: money(Number(t.total)) }))]));
        $('rfText').textContent = (its.length > 1 ? 'Untick items that should not be refunded. ' : '') +
            (t.method === 'paylater' ? 'Comes off their Pay Later balance.' : 'Goes back to their RFID wallet.');
        $('rfBars').innerHTML = barcode(t.reference || 'TAPMATE');
        $('rfReason').value = ''; setErr($('rfMsg'), '');
        $('rfOk').disabled = false; $('rfOk').textContent = 'Issue refund';
        paintTotal(); openModal(rfm);
    }
    const closeRefund = () => { if (rfBusy) return; closeModal(rfm); rfTx = null; };
    $('rfBack').onclick = closeRefund;
    rfm.addEventListener('mousedown', e => { if (e.target === rfm) closeRefund(); });


    $('rfOk').onclick = async () => {
        if (!rfTx || rfBusy) return;
        if (!getToken()) return setErr($('rfMsg'), 'Your session has expired. Please log in again.');
        const amount = amountNow();
        if (!(amount > 0)) return setErr($('rfMsg'), 'Tick at least one item to refund.');
        rfBusy = true; $('rfOk').disabled = true; $('rfOk').textContent = 'Refunding…'; setErr($('rfMsg'), '');
        let r;
        try {
            r = (await rpc(CONFIG.refundRpc, {
                p_purchase_id: rfTx.id, p_amount: amount, p_reason: $('rfReason').value.trim() || null
            })) || {};
        } catch (err) { console.error(err); r = { reason: 'network' }; }
        rfBusy = false;
        if (r.ok) {
            const done = rfTx; rfTx = null; closeModal(rfm);
            done.refunded = true; done.refunded_amount = amount; done.refunded_at = r.refunded_at || new Date().toISOString();
            toast(`Refunded ${money(amount)}.`);
            state.sig = ''; renderTabs(); renderList(); load();
            return;
        }
        const M = {
            session: 'Your session has expired. Please log in again.', forbidden: "Only cashiers and admins can issue refunds.",
            already: 'This purchase was already refunded.', not_found: 'That purchase could not be found.',
            amount: 'That refund amount is not valid.', network: "Can't reach TapMate right now. Please try again."
        };
        setErr($('rfMsg'), M[r.reason] || 'Could not issue the refund.');
        $('rfOk').disabled = false; $('rfOk').textContent = 'Issue refund';
        if (r.reason === 'already') load();
    };
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !rfm.hidden && rfm.classList.contains('open') && !$('confirm').classList.contains('open')) { e.stopImmediatePropagation(); closeRefund(); }
    }, true);

    /* ---------- Review a student's refund request: photo, reason, statement + AI visual assessment ---------- */
    const rvm = $('reviewModal');
    let rvReq = null, rvBusy = false, rvSeq = 0;
    const AI_LABEL = { High: 'high', Medium: 'medium', Low: 'low', Unclear: 'unclear' };

    function paintAi(a, mode, msg) {
        const host = $('rvAi'), head = el('h4', { textContent: 'AI visual assessment' });
        if (mode === 'loading') return host.replaceChildren(head, el('p', { className: 'ai-wait', textContent: 'Analyzing the photo against the kiosk products…' }));
        if (mode === 'error') {
            const b = el('button', { type: 'button', className: 'btn-line ai-retry', textContent: 'Try again' }); b.onclick = () => runAi(true);
            return host.replaceChildren(head, el('p', { className: 'ai-wait err', textContent: msg || 'The AI assessment is not available right now.' }), b);
        }
        if (!a) {
            const b = el('button', { type: 'button', className: 'btn-line ai-retry', textContent: 'Run AI assessment' }); b.onclick = () => runAi(true);
            return host.replaceChildren(head, el('p', { className: 'ai-wait', textContent: 'No AI assessment was saved for this request.' }), b);
        }
        const sim = AI_LABEL[a.visual_similarity] || 'unclear';
        const rows = [['Observed', a.observed], ['Reference', a.reference],
        ['Visual Similarity', el('span', { className: 'sim ' + sim, textContent: a.visual_similarity || 'Unclear' })],
        ['Assessment', a.assessment], ['Recommendation', el('b', { className: 'ai-rec', textContent: a.recommendation || 'Review required' })]];
        const dl = el('dl', { className: 'ai-dl' }, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
        const again = el('button', { type: 'button', className: 'ai-again', textContent: 'Run again' }); again.onclick = () => runAi(true);
        host.replaceChildren(head, dl, el('p', { className: 'ai-note' }, 'AI can be wrong. It only compares how the photo looks; you make the final call. ', again));
    }

    async function runAi(force) {
        if (!rvReq) return;
        const seq = rvSeq, id = rvReq.id;
        paintAi(null, 'loading');
        let j;
        try {
            const res = await fetch(`${BASE}/functions/v1/${CONFIG.aiFunction}`, {
                method: 'POST',
                headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: getToken(), request_id: id })
            });
            j = await res.json().catch(() => ({}));
        } catch (e) { console.error(e); j = { reason: 'network' }; }
        if (seq !== rvSeq) return;                     // the cashier moved on to another request
        if (j && j.ok) { rvReq.ai_assessment = j.analysis; return paintAi(j.analysis); }
        const M = { session: 'Your session has expired. Please log in again.', no_image: 'This request has no usable photo.', network: "Can't reach TapMate right now.", ai: 'The AI could not assess this photo.' };
        paintAi(null, 'error', M[j && j.reason] || M.ai);
    }

    async function openReview(r, trigger) {
        rvReq = r; rvm._ret = trigger; const seq = ++rvSeq;
        const pending = r.status === 'pending';
        const meta = [['Reference', r.reference || '–'], ['Student', `${r.student_name || 'Student'}${r.student_id ? ' · ' + r.student_id : ''}`],
        ['Purchased', when(r.purchased_at)], ['Requested', when(r.created_at)], ['Payment', methodLabel(r.method)], ['Amount', money(Number(r.amount))]];
        $('rvMeta').replaceChildren(...meta.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
        $('rvItems').replaceChildren(...itemsOf(r).map(i => el('li', {}, el('span', { textContent: `${i.qty} × ${i.name}` }), el('span', { textContent: money(Number(i.price) * Number(i.qty)) }))));
        $('rvReason').textContent = r.reason || '–';
        $('rvDetails').textContent = r.details || '';
        $('rvImg').removeAttribute('src'); $('rvPhoto').classList.add('loading'); $('rvPhoto').classList.remove('broken');
        $('rvNote').value = r.review_note || ''; $('rvNote').disabled = !pending; $('rvNoteWrap').hidden = !pending && !r.review_note;
        $('rvActions').hidden = !pending;
        $('rvApprove').disabled = $('rvReject').disabled = false;
        $('rvApprove').textContent = 'Approve & refund'; $('rvReject').textContent = 'Reject';
        $('rvDone').hidden = pending;
        $('rvDone').textContent = r.status === 'rejected' ? `Rejected ${when(r.reviewed_at)}` : r.status === 'approved' ? `Approved ${when(r.reviewed_at)}` : '';
        $('rvAlready').hidden = !(pending && r.sale_refunded);
        setErr($('rvMsg'), '');
        paintAi(null, 'loading');
        openModal(rvm);

        let d;
        try { d = await rpc(CONFIG.requestRpc, { p_id: r.id }); } catch (e) { console.error(e); d = { reason: 'network' }; }
        if (seq !== rvSeq) return;
        if (!d || !d.ok) {
            $('rvPhoto').classList.remove('loading'); $('rvPhoto').classList.add('broken');
            paintAi(null, 'error', d && d.reason === 'session' ? 'Your session has expired. Please log in again.' : 'Could not load this request.');
            return;
        }
        rvReq = Object.assign({}, r, d.request);
        const img = $('rvImg');
        img.onload = () => $('rvPhoto').classList.remove('loading');
        img.onerror = () => { $('rvPhoto').classList.remove('loading'); $('rvPhoto').classList.add('broken'); };
        img.src = rvReq.image || '';
        if (rvReq.ai_assessment) paintAi(rvReq.ai_assessment);
        else if (pending) runAi(false);
        else paintAi(null);
    }

    const closeReview = () => { if (rvBusy) return; rvSeq++; closeModal(rvm); rvReq = null; };
    $('rvClose').onclick = closeReview; $('rvBack').onclick = closeReview;
    rvm.addEventListener('mousedown', e => { if (e.target === rvm) closeReview(); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !rvm.hidden && rvm.classList.contains('open') && !$('confirm').classList.contains('open')) { e.stopImmediatePropagation(); closeReview(); }
    }, true);
    $('rvImg').onclick = () => { if ($('rvImg').src) window.open($('rvImg').src, '_blank', 'noopener'); };

    async function decide(decision) {
        if (!rvReq || rvBusy || rvReq.status !== 'pending') return;
        if (!getToken()) return setErr($('rvMsg'), 'Your session has expired. Please log in again.');
        const approve = decision === 'approved', r = rvReq;
        const where = r.method === 'paylater' ? 'their Pay Later balance' : 'their RFID wallet';
        const yes = await ask(approve ? 'Approve this refund?' : 'Reject this request?',
            approve ? `${money(Number(r.amount))} goes back to ${where}. This cannot be undone.` : 'The student’s request will be closed as rejected.',
            approve ? 'Approve & refund' : 'Reject');
        if (!yes) return;
        rvBusy = true; $('rvApprove').disabled = $('rvReject').disabled = true; setErr($('rvMsg'), '');
        $(approve ? 'rvApprove' : 'rvReject').textContent = approve ? 'Refunding…' : 'Rejecting…';
        const fail = reason => {
            const M = {
                session: 'Your session has expired. Please log in again.', forbidden: 'Only cashiers and admins can do this.', not_found: 'That request could not be found.',
                already_reviewed: 'This request was already reviewed.', network: "Can't reach TapMate right now. Please try again.", amount: 'That refund amount is not valid.'
            };
            setErr($('rvMsg'), M[reason] || 'Could not complete that.');
            rvBusy = false; $('rvApprove').disabled = $('rvReject').disabled = false;
            $('rvApprove').textContent = 'Approve & refund'; $('rvReject').textContent = 'Reject';
            if (reason === 'already_reviewed') load();
        };
        try {
            if (approve) {                                   // money first, through the same RPC as the counter refund
                const x = (await rpc(CONFIG.refundRpc, { p_purchase_id: r.sale_id, p_amount: Number(r.amount), p_reason: `Student request: ${r.reason}` })) || {};
                if (!x.ok && x.reason !== 'already') return fail(x.reason || 'failed');
            }
            const v = (await rpc(CONFIG.reviewRpc, { p_id: r.id, p_decision: decision, p_note: $('rvNote').value.trim() || null })) || {};
            if (!v.ok) return fail(v.reason || 'failed');
        } catch (e) { console.error(e); return fail('network'); }
        rvBusy = false; rvSeq++; closeModal(rvm); rvReq = null;
        toast(approve ? `Refunded ${money(Number(r.amount))}.` : 'Request rejected.');
        state.sig = ''; load();
    }
    $('rvApprove').onclick = () => decide('approved');
    $('rvReject').onclick = () => decide('rejected');

    /* ---------- Data: every kiosk purchase lands here; polled so new sales appear on their own ---------- */
    let loading = false;
    async function load() {
        if (loading || !getToken()) return;
        loading = true;
        try {
            const [r, q] = await Promise.all([rpc(CONFIG.listRpc, { p_limit: 500 }),
            rpc(CONFIG.requestsRpc, { p_limit: 300 }).catch(() => null)]);
            if (r && r.reason === 'session') return goLogin();
            state.ok = !!(r && r.ok !== false); state.loaded = true;
            state.tx = (r && r.transactions) || [];
            state.rqOk = !!(q && q.ok); state.rq = (q && q.requests) || [];
        } catch (e) { console.error(e); state.ok = false; state.loaded = true; }
        finally { loading = false; }
        const sig = JSON.stringify([state.tx, state.ok, state.rq, state.rqOk]);
        if (sig !== state.sig) { state.sig = sig; renderTabs(); renderList(); }
    }
    setInterval(() => { if (!document.hidden && !rfBusy && !rvBusy) load(); }, CONFIG.pollMs);

    /* ---------- Boot ---------- */
    async function init() {
        setupChrome(); renderTabs(); renderList();
        if (!BASE || !CONFIG.supabaseKey) return setStatus('Add your Supabase URL and key in the CONFIG block at the top of Refunds_disputes.js.', true);
        if (CONFIG.loginPages.length && !getToken()) return goLogin();
        load();
    }
    init();
})();
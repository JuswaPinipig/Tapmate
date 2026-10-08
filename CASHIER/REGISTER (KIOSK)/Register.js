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
        // Where cashiers go when not logged in / after log out. Paths are relative to Register.html and tried in
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
        pinRpc: 'student_change_pin', // RPC that changes a card PIN (p_token, p_current, p_new)
        currency: '₱',
        cabinet: [                  // each module is its own page; icon: register | refunds | analytics | audit
            { label: 'Register', href: 'Register.html', icon: 'register' },
            { label: 'Refunds & disputes', href: '../REFUNDS & DISPUTES/Refunds_disputes.html', icon: 'refunds' },
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

    const RECENT_KEY = 'tm_recent_search', COLLAPSE_KEY = 'tm_cabinet_collapsed';
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (_) { } }
    };
    const state = { products: [], categories: [], active: 'all', q: '', order: new Map(), payment: 'rfid', recent: [], sugg: [], idx: -1 };
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
    function openKiosk() {
        const t = getToken();
        if (!t) return toast('Please log in again first.');
        location.href = `${CONFIG.kioskScheme}://launch?token=${encodeURIComponent(t)}`;
        toast('Launching TapMate Kiosk…');
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
        document.title = `${CONFIG.storeName} Register`;
        const logo = $('logo');
        const srcs = [].concat(CONFIG.logo || []).map(encodeURI);
        let i = 0;
        logo.alt = CONFIG.storeName;
        logo.onerror = () => {
            if (++i < srcs.length) logo.src = srcs[i];
            else logo.replaceWith(el('b', { className: 'logo-text', textContent: CONFIG.storeName }));
        };
        if (srcs.length) logo.src = srcs[0]; else logo.onerror();
        const here = location.pathname.split('/').pop() || 'Register.html';
        $('cabinetLinks').replaceChildren(...CONFIG.cabinet.map(l => {
            const a = el('a', { href: l.href, title: l.label });
            a.innerHTML = svg(l.icon);
            a.append(el('span', { className: 'lbl', textContent: l.label }));
            if (l.href === here) a.setAttribute('aria-current', 'page');
            return a;
        }));
        $('kiosk').href = '#';
        $('kiosk').addEventListener('click', e => { e.preventDefault(); openKiosk(); });
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
        setStatus('Could not find the login page. Put its real path first in loginPages (top of Register.js).', true);
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

    /* ---------- Search with autocomplete ---------- */
    const input = $('search'), list = $('suggest');
    try { state.recent = JSON.parse(store.get(RECENT_KEY) || '[]').slice(0, 5); } catch (_) { }
    const saveRecent = t => {
        t = t.trim(); if (!t) return;
        state.recent = [t, ...state.recent.filter(r => r.toLowerCase() !== t.toLowerCase())].slice(0, 5);
        store.set(RECENT_KEY, JSON.stringify(state.recent));
    };
    function buildSuggestions() {
        const q = input.value.trim().toLowerCase();
        if (!q) return state.recent.map(t => ({ t, recent: true }));
        const names = [...new Set(state.products.map(p => p.name))];
        const starts = names.filter(n => n.toLowerCase().startsWith(q));
        const has = names.filter(n => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
        return [...starts, ...has].slice(0, 8).map(t => ({ t }));
    }
    function openList(show) {
        list.hidden = !show; input.setAttribute('aria-expanded', show);
        if (!show) input.removeAttribute('aria-activedescendant');
    }
    function renderSuggest() {
        state.sugg = buildSuggestions(); state.idx = -1;
        const q = input.value.trim();
        if (!state.sugg.length) {
            list.replaceChildren(q ? el('li', { className: 'none', textContent: 'No matching products' }) : el('li', { className: 'none', textContent: 'Start typing to search products' }));
            return openList(document.activeElement === input);
        }
        list.replaceChildren(...state.sugg.map((s, i) => {
            const t = el('span', { className: 't' });
            const at = q ? s.t.toLowerCase().indexOf(q.toLowerCase()) : -1;
            if (at < 0) t.append(s.t);
            else t.append(s.t.slice(0, at) && el('b', { textContent: s.t.slice(0, at) }), s.t.slice(at, at + q.length), s.t.slice(at + q.length) && el('b', { textContent: s.t.slice(at + q.length) }));
            const li = el('li', { id: `sg-${i}`, role: 'option' }, t);
            li.insertAdjacentHTML('afterbegin', svg(s.recent ? 'clock' : 'search'));
            li.setAttribute('aria-selected', 'false');
            if (s.recent) {
                const rm = el('button', { className: 'rm', textContent: 'Remove', type: 'button', tabIndex: -1 });
                rm.onmousedown = e => { e.preventDefault(); e.stopPropagation(); state.recent = state.recent.filter(r => r !== s.t); store.set(RECENT_KEY, JSON.stringify(state.recent)); renderSuggest(); };
                li.append(rm);
            }
            li.onmousedown = e => { e.preventDefault(); choose(s.t); };
            return li;
        }));
        openList(document.activeElement === input);
    }
    function highlight(i) {
        state.idx = (i + state.sugg.length) % state.sugg.length;
        [...list.children].forEach((li, n) => li.setAttribute('aria-selected', n === state.idx));
        input.setAttribute('aria-activedescendant', `sg-${state.idx}`);
        list.children[state.idx].scrollIntoView({ block: 'nearest' });
    }
    function apply(q) { state.q = q; $('searchClear').hidden = !q; renderGrid(); }
    function choose(t) { input.value = t; saveRecent(t); apply(t); openList(false); }
    input.oninput = () => { apply(input.value); renderSuggest(); };
    input.onfocus = renderSuggest;
    input.onblur = () => openList(false);
    input.onkeydown = e => {
        const open = !list.hidden && state.sugg.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) renderSuggest(); else if (open) highlight(state.idx + 1); }
        else if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlight(state.idx - 1); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(open && state.idx >= 0 ? state.sugg[state.idx].t : input.value); }
        else if (e.key === 'Escape') { if (!list.hidden) { openList(false); e.stopPropagation(); } }
    };
    $('searchClear').onclick = () => { input.value = ''; apply(''); input.focus(); renderSuggest(); };

    /* ---------- Menu ---------- */
    const countIn = id => state.products.filter(p => id === 'all' || p.category_id === id).length;
    let tabKey = '';
    function moveInd() {
        const host = $('tabs'), ind = host.querySelector('.tab-ind'), sel = host.querySelector('[aria-selected="true"]');
        if (ind && !sel) { ind.style.width = '0px'; return; }   // nothing selected (all products showing): hide the highlight
        if (!ind || !sel || !sel.offsetWidth) return;
        ind.style.width = sel.offsetWidth + 'px';
        ind.style.transform = `translateX(${sel.offsetLeft}px)`;
        if (ind.classList.contains('no-anim')) requestAnimationFrame(() => requestAnimationFrame(() => ind.classList.remove('no-anim')));
        host.scrollTo({ left: sel.offsetLeft - (host.clientWidth - sel.offsetWidth) / 2, behavior: 'smooth' });
    }
    function renderTabs() {
        const all = state.categories, host = $('tabs');   // no "All" pill: tap the selected category again to see everything
        const key = JSON.stringify(all.map(c => [c.id, c.name, countIn(c.id)]));
        if (key !== tabKey) {           // rebuild only when categories/counts change, so the highlight can slide
            tabKey = key;
            const ind = el('i', { className: 'tab-ind no-anim' }); ind.setAttribute('aria-hidden', 'true');
            host.replaceChildren(ind, ...all.map(c => {
                const b = el('button', { role: 'tab', type: 'button' }, c.name, el('small', { textContent: countIn(c.id) }));
                b._id = c.id;
                b.onclick = () => { state.active = state.active === c.id ? 'all' : c.id; renderTabs(); renderGrid(); };
                return b;
            }));
        }
        host.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b._id === state.active));
        moveInd();
    }
    window.addEventListener('resize', moveInd);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInd);
    function card(p) {
        const media = el('div', { className: 'media' });
        if (p.image_url) media.append(el('img', { src: p.image_url, alt: '', loading: 'lazy' }));
        else { const ph = el('div', { className: 'ph' }); ph.innerHTML = svg('bag'); media.append(ph); }
        const n = state.order.get(p.id) || 0;
        if (n) media.append(el('span', { className: 'badge', textContent: `×${n}` }));
        const add = el('span', { className: 'add' }); add.innerHTML = svg('plus'); media.append(add);
        const info = el('div', { className: 'info' }, el('b', { textContent: p.name }), el('span', { className: 'price', textContent: money(p.price) }));
        if (p.allergens?.length) info.append(el('span', { className: 'allergens', textContent: `Contains ${p.allergens.join(', ')}` }));
        const c = el('button', { className: 'card' + (n ? ' in' : ''), title: p.description || '' }, media, info);
        c.onclick = () => change(p.id, 1);
        return c;
    }
    function renderGrid() {
        const q = state.q.trim().toLowerCase();
        const list = state.products.filter(p =>
            (state.active === 'all' || p.category_id === state.active) && p.name.toLowerCase().includes(q));
        // one combined list: a category when one is selected, otherwise every product together
        const groups = [{ c: { name: q ? `Results for “${state.q.trim()}”` : state.active === 'all' ? 'All products' : (state.categories.find(x => x.id === state.active) || {}).name }, items: list }];
        $('grid').replaceChildren(...(list.length ? groups : []).map(g => el('section', {},
            el('div', { className: 'sec-head' }, el('h3', { textContent: g.c.name }), el('span', { textContent: `${g.items.length} item${g.items.length > 1 ? 's' : ''}` })),
            el('div', { className: 'grid' }, ...g.items.map(card)))));
        setStatus(list.length ? '' : (state.products.length ? 'No products match.' : 'No active products yet. Add some in the admin portal.'));
    }

    /* ---------- Order tally ---------- */
    /* The order lives in Supabase (kiosk_orders) so the desktop kiosk and this page always show the same tally. */
    let orderVersion = -1, pending = 0;
    const push = p => { pending++; p.then(applyOrder).catch(() => toast('Could not update the order.')).finally(() => { pending--; }); };
    function applyOrder(o) {
        if (!o || !o.ok) return;
        orderVersion = o.version;
        state.order = new Map(o.items.map(i => [i.product_id, i.qty]));
        state.payment = o.payment;
        document.querySelectorAll('input[name="pay"]').forEach(r => { r.checked = r.value === o.payment; });
        renderOrder(); renderGrid();
    }
    function change(id, d) {
        const n = Math.max((state.order.get(id) || 0) + d, 0);
        n > 0 ? state.order.set(id, n) : state.order.delete(id);
        renderOrder(); renderGrid();
        push(rpc('kiosk_set_qty', { p_product_id: id, p_qty: n }));
    }
    $('clear').onclick = () => { state.order.clear(); renderOrder(); renderGrid(); push(rpc('kiosk_clear_order')); };
    document.querySelectorAll('input[name="pay"]').forEach(r => {
        r.onchange = () => { state.payment = r.value; push(rpc('kiosk_set_payment', { p_method: r.value })); };
    });
    let polling = false;
    setInterval(async () => {
        if (polling || pending || !getToken() || document.hidden) return;
        polling = true;
        try { const o = await rpc('kiosk_get_order'); if (!pending && o && o.ok && o.version !== orderVersion) applyOrder(o); } catch (_) { }
        polling = false;
    }, 1500);

    function renderOrder() {
        let sub = 0, items = 0;
        const rows = [...state.order].map(([id, qty]) => {
            const p = state.products.find(x => x.id === id); if (!p) return null;
            const amt = p.price * qty; sub += amt; items += qty;
            const minus = el('button', { textContent: '−', ariaLabel: `Remove one ${p.name}` });
            const plus = el('button', { textContent: '+', ariaLabel: `Add one ${p.name}` });
            minus.onclick = () => change(id, -1); plus.onclick = () => change(id, 1);
            let thumb;
            if (p.image_url) thumb = el('img', { className: 'thumb', src: p.image_url, alt: '' });
            else { thumb = el('div', { className: 'thumb' }); thumb.innerHTML = svg('bag'); }
            return el('li', { className: 'line' }, thumb,
                el('div', { className: 'info' }, el('span', { className: 'nm', textContent: p.name }), el('span', { className: 'unit', textContent: `${money(p.price)} each` })),
                el('span', { className: 'amt', textContent: money(amt) }),
                el('div', { className: 'qty' }, minus, el('span', { textContent: qty }), plus));
        }).filter(Boolean);
        $('lines').replaceChildren(...rows);
        $('empty').hidden = rows.length > 0;
        $('clearWrap').classList.toggle('show', rows.length > 0);
        $('count').textContent = `${items} item${items === 1 ? '' : 's'}`;
        $('subtotal').textContent = money(sub);
        $('total').textContent = money(sub);
    }

    /* ---------- Boot ---------- */
    async function init() {
        setupChrome(); renderOrder();
        if (!BASE || !CONFIG.supabaseKey) return setStatus('Add your Supabase URL and key in the CONFIG block at the top of Register.js.', true);
        if (CONFIG.loginPages.length && !getToken()) return goLogin();
        try {
            setStatus('Loading products…');
            const [cats, prods] = await Promise.all([
                api('categories?select=id,name&order=name'),
                api('products?select=id,name,category_id,price,description,allergens,image_url&status=eq.active&order=name')
            ]);
            state.categories = cats;
            state.products = prods.map(p => ({ ...p, price: Number(p.price) }));
            renderTabs(); renderGrid();
        } catch (e) { setStatus(`Couldn't load products: ${e.message}. Check the URL, key and your connection, then reload.`, true); }
    }
    init();
})();
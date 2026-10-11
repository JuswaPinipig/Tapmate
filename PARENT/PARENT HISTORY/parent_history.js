(function () {
    var cfg = window.APP_CONFIG || {};
    var SESSION_KEY = cfg.SESSION_KEY || "tapmate_session";   // same login token as the student portal
    var LOGIN_URL = cfg.PARENT_LOGIN_URL || cfg.LOGIN_URL;
    var POLL_MS = 15000, PAGE = 5;
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var state = { children: [], child: null, parent: null, pl: null, wallet: null, purchases: [], topups: [], pOk: true, tOk: true, tab: "purchases", page: 1, sig: "", sel: null };

    /* ---------- session ---------- */
    function getToken() {
        try { var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); return s && s.token ? s.token : null; }
        catch (_) { return null; }
    }
    function goToLogin() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { }
        window.location.replace(LOGIN_URL);
    }
    $("signout").onclick = async function () {
        var t = getToken();
        if (t) { try { await db.rpc("card_logout", { p_token: t }); } catch (_) { } }
        goToLogin();
    };

    /* ---------- formatting ---------- */
    function peso(n) { return Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function money(n) { return "₱" + peso(n); }
    function when(iso) { return iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "–"; }
    var toastEl = $("toast"), tm;
    function toast(m) { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(tm); tm = setTimeout(function () { toastEl.classList.remove("show"); }, 2400); }
    function setErr(el, msg) { el.textContent = msg || ""; el.hidden = !msg; }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /* ---------- cabinet (collapsible sidebar, same as the student pages) ---------- */
    var shell = $("shell"), mq = window.matchMedia("(max-width:760px)");
    try { if (localStorage.getItem("sw_collapsed") === "1") shell.classList.add("collapsed"); } catch (_) { }
    requestAnimationFrame(function () { requestAnimationFrame(function () { shell.classList.remove("init"); }); });
    function syncAria() {
        var open = mq.matches ? shell.classList.contains("open") : !shell.classList.contains("collapsed");
        $("collapse").setAttribute("aria-expanded", open);
        $("collapse").setAttribute("aria-label", open ? "Collapse menu" : "Expand menu");
    }
    $("collapse").onclick = function () {
        if (mq.matches) shell.classList.remove("open");
        else {
            shell.classList.toggle("collapsed");
            try { localStorage.setItem("sw_collapsed", shell.classList.contains("collapsed") ? "1" : "0"); } catch (_) { }
        }
        syncAria();
    };
    $("menu").onclick = function () { shell.classList.add("open"); syncAria(); };
    $("scrim").onclick = function () { shell.classList.remove("open"); syncAria(); };
    syncAria();

    // Sidebar links to the other parent pages: addresses in config.js (PARENT_OVERVIEW_URL, PARENT_TOPUP_URL)
    var LINK_DEFAULT = { PARENT_OVERVIEW_URL: "../PARENT OVERVIEW/parentoverview.html", PARENT_TOPUP_URL: "../PARENT TOP-UP/parent-top-up.html" };
    document.querySelectorAll("[data-link]").forEach(function (a) {
        var url = cfg[a.dataset.link] || LINK_DEFAULT[a.dataset.link];
        if (url) a.setAttribute("href", url);
        else a.addEventListener("click", function (e) { e.preventDefault(); toast("This page isn't linked yet. Set " + a.dataset.link + " in config.js."); });
    });

    /* ---------- modals ---------- */
    function openModal(el) {
        el._ret = document.activeElement;
        el.hidden = false;
        requestAnimationFrame(function () { el.classList.add("open"); });
        var f = el.querySelector("[data-focus]") || el.querySelector("input:not([disabled])") || el.querySelector("[data-close]") || el.querySelector("button");
        setTimeout(function () { if (f) f.focus(); }, 60);
    }
    function closeModal(el) {
        el.classList.remove("open");
        setTimeout(function () { el.hidden = true; }, 260);
        if (el._ret && el._ret.focus) { try { el._ret.focus(); } catch (_) { } }
    }
    var profileEl = $("profile"), receiptEl = $("receipt-modal"), tdEl = $("td-modal"), cfEl = $("confirm");
    document.addEventListener("keydown", function (e) {
        var open = Array.prototype.slice.call(document.querySelectorAll(".modal.open")).pop();
        if (!open) return;
        if (e.key === "Escape") { closeModal(open); return; }
        if (e.key === "Tab") {
            var f = Array.prototype.filter.call(open.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])"), function (x) { return x.offsetParent !== null; });
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    [profileEl, receiptEl, tdEl].forEach(function (m) {
        m.addEventListener("mousedown", function (e) { if (e.target === m) closeModal(m); });
        m.querySelectorAll("[data-close]").forEach(function (b) { b.onclick = function () { closeModal(m); }; });
    });
    $("cf-back").onclick = function () { closeModal(cfEl); };
    $("cf-ok").onclick = function () { closeModal(cfEl); };
    $("open-profile").onclick = function () { openModal(profileEl); };
    $("rc-print").onclick = function () { window.print(); };

    /* ---------- data ---------- */
    async function refresh() {
        var token = getToken();
        if (!token) return goToLogin();
        var res;
        try {
            res = await db.rpc("parent_history", { p_token: token, p_student: state.sel });
            if (res.error) throw res.error;
        } catch (err) { console.error("parent_history failed:", err); setErr($("app-err"), "Can't reach TapMate right now. Retrying…"); return; }
        var d = res.data;
        if (!d || d.reason === "session") return goToLogin();   // expired or invalid session
        setErr($("app-err"), "");
        if (d.ok === false) {
            state.pOk = state.tOk = false; state.purchases = []; state.topups = []; state.pl = null; state.wallet = null;
            if (d.reason === "no_child") setErr($("app-err"), "No student is linked to this parent account yet.");
            render(); renderKids(); renderCard(); return;
        }
        state.parent = d.parent || state.parent;
        state.children = d.children || [];
        state.child = d.child || null;
        if (state.child) state.sel = state.child.id;
        state.pl = d.pay_later || null;
        state.wallet = d.wallet || null;
        state.pOk = true; state.tOk = d.topups_ok !== false;
        state.purchases = d.purchases || []; state.topups = d.topups || [];
        renderProfile(state.parent || {});
        var sig = JSON.stringify([state.child, state.children, state.pl, state.wallet, state.purchases, state.topups, state.tOk]);
        if (sig !== state.sig) { state.sig = sig; renderKids(); renderCard(); render(); }   // only redraw on change, so the poll never steals focus
    }

    /* ---------- profile ---------- */
    function initials(p) { return ((p.first_name || p.full_name || "?")[0] || "") + ((p.last_name || (p.full_name || "").split(" ").slice(-1)[0] || "")[0] || ""); }
    function paintAvatar(e, p) {
        var key = (p.avatar_url || "") + "|" + initials(p);
        if (e.dataset.k === key) return;
        e.dataset.k = key; e.textContent = "";
        if (p.avatar_url) {
            var img = new Image(); img.alt = ""; img.src = p.avatar_url;
            img.onerror = function () { img.remove(); e.textContent = initials(p); };
            e.appendChild(img);
        } else e.textContent = initials(p);
    }
    function renderProfile(p) {
        $("side-name").textContent = p.full_name || "Parent";
        $("pf-name").textContent = p.full_name || "–";
        $("pf-email").textContent = p.email || "–";
        $("pf-sid").textContent = "Parent account";
        paintAvatar($("side-av"), p); paintAvatar($("pf-av"), p);
    }

    /* ---------- child switcher ---------- */
    function renderKids() {
        var box = $("kids"), one = $("kid-one");
        box.innerHTML = ""; one.innerHTML = "";
        var kids = state.children;
        box.hidden = kids.length < 2; one.hidden = !(kids.length === 1 && state.child);
        if (kids.length >= 2) {
            kids.forEach(function (k) {
                var b = el("button", "kid"); b.type = "button";
                b.setAttribute("aria-pressed", String(state.child && k.id === state.child.id));
                var av = el("span", "av"); paintAvatar(av, k);
                b.appendChild(av); b.appendChild(el("span", null, k.first_name || k.full_name || k.name || "Student"));
                b.onclick = function () { state.sel = k.id; state.page = 1; state.sig = ""; refresh(); };
                box.appendChild(b);
            });
        } else if (kids.length === 1 && state.child) {
            var c = state.child, av = el("span", "av"); paintAvatar(av, c); one.appendChild(av);
            var t = el("div"); t.appendChild(el("b", null, c.full_name || "Student")); t.appendChild(el("small", null, c.student_id ? "Student ID " + c.student_id : "Linked student"));
            one.appendChild(t);
        }
    }

    /* ---------- Pay Later card ---------- */
    function renderCard() {
        var c = $("plcard"), p = state.pl;
        if (!p) { c.hidden = true; renderWallet(); return; }
        c.hidden = false;
        var limit = Number(p.limit || 0), out = Number(p.outstanding || 0), avail = Math.max(Number(p.available != null ? p.available : limit - out), 0);
        var pct = limit > 0 ? Math.min(100, Math.round(out / limit * 100)) : 0;
        var st = $("pc-state");
        st.className = "pc-state" + (!p.enabled ? " bad" : p.overdue ? " bad" : " on");
        st.textContent = !p.enabled ? "Pay Later off" : p.overdue ? "Overdue" : "Active";
        $("pc-avail").textContent = peso(avail);
        $("pc-used-l").textContent = "Used " + money(out);
        $("pc-limit-l").textContent = "Limit " + money(limit);
        var bar = $("pc-fill"); bar.style.width = pct + "%";
        bar.parentNode.className = "bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "");
        $("pc-limit").textContent = money(limit);
        $("pc-out").textContent = money(out);
        $("pc-month").textContent = money(p.used_month);
        $("pc-due").textContent = out > 0 && p.due_at ? when(p.due_at) : "–";
        var note = $("pc-note"), name = (state.child && (state.child.first_name || state.child.full_name)) || "Your child";
        note.className = "pc-note";
        if (!p.enabled) { note.textContent = "Pay Later is turned off for " + name + "."; note.hidden = false; }
        else if (p.overdue) { note.textContent = "A Pay Later balance is overdue. " + name + " can't use Pay Later until it is settled."; note.className = "pc-note bad"; note.hidden = false; }
        else if (out > 0) { note.textContent = name + " owes " + money(out) + " in Pay Later" + (p.due_at ? ", due " + when(p.due_at) + "." : "."); note.hidden = false; }
        else note.hidden = true;
        renderWallet();
    }


    /* ---------- Student card (RFID wallet of the linked student) ---------- */
    function renderWallet() {
        var card = $("sccard"), w = state.wallet;
        if (!w) { card.hidden = true; syncWallets(); return; }
        card.hidden = false;
        var bal = Number(w.balance || 0), spent = Number(w.spent_today || 0);
        var cap = Number(w.spending_limit || 0) > 0 ? Number(w.spending_limit) : Number(w.daily_limit || 0);
        var pct = cap > 0 ? Math.min(100, Math.round(spent / cap * 100)) : 0;
        var inactive = !!(w.status && w.status !== "active");
        var bad = inactive || !w.has_card || !!w.locked;
        var st = $("sc-state");
        st.className = "pc-state" + (bad ? " bad" : " on");
        st.textContent = inactive ? "Inactive" : !w.has_card ? "No card" : w.locked ? "Locked" : "Active";
        $("sc-bal").textContent = peso(bal);
        $("sc-used-l").textContent = "Spent today " + money(spent);
        $("sc-limit-l").textContent = cap > 0 ? "Limit " + money(cap) : "No daily limit";
        var bar = $("sc-fill"); bar.style.width = pct + "%";
        bar.parentNode.className = "bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "");
        $("sc-daily").textContent = cap > 0 ? money(cap) : "None";
        $("sc-spent").textContent = money(spent);
        $("sc-left").textContent = cap > 0 ? money(Math.max(cap - spent, 0)) : "–";
        $("sc-card").textContent = w.uid_last4 ? "•••• " + w.uid_last4 : "–";
        var name = (state.child && (state.child.first_name || state.child.full_name)) || "Your child";
        var note = $("sc-note"); note.className = "pc-note"; note.hidden = false;
        if (!w.has_card) note.textContent = name + " has no RFID card linked yet.";
        else if (w.locked) { note.textContent = name + "'s card is temporarily locked after too many wrong PIN attempts."; note.className = "pc-note bad"; }
        else note.textContent = name + "'s wallet balance" + (w.updated_at ? " as of " + when(w.updated_at) + "." : ".");
        syncWallets();
    }

    /* ---------- swipe carousel ---------- */
    var wl = { i: 0, raf: 0, drag: null, n: 0 };
    var wlEl = $("wallets"), wlTrack = $("wl-track"), wlTabs = [$("wl-t0"), $("wl-t1")];
    var wlSlides = [$("plcard"), $("sccard")], wlDots = $("wl-dots").children;
    var reduce = window.matchMedia("(prefers-reduced-motion:reduce)");

    function wlPitch() {
        var v = wlSlides.filter(function (s) { return !s.hidden; });
        return v.length > 1 ? v[1].offsetLeft - v[0].offsetLeft : (wlTrack.clientWidth || 1);
    }
    function wlPaint() {
        wl.raf = 0;
        var pitch = wlPitch(), p = Math.max(0, Math.min(Math.max(wl.n - 1, 0), wlTrack.scrollLeft / pitch));
        wlEl.style.setProperty("--p", p.toFixed(4));
        wlSlides.forEach(function (s, k) {
            if (s.hidden) return;
            if (reduce.matches || wl.n < 2) { s.style.transform = ""; s.style.opacity = ""; return; }
            var d = Math.min(1, Math.abs(k - p));
            s.style.transform = "scale(" + (1 - .05 * d).toFixed(4) + ")";
            s.style.opacity = (1 - .45 * d).toFixed(3);
        });
        var idx = Math.round(p);
        if (idx !== wl.i) {
            wl.i = idx;
            wlTabs.forEach(function (t, k) { t.setAttribute("aria-selected", String(k === idx)); t.tabIndex = k === idx ? 0 : -1; });
            Array.prototype.forEach.call(wlDots, function (d, k) { d.classList.toggle("on", k === idx); });
        }
    }
    function wlQueue() { if (!wl.raf) wl.raf = requestAnimationFrame(wlPaint); }
    function wlGo(i, instant) {
        i = Math.max(0, Math.min(Math.max(wl.n - 1, 0), i));
        wlTrack.scrollTo({ left: i * wlPitch(), behavior: instant || reduce.matches ? "auto" : "smooth" });
    }
    function syncWallets() {
        wl.n = wlSlides.filter(function (s) { return !s.hidden; }).length;
        wlEl.hidden = wl.n === 0;
        wlEl.classList.toggle("single", wl.n < 2);
        wlGo(Math.max(wl.i, 0), true); wl.i = -1; wlQueue();
    }
    wlTrack.addEventListener("scroll", wlQueue, { passive: true });
    window.addEventListener("resize", function () { wlGo(Math.max(wl.i, 0), true); wlQueue(); });
    wlTabs.forEach(function (t, k) {
        t.onclick = function () { wlGo(k); };
        t.addEventListener("keydown", function (e) {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                var n = Math.max(0, Math.min(wl.n - 1, k + (e.key === "ArrowRight" ? 1 : -1)));
                wlTabs[n].focus(); wlGo(n); e.preventDefault();
            }
        });
    });
    wlTrack.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight") { wlGo(wl.i + 1); e.preventDefault(); }
        else if (e.key === "ArrowLeft") { wlGo(wl.i - 1); e.preventDefault(); }
    });
    /* mouse drag on desktop (touch and trackpads already swipe natively) */
    wlTrack.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse" || e.button !== 0 || wl.n < 2) return;
        wl.drag = { x: e.clientX, s: wlTrack.scrollLeft, from: Math.max(wl.i, 0), moved: false };
    });
    window.addEventListener("pointermove", function (e) {
        var d = wl.drag; if (!d) return;
        var dx = e.clientX - d.x;
        if (!d.moved && Math.abs(dx) > 4) { d.moved = true; wlTrack.classList.add("drag"); }
        if (d.moved) wlTrack.scrollLeft = d.s - dx;
    });
    window.addEventListener("pointerup", function (e) {
        var d = wl.drag; if (!d) return; wl.drag = null;
        if (!d.moved) return;
        var dx = e.clientX - d.x;
        wlTrack.classList.remove("drag");
        wlGo(d.from + (dx < -50 ? 1 : dx > 50 ? -1 : 0));
    });
    wlTrack.addEventListener("dragstart", function (e) { e.preventDefault(); });

    /* ---------- history lists ---------- */
    var EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    function sameMonth(iso) { var d = new Date(iso), n = new Date(); return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth(); }
    function methodLabel(m) { return m === "paylater" ? "Pay Later" : "RFID wallet"; }
    function topupMethod(m) {
        var k = String(m || "").toLowerCase();
        return k.indexOf("gcash") >= 0 ? "GCash" : k.indexOf("bank") >= 0 ? "Bank transfer" : (m || "Top-up");
    }
    function topupStatus(s) {
        var k = String(s || "pending").toLowerCase();
        if (/approv|confirm|complete|success|paid/.test(k)) return ["approved", "Approved"];
        if (/reject|declin|denied|fail/.test(k)) return ["rejected", "Rejected"];
        return ["pending", "Pending"];
    }
    function itemsTitle(items) {
        if (!items || !items.length) return "Purchase";
        var first = items[0].name + (items[0].qty > 1 ? " ×" + items[0].qty : "");
        return items.length > 1 ? first + " +" + (items.length - 1) + " more" : first;
    }
    function itemCount(items) { return (items || []).reduce(function (n, i) { return n + Number(i.qty || 0); }, 0); }
    var REFUND_ST = { pending: ["pending", "Refund pending"], approved: ["approved", "Refunded"], rejected: ["rejected", "Refund declined"] };

    function renderStats() {
        var spent = 0, count = 0, topped = 0;
        state.purchases.forEach(function (p) { if (sameMonth(p.created_at)) { spent += Number(p.total); count++; } });
        state.topups.forEach(function (t) { if (sameMonth(t.created_at) && topupStatus(t.status)[0] === "approved") topped += Number(t.amount); });
        $("st-spent").textContent = state.pOk ? money(spent) : "–";
        $("st-count").textContent = state.pOk ? String(count) : "–";
        $("st-topped").textContent = state.tOk ? money(topped) : "–";
    }

    function emptyRow(list, msg) { list.appendChild(el("li", "empty", msg)); }

    function render() {
        renderStats();
        var list = $("h-list"); list.innerHTML = "";
        var t = state.tab, isP = t !== "topups";
        var ok = isP ? state.pOk : state.tOk;
        var rows = isP ? state.purchases.filter(function (r) { return t === "paylater" ? r.method === "paylater" : true; }) : state.topups;
        var more = $("h-pages");
        var kid = (state.child && (state.child.first_name || state.child.full_name)) || "Your child";
        if (!ok) { emptyRow(list, (isP ? "Purchase" : "Top-up") + " history isn't available yet."); more.hidden = true; return; }
        if (!rows.length) {
            emptyRow(list, t === "paylater" ? "No Pay Later purchases yet."
                : isP ? "No purchases yet. Items " + kid + " buys at the canteen kiosk will show up here."
                    : "No top-ups yet. " + kid + "'s wallet top-ups will show up here.");
            more.hidden = true; return;
        }
        var pages = Math.ceil(rows.length / PAGE);
        if (state.page > pages) state.page = pages;
        var start = (state.page - 1) * PAGE;
        rows.slice(start, start + PAGE).forEach(function (r) { list.appendChild(isP ? purchaseRow(r) : topupRow(r)); });
        renderPager(more, pages);
    }

    /* pagination: ‹ 1 2 3 … 9 10 ›, 5 rows per page */
    function renderPager(nav, pages) {
        nav.innerHTML = "";
        if (pages <= 1) { nav.hidden = true; return; }
        nav.hidden = false;
        function btn(label, page, opts) {
            opts = opts || {};
            var b = el("button", "pg" + (opts.cur ? " cur" : ""), label);
            b.type = "button";
            if (opts.aria) b.setAttribute("aria-label", opts.aria);
            if (opts.cur) b.setAttribute("aria-current", "page");
            if (opts.disabled) b.disabled = true;
            else b.onclick = function () {
                state.page = page; render();
                var top = $("v-history"); if (top && top.scrollIntoView) top.scrollIntoView({ block: "start", behavior: "smooth" });
            };
            nav.appendChild(b);
        }
        btn("‹", state.page - 1, { aria: "Previous page", disabled: state.page === 1 });
        var nums = [], last = 0;
        for (var i = 1; i <= pages; i++) {
            if (pages <= 7 || i === 1 || i === pages || Math.abs(i - state.page) <= 1 || (state.page <= 3 && i <= 5) || (state.page >= pages - 2 && i >= pages - 4)) nums.push(i);
        }
        nums.forEach(function (n) {
            if (last && n - last > 1) nav.appendChild(el("span", "pg-gap", "…"));
            btn(String(n), n, { cur: n === state.page, aria: "Page " + n });
            last = n;
        });
        btn("›", state.page + 1, { aria: "Next page", disabled: state.page === pages });
    }

    function purchaseRow(p) {
        var li = el("li", "hrow");
        var main = el("div", "h-main");
        main.appendChild(el("span", "what", itemsTitle(p.items)));
        main.appendChild(el("span", "when", when(p.created_at) + " · " + itemCount(p.items) + " item" + (itemCount(p.items) === 1 ? "" : "s")));
        main.appendChild(el("span", "when ref", p.reference || ""));
        var side = el("div", "h-side");
        side.appendChild(el("span", "amt", "−" + money(p.total)));
        side.appendChild(el("span", "via", methodLabel(p.method)));
        if (p.method === "paylater") side.appendChild(el("span", "st pl", "Pay Later"));
        if (p.refund_status) { var rs = REFUND_ST[p.refund_status] || REFUND_ST.pending; side.appendChild(el("span", "st " + rs[0], rs[1])); }
        var b = el("button", "eye"); b.type = "button"; b.innerHTML = EYE;
        b.setAttribute("aria-label", "View e-receipt " + (p.reference || ""));
        b.title = "View e-receipt";
        b.onclick = function () { openReceipt(p); };
        li.appendChild(main); li.appendChild(side); li.appendChild(b);
        return li;
    }

    function topupRow(t) {
        var li = el("li", "hrow");
        var main = el("div", "h-main");
        var st = topupStatus(t.status), adj = t.kind === "adjustment";
        var tm2 = topupMethod(t.method);
        main.appendChild(el("span", "what", /top-?up/i.test(tm2) ? tm2 : tm2 + " top-up"));
        main.appendChild(el("span", "when", when(t.created_at)));
        if (t.reference_no) main.appendChild(el("span", "when ref", "Ref " + t.reference_no));
        var side = el("div", "h-side");
        side.appendChild(el("span", "amt" + (st[0] === "approved" ? " in" : ""), (st[0] === "approved" ? "+" : "") + money(t.amount)));
        side.appendChild(el("span", "st " + st[0], st[1]));
        li.appendChild(main); li.appendChild(side);
        if (adj || st[0] !== "pending") {
            var b = el("button", "eye"); b.type = "button"; b.innerHTML = EYE;
            b.setAttribute("aria-label", "View details"); b.title = "View details";
            b.onclick = function () { openTopupDetail(t, st[0]); };
            li.appendChild(b);
        }
        return li;
    }

    function openTopupDetail(t, st) {
        var rej = st === "rejected" && t.kind !== "adjustment";
        $("td-title").textContent = t.kind === "adjustment" ? "Balance updated" : rej ? "Top-up rejected" : "Top-up approved";
        var dl = $("td-dl"); dl.innerHTML = "";
        [["Admin", t.admin_name || "–"], ["Date & time", when(t.reviewed_at || t.created_at)],
        rej ? ["Reason", t.reason || "No reason given."] : ["Amount", money(t.amount)]].forEach(function (r) {
            var d = el("div"); d.appendChild(el("dt", null, r[0])); d.appendChild(el("dd", null, r[1])); dl.appendChild(d);
        });
        openModal(tdEl);
    }

    /* tabs */
    function setTab(t) {
        state.tab = t; state.page = 1;
        ["purchases", "paylater", "topups"].forEach(function (n) { $("tab-" + n).setAttribute("aria-selected", n === t); });
        render();
    }
    $("tab-purchases").onclick = function () { setTab("purchases"); };
    $("tab-paylater").onclick = function () { setTab("paylater"); };
    $("tab-topups").onclick = function () { setTab("topups"); };

    /* ---------- e-receipt (same look as the student's; read only) ---------- */
    function row(parent, a, b, cls) {
        var r = el("div", "r-row" + (cls ? " " + cls : "")); r.appendChild(el("span", null, a)); r.appendChild(el("span", null, b)); parent.appendChild(r);
    }
    function dash(parent) { parent.appendChild(el("hr", "r-dash")); }
    function barcode(text) {
        var bits = ""; (text + text).split("").forEach(function (c) { bits += c.charCodeAt(0).toString(2).padStart(8, "0"); });
        var x = 0, rects = "";
        bits.split("").forEach(function (bt) { var w = bt === "1" ? 2 : 1; rects += '<rect x="' + x + '" y="0" width="' + w + '" height="40"/>'; x += w + 1; });
        var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        s.setAttribute("class", "r-bar"); s.setAttribute("viewBox", "0 0 " + x + " 40"); s.setAttribute("preserveAspectRatio", "none");
        s.setAttribute("aria-hidden", "true"); s.setAttribute("fill", "#222"); s.innerHTML = rects;
        return s;
    }
    function openReceipt(p) {
        var paper = $("rc-paper"); paper.innerHTML = "";
        var d = new Date(p.created_at);
        var date = isNaN(d) ? "–" : d.toLocaleString("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        paper.appendChild(el("div", "r-brand", "TAPMATE"));
        paper.appendChild(el("div", "r-sub", "Cashier Kiosk · Official Receipt"));
        dash(paper);
        row(paper, "Reference", p.reference || "–", "r-b");
        row(paper, "Date", date);
        row(paper, "Student", (state.child && state.child.full_name) || "–");
        row(paper, "Cashier", p.cashier_name || "–");
        row(paper, "Payment", methodLabel(p.method));
        dash(paper);
        (p.items || []).slice(0, 40).forEach(function (i) { row(paper, i.qty + " × " + i.name, money(Number(i.price) * Number(i.qty))); });
        dash(paper);
        row(paper, "TOTAL", money(p.total), "r-b r-total");
        dash(paper);
        if (p.method === "paylater") { if (p.pay_later_available != null) row(paper, "Pay Later available", money(p.pay_later_available)); }
        else if (p.balance_after != null) row(paper, "Wallet balance", money(p.balance_after));
        if (p.remaining_today != null) row(paper, "Left to spend today", money(p.remaining_today));
        var rs = p.refund_status ? (REFUND_ST[p.refund_status] || REFUND_ST.pending)[1] : "–";
        row(paper, "Refund", rs, "r-b r-refund");
        paper.appendChild(barcode(p.reference || "TAPMATE"));
        paper.appendChild(el("div", "r-thanks", "Thank you!"));
        var kid = (state.child && (state.child.first_name || state.child.full_name)) || "Your child";
        $("rc-rfnote").textContent = p.refund_status === "pending" ? kid + " asked for a refund. The cashier and admin are reviewing it."
            : p.refund_status === "approved" ? "This purchase was refunded."
                : p.refund_status === "rejected" ? "The refund request for this purchase was declined."
                    : "Refunds are requested by " + kid + " within 24 hours of the purchase.";
        openModal(receiptEl);
    }

    /* ---------- go ---------- */
    refresh();
    setInterval(refresh, POLL_MS);
})();
(function () {
    var cfg = window.APP_CONFIG || {};
    var SESSION_KEY = "tapmate_session";   // set by login.js after RFID + PIN (same as the wallet)
    var POLL_MS = 15000, PAGE = 10;
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var state = { purchases: [], topups: [], pOk: true, tOk: true, profile: null, pin: null, tab: "purchases", range: "all", page: 1, sig: "" };

    /* ---------- session ---------- */
    function getToken() {
        try { var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); return s && s.token ? s.token : null; }
        catch (_) { return null; }
    }
    function goToLogin() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { }
        window.location.replace(cfg.LOGIN_URL);
    }
    $("signout").onclick = async function () {
        var t = getToken();
        if (t) { try { await db.rpc("card_logout", { p_token: t }); } catch (_) { } }
        goToLogin();
    };

    /* ---------- formatting ---------- */
    function peso(n) { return Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
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

    /* ---------- cabinet (collapsible sidebar, same state as the wallet page) ---------- */
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

    // Sidebar links to the other portals: addresses in config.js (WALLET_URL falls back to studentwallet.html)
    document.querySelectorAll("[data-link]").forEach(function (a) {
        var url = cfg[a.dataset.link];
        if (url) a.setAttribute("href", url);
        else if (a.dataset.link !== "WALLET_URL") a.addEventListener("click", function (e) { e.preventDefault(); toast("This page isn't linked yet. Set " + a.dataset.link + " in config.js."); });
    });

    /* ---------- modals (smooth open and close) ---------- */
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
    var cfResolve = null;
    function ask(title, text, yes) {
        $("cf-title").textContent = title; $("cf-text").textContent = text; $("cf-ok").textContent = yes || "Confirm";
        openModal($("confirm"));
        return new Promise(function (r) { cfResolve = r; });
    }
    function answer(v) { closeModal($("confirm")); var r = cfResolve; cfResolve = null; if (r) r(v); }
    $("cf-back").onclick = function () { answer(false); };
    $("cf-ok").onclick = function () { answer(true); };

    var profileEl = $("profile"), receiptEl = $("receipt-modal");
    function closeProfile() { resetPin(); closeModal(profileEl); }
    document.addEventListener("keydown", function (e) {
        var open = Array.prototype.slice.call(document.querySelectorAll(".modal.open")).pop();
        if (!open) return;
        if (e.key === "Escape") {
            if (open.id === "confirm") answer(false); else if (open.id === "profile") closeProfile(); else if (open.id === "refund-modal") closeRefund(); else closeModal(open);
            return;
        }
        if (e.key === "Tab") {
            var f = Array.prototype.filter.call(open.querySelectorAll("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])"), function (x) { return x.offsetParent !== null; });
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    profileEl.addEventListener("mousedown", function (e) { if (e.target === profileEl) closeProfile(); });
    profileEl.querySelector("[data-close]").onclick = closeProfile;
    $("open-profile").onclick = function () { openModal(profileEl); };
    receiptEl.addEventListener("mousedown", function (e) { if (e.target === receiptEl) closeModal(receiptEl); });
    $("rc-close").onclick = function () { closeModal(receiptEl); };
    $("rc-print").onclick = function () { window.print(); };

    /* ---------- data ---------- */
    async function refresh() {
        var token = getToken();
        if (!token) return goToLogin();
        var out;
        try {
            out = await Promise.all([db.rpc("student_portal", { p_token: token }), db.rpc("student_history", { p_token: token })]);
            if (out[0].error) throw out[0].error;
        } catch (err) { console.error("history refresh failed:", err); setErr($("app-err"), "Can't reach TapMate right now. Retrying…"); return; }
        if (!out[0].data) return goToLogin();   // expired or invalid session
        setErr($("app-err"), "");
        state.profile = out[0].data.profile; state.pin = out[0].data.pin;
        renderProfile(state.profile); renderPin(state.pin);

        var h = out[1];
        if (h.error || !h.data) { if (h.error) console.error("student_history failed:", h.error); state.pOk = state.tOk = false; }
        else if (h.data.reason === "session") return goToLogin();
        else {
            state.pOk = h.data.ok !== false; state.tOk = h.data.topups_ok !== false;
            state.purchases = h.data.purchases || []; state.topups = h.data.topups || [];
        }
        var sig = JSON.stringify([state.purchases, state.topups, state.pOk, state.tOk]);
        if (sig !== state.sig) { state.sig = sig; render(); if (rcId && receiptEl.classList.contains("open")) updateRefundUI(); }   // only redraw when something changed, so the poll never steals focus
    }

    /* ---------- profile (same as the wallet) ---------- */
    function initials(p) { return ((p.first_name || p.full_name || "?")[0] || "") + ((p.last_name || "")[0] || ""); }
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
        $("side-name").textContent = p.full_name;
        $("side-id").textContent = p.student_id || "";
        $("pf-name").textContent = p.full_name;
        $("pf-sid").textContent = p.student_id ? "Student ID " + p.student_id : "";
        $("pf-email").textContent = p.email || "–";
        paintAvatar($("side-av"), p); paintAvatar($("pf-av"), p);
    }

    /* ---------- history lists ---------- */
    var EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    function inRange(iso) {
        if (state.range === "all") return true;
        var d = new Date(iso), now = new Date();
        if (state.range === "7") return now - d <= 7 * 864e5;
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
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

    function renderStats() {
        var spent = 0, count = 0, topped = 0;
        state.purchases.forEach(function (p) { if (sameMonth(p.created_at)) { spent += Number(p.total); count++; } });
        state.topups.forEach(function (t) { if (sameMonth(t.created_at) && topupStatus(t.status)[0] === "approved") topped += Number(t.amount); });
        $("st-spent").textContent = state.pOk ? money(spent) : "–";
        $("st-count").textContent = state.pOk ? String(count) : "–";
        $("st-topped").textContent = state.tOk ? money(topped) : "–";
    }

    function emptyRow(list, msg) { var e = el("li", "empty", msg); list.appendChild(e); }

    function render() {
        renderStats();
        var list = $("h-list"); list.innerHTML = "";
        var isP = state.tab === "purchases";
        var ok = isP ? state.pOk : state.tOk;
        var rows = (isP ? state.purchases : state.topups).filter(function (r) { return inRange(r.created_at); });
        var more = $("h-pages");
        if (!ok) { emptyRow(list, (isP ? "Purchase" : "Top-up") + " history isn't available yet."); more.hidden = true; return; }
        if (!rows.length) {
            emptyRow(list, state.range === "all"
                ? (isP ? "No purchases yet. Items you buy at the canteen kiosk will show up here." : "No top-ups yet. Your wallet top-ups will show up here.")
                : "Nothing in this date range.");
            more.hidden = true; return;
        }
        var pages = Math.ceil(rows.length / PAGE);
        if (state.page > pages) state.page = pages;      // e.g. the list shrank after a refresh
        var start = (state.page - 1) * PAGE;
        rows.slice(start, start + PAGE).forEach(function (r) { list.appendChild(isP ? purchaseRow(r) : topupRow(r)); });
        renderPager(more, pages);
    }

    /* pagination: ‹ 1 2 3 … 9 10 ›, 10 rows per page */
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
            if (i === 1 || i === pages || Math.abs(i - state.page) <= 1 || (state.page <= 3 && i <= 5) || (state.page >= pages - 2 && i >= pages - 4)) nums.push(i);
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
        var tm2 = topupMethod(t.method); main.appendChild(el("span", "what", /top-?up/i.test(tm2) ? tm2 : tm2 + " top-up"));
        main.appendChild(el("span", "when", when(t.created_at)));
        if (t.reference_no) main.appendChild(el("span", "when ref", "Ref " + t.reference_no));
        var side = el("div", "h-side");
        var st = topupStatus(t.status);
        side.appendChild(el("span", "amt" + (st[0] === "approved" ? " in" : ""), (st[0] === "approved" ? "+" : "") + money(t.amount)));
        side.appendChild(el("span", "st " + st[0], st[1]));
        li.appendChild(main); li.appendChild(side);
        return li;
    }

    /* tabs + date range (pagination is in renderPager) */
    function setTab(t) {
        state.tab = t; state.page = 1;
        ["purchases", "topups"].forEach(function (n) { $("tab-" + n).setAttribute("aria-selected", n === t); });
        render();
    }
    $("tab-purchases").onclick = function () { setTab("purchases"); };
    $("tab-topups").onclick = function () { setTab("topups"); };
    document.querySelectorAll("#range button").forEach(function (b) {
        b.onclick = function () {
            state.range = b.dataset.range; state.page = 1;
            document.querySelectorAll("#range button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); });
            render();
        };
    });

    /* ---------- virtual e-receipt (mirrors the paper receipt the kiosk prints) ---------- */
    function row(parent, a, b, cls) {
        var r = el("div", "r-row" + (cls ? " " + cls : "")); r.appendChild(el("span", null, a)); r.appendChild(el("span", null, b)); parent.appendChild(r);
    }
    function dash(parent) { parent.appendChild(el("hr", "r-dash")); }
    function barcode(text) {       // same bit pattern idea as the kiosk receipt, drawn as SVG
        var bits = ""; (text + text).split("").forEach(function (c) { bits += c.charCodeAt(0).toString(2).padStart(8, "0"); });
        var x = 0, rects = "";
        bits.split("").forEach(function (bt) { var w = bt === "1" ? 2 : 1; rects += '<rect x="' + x + '" y="0" width="' + w + '" height="40"/>'; x += w + 1; });
        var s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        s.setAttribute("class", "r-bar"); s.setAttribute("viewBox", "0 0 " + x + " 40"); s.setAttribute("preserveAspectRatio", "none");
        s.setAttribute("aria-hidden", "true"); s.setAttribute("fill", "#222"); s.innerHTML = rects;
        return s;
    }
    var REFUND_ST = { pending: ["pending", "Refund pending"], approved: ["approved", "Refunded"], rejected: ["rejected", "Refund declined"] };
    var REFUND_MS = 24 * 3600 * 1000, rcId = null, rcTick = null;
    function curSale() { return state.purchases.filter(function (x) { return x.id === rcId; })[0] || null; }
    function clock(ms) {
        var s = Math.max(0, Math.floor(ms / 1000)), pad = function (n) { return String(n).padStart(2, "0"); };
        return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor((s % 3600) / 60)) + ":" + pad(s % 60);
    }
    // keeps the countdown inside the receipt, and the Request refund button, in step with the clock
    function updateRefundUI() {
        var p = curSale(); if (!p) return;
        var left = new Date(p.created_at).getTime() + REFUND_MS - Date.now();
        var t = $("rc-timer"), btn = $("rc-refund"), note = $("rc-rfnote");
        if (p.refund_status) {
            var rs = REFUND_ST[p.refund_status] || REFUND_ST.pending;
            if (t) { t.textContent = rs[1]; t.className = ""; }
            btn.disabled = true; btn.textContent = "Refund requested";
            note.textContent = p.refund_status === "pending" ? "Your cashier and the admin are reviewing it."
                : p.refund_status === "approved" ? "Your refund was approved." : "Your refund request was declined.";
        } else if (left <= 0) {
            if (t) { t.textContent = "Closed"; t.className = ""; }
            btn.disabled = true; btn.textContent = "Refund window closed";
            note.textContent = "Refunds can only be requested within 24 hours of the purchase.";
        } else {
            if (t) { t.textContent = clock(left); t.className = left < 3600000 ? "low" : ""; }
            btn.disabled = false; btn.textContent = "Request refund";
            note.textContent = "You can request a refund for the next " + (left >= 3600000 ? Math.floor(left / 3600000) + " h " + Math.floor((left % 3600000) / 60000) + " min" : Math.max(1, Math.ceil(left / 60000)) + " min") + ".";
        }
    }
    function startTick() {
        clearInterval(rcTick);
        rcTick = setInterval(function () {
            if (!receiptEl.classList.contains("open")) { clearInterval(rcTick); return; }
            updateRefundUI();
        }, 1000);
    }
    function openReceipt(p) {
        rcId = p.id;
        var paper = $("rc-paper"); paper.innerHTML = "";
        var d = new Date(p.created_at);
        var date = isNaN(d) ? "–" : d.toLocaleString("en-PH", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
        paper.appendChild(el("div", "r-brand", "TAPMATE"));
        paper.appendChild(el("div", "r-sub", "Cashier Kiosk · Official Receipt"));
        dash(paper);
        row(paper, "Reference", p.reference || "–", "r-b");
        row(paper, "Date", date);
        row(paper, "Student", (state.profile && state.profile.full_name) || p.student_name || "–");
        row(paper, "Cashier", p.cashier_name || "–");
        row(paper, "Payment", methodLabel(p.method));
        dash(paper);
        var items = p.items || [];
        items.slice(0, 40).forEach(function (i) { row(paper, i.qty + " × " + i.name, money(Number(i.price) * Number(i.qty))); });
        dash(paper);
        row(paper, "TOTAL", money(p.total), "r-b r-total");
        dash(paper);
        if (p.method === "paylater") { if (p.pay_later_available != null) row(paper, "Pay Later available", money(p.pay_later_available)); }
        else if (p.balance_after != null) row(paper, "Wallet balance", money(p.balance_after));
        if (p.remaining_today != null) row(paper, "Left to spend today", money(p.remaining_today));
        row(paper, "Refund", "–", "r-b r-refund"); paper.lastChild.lastChild.id = "rc-timer";
        paper.appendChild(barcode(p.reference || "TAPMATE"));
        paper.appendChild(el("div", "r-thanks", "Thank you!"));
        updateRefundUI(); startTick();
        openModal(receiptEl);
    }

    /* ---------- refund request ---------- */
    var refundEl = $("refund-modal"), rfImage = "", rfBusy = false;
    var rfS2 = $("rf-s2"), rfS3 = $("rf-s3");
    function reveal(step, show) { step.classList.toggle("show", show); if (show) step.removeAttribute("inert"); else step.setAttribute("inert", ""); }
    function rfValid() { return !!rfImage && !!$("rf-reason").value && $("rf-details").value.trim().length >= 5; }
    // the message box grows and shrinks to fit what was typed (no drag handle)
    function rfGrow() {
        var t = $("rf-details");
        t.style.height = "auto";
        t.style.height = t.scrollHeight + 2 + "px";
        t.style.overflowY = t.scrollHeight > t.clientHeight + 1 ? "auto" : "hidden";
    }
    function rfSync() {
        reveal(rfS2, !!rfImage);
        reveal(rfS3, !!rfImage && !!$("rf-reason").value);
        $("rf-submit").disabled = rfBusy || !rfValid();
        $("rf-count").textContent = $("rf-details").value.length + "/500";
    }
    function resetRefund() {
        rfImage = ""; rfBusy = false; $("rf-form").reset(); setErr($("rf-msg"), "");
        $("rf-prev").hidden = true; $("rf-prev").removeAttribute("src"); $("rf-change").hidden = true; $("rf-ph").hidden = false;
        $("rf-drop").classList.remove("has"); $("rf-details").style.height = ""; rfSync();
    }
    function closeRefund() { closeModal(refundEl); setTimeout(resetRefund, 280); }
    refundEl.addEventListener("mousedown", function (e) { if (e.target === refundEl) closeRefund(); });
    refundEl.querySelectorAll("[data-close]").forEach(function (b) { b.onclick = closeRefund; });

    // shrink the photo in the browser first (max 1280px, JPEG) so it uploads fast on school Wi-Fi
    function shrink(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file), img = new Image();
            img.onload = function () {
                var k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
                var c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
                var ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
                URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", 0.8));
            };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("decode")); };
            img.src = url;
        });
    }
    $("rf-file").addEventListener("change", async function () {
        var f = this.files && this.files[0]; if (!f) return;
        setErr($("rf-msg"), "");
        if (!/^image\//.test(f.type)) { this.value = ""; return setErr($("rf-msg"), "Please choose an image file."); }
        if (f.size > 15 * 1024 * 1024) { this.value = ""; return setErr($("rf-msg"), "That photo is too large. Pick one under 15 MB."); }
        try { rfImage = await shrink(f); }
        catch (_) { rfImage = ""; this.value = ""; return setErr($("rf-msg"), "We couldn't read that photo. Try a JPG or PNG."); }
        $("rf-prev").src = rfImage; $("rf-prev").hidden = false; $("rf-change").hidden = false; $("rf-ph").hidden = true;
        $("rf-drop").classList.add("has"); rfSync();
    });
    $("rf-reason").addEventListener("change", rfSync);
    $("rf-details").addEventListener("input", function () { rfGrow(); rfSync(); });

    $("rc-refund").onclick = function () {
        var p = curSale(); if (!p || $("rc-refund").disabled) return;
        resetRefund();
        $("rf-sum").textContent = (p.reference || "Purchase") + " · " + itemsTitle(p.items) + " · " + money(p.total);
        openModal(refundEl);
    };

    $("rf-form").addEventListener("submit", async function (e) {
        e.preventDefault();
        var p = curSale(); if (!p || rfBusy) return;
        var msg = !rfImage ? "Upload a photo of the item you bought."
            : !$("rf-reason").value ? "Choose a reason for the refund."
                : $("rf-details").value.trim().length < 5 ? "Tell us a little more about what happened." : "";
        setErr($("rf-msg"), msg); if (msg) return;
        var ok = await ask("Send refund request?", "Your cashier and the admin will see your photo and message. You can only send one request per purchase.", "Send request");
        if (!ok) return;
        rfBusy = true; rfSync();
        var res;
        try {
            res = await db.rpc("student_request_refund", { p_token: getToken(), p_sale: p.id, p_reason: $("rf-reason").value, p_details: $("rf-details").value.trim(), p_image: rfImage });
            if (res.error) throw res.error;
        } catch (err) { console.error(err); rfBusy = false; rfSync(); return setErr($("rf-msg"), "Can't reach TapMate right now. Please try again."); }
        var r = res.data || {};
        if (r.ok) {
            p.refund_status = "pending"; p.refund_requested_at = new Date().toISOString();
            closeRefund(); toast("Refund request sent."); updateRefundUI(); render(); return refresh();
        }
        rfBusy = false; rfSync();
        if (r.reason === "session") return goToLogin();
        if (r.reason === "expired" || r.reason === "duplicate") { closeRefund(); refresh().then(updateRefundUI); }
        setErr($("rf-msg"), {
            expired: "The 24-hour refund window has closed for this purchase.", duplicate: "You already sent a refund request for this purchase.",
            not_found: "We couldn't find that purchase.", image: "That photo couldn't be used. Try a different one.", reason: "Choose a reason for the refund.",
            details: "Tell us a little more about what happened."
        }[r.reason] || "Could not send your request.");
    });

    /* ---------- PIN management (same as the wallet) ---------- */
    var ins = ["pin-cur", "pin-new", "pin-new2"];
    function renderPin(p) {
        if (!p) return;
        var out = p.remaining <= 0;
        $("pin-remaining").textContent = "PIN changes remaining: " + p.remaining + "/" + p.limit;
        $("pin-note").textContent = "You can change your PIN up to " + p.limit + " times within a 24-hour period.";
        $("pin-meter").hidden = out; $("pin-limit").hidden = !out;
        $("pin-limit-text").textContent = "You have reached the maximum of " + p.limit +
            " PIN changes within 24 hours. You can change your PIN again after the cooldown period ends" +
            (p.next_available_at ? " (" + when(p.next_available_at) + ")." : ".");
        ins.concat("pin-save").forEach(function (id) { $(id).disabled = out; });
    }
    function resetPin() { $("pin-form").reset(); setErr($("pin-msg"), ""); }
    ins.forEach(function (id) { $(id).addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 4); }); });

    $("pin-form").addEventListener("submit", async function (e) {
        e.preventDefault();
        var cur = $("pin-cur").value, n1 = $("pin-new").value, n2 = $("pin-new2").value;
        var msg = cur.length !== 4 ? "Enter your current 4-digit PIN."
            : n1.length !== 4 ? "Your new PIN must be exactly 4 digits."
                : n1 === cur ? "Your new PIN must be different from your current PIN."
                    : n1 !== n2 ? "The new PINs don't match." : "";
        setErr($("pin-msg"), msg);
        if (msg) return;
        var ok = await ask("Change your PIN?", "This uses 1 of your remaining PIN changes (" + state.pin.remaining + " left in this 24-hour period).", "Change PIN");
        if (!ok) return;
        var res;
        try { res = await db.rpc("student_change_pin", { p_token: getToken(), p_current: cur, p_new: n1 }); if (res.error) throw res.error; }
        catch (err) { console.error(err); return setErr($("pin-msg"), "Can't reach TapMate right now. Please try again."); }
        var r = res.data || {};
        if (r.ok) { resetPin(); toast("PIN changed."); return refresh(); }
        if (r.reason === "session") return goToLogin();
        var M = {
            wrong_pin: "Your current PIN is incorrect.", locked: "Too many wrong PINs. Try again in a few minutes.",
            limit: "PIN change limit reached. Try again after " + when(r.next_available_at) + ".",
            format: "Your new PIN must be exactly 4 digits.", same: "Your new PIN must be different from your current PIN.",
            no_pin: "No PIN is set yet. Ask an admin to set one."
        };
        setErr($("pin-msg"), M[r.reason] || "Could not change your PIN.");
        refresh();
    });

    /* ---------- go ---------- */
    refresh();
    setInterval(refresh, POLL_MS);
})();
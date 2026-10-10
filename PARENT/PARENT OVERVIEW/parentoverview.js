(function () {
    "use strict";
    var cfg = window.APP_CONFIG || {};
    var SESSION_KEY = "tapmate_session";   // set by login.js after the parent logs in
    var POLL_MS = 15000;
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var state = { tx: [], txOk: true, student: null, pl: null };

    /* ---------- session ---------- */
    function getToken() {
        try { var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); return s && s.token ? s.token : null; }
        catch (_) { return null; }
    }
    function goToLogin() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { }
        window.location.replace(cfg.LOGIN_URL);
    }
    async function signOut() {
        var t = getToken();
        if (t) { try { await db.rpc("card_logout", { p_token: t }); } catch (_) { } }
        goToLogin();
    }
    $("signout").onclick = signOut;
    $("mbar-logout").onclick = signOut;

    /* ---------- formatting ---------- */
    function peso(n) { return Number(n).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function money(n) { return "₱" + peso(n); }
    function when(iso) { return iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "–"; }
    var TYPE_LABEL = { topup: "Wallet top-up", purchase: "Purchase", refund: "Refund" };
    function isIn(t) { return t.type ? t.type !== "purchase" : Number(t.amount) > 0; }
    var toastEl = $("toast"), tm;
    function toast(m) { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(tm); tm = setTimeout(function () { toastEl.classList.remove("show"); }, 2600); }
    function setErr(el, msg) { el.textContent = msg || ""; el.hidden = !msg; }
    function li(listEl, parts) {
        var e = document.createElement("li");
        parts.forEach(function (p) { var s = document.createElement("span"); s.className = p[0]; s.textContent = p[1]; e.appendChild(s); });
        listEl.appendChild(e);
    }

    /* ---------- cabinet (collapsible sidebar, same as the student wallet) ---------- */
    var shell = $("shell"), mq = window.matchMedia("(max-width:760px)");
    try { if (localStorage.getItem("pw_collapsed") === "1") shell.classList.add("collapsed"); } catch (_) { }
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
            try { localStorage.setItem("pw_collapsed", shell.classList.contains("collapsed") ? "1" : "0"); } catch (_) { }
        }
        syncAria();
    };
    $("menu").onclick = function () { shell.classList.add("open"); syncAria(); };
    $("scrim").onclick = function () { shell.classList.remove("open"); syncAria(); };
    syncAria();

    /* ---------- views + links to the other portals (addresses live in config.js) ---------- */
    var VIEWS = ["overview"];
    function route() {
        var v = (location.hash || "#overview").slice(1);
        if (VIEWS.indexOf(v) < 0) v = "overview";
        VIEWS.forEach(function (n) { $("v-" + n).hidden = n !== v; });
        document.querySelectorAll(".nav a[data-view]").forEach(function (a) {
            if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
        });
        if (mq.matches) { shell.classList.remove("open"); syncAria(); }
    }
    window.addEventListener("hashchange", route);
    route();
    document.querySelectorAll("[data-link]").forEach(function (a) {
        var url = cfg[a.dataset.link];
        if (url) a.setAttribute("href", url);
        else a.addEventListener("click", function (e) { e.preventDefault(); toast("This page isn't linked yet. Set " + a.dataset.link + " in config.js."); });
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
    var profileEl = $("profile"), linkEl = $("link-modal");
    document.addEventListener("keydown", function (e) {
        var open = Array.prototype.slice.call(document.querySelectorAll(".modal.open")).pop();
        if (!open) return;
        if (e.key === "Escape") {
            if (open.id === "scan-modal") closeScan();
            else if (open.id === "profile" || open.id === "pl-modal") closeModal(open);     // the link prompt can only be confirmed or logged out of
            return;
        }
        if (e.key === "Tab") {
            var f = Array.prototype.filter.call(open.querySelectorAll("button:not([disabled]),input:not([disabled])"), function (x) { return x.offsetParent !== null; });
            if (!f.length) return;
            var first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
    profileEl.addEventListener("mousedown", function (e) { if (e.target === profileEl) closeModal(profileEl); });
    profileEl.querySelector("[data-close]").onclick = function () { closeModal(profileEl); };
    $("open-profile").onclick = function () { openModal(profileEl); };

    /* ---------- data ---------- */
    var firstLoad = true;
    async function refresh() {
        var token = getToken();
        if (!token) return goToLogin();
        var res;
        try { res = await db.rpc("parent_portal", { p_token: token }); if (res.error) throw res.error; }
        catch (err) { console.error("parent_portal failed:", err); setErr($("app-err"), "Can't reach TapMate right now. Retrying…"); return; }
        if (!res.data) return goToLogin();   // expired or invalid session

        var d = res.data;
        setErr($("app-err"), "");
        renderParent(d.parent);

        if (!d.linked) {
            renderEmpty(d.pending);
            if (d.pending) showLink(d.pending); else hideLink();
            return;
        }
        hideLink();
        if (!d.student) {
            console.error("parent_portal: student data unavailable:", d.student_error);
            renderEmpty(null);
            return setErr($("app-err"), "Can't load your student's wallet right now. Retrying…");
        }
        state.student = d.student.profile;
        state.tx = d.student.transactions || []; state.txOk = d.student.transactions_ok !== false;
        $("st-empty").hidden = true; $("st-view").hidden = false;
        renderStudent(d.student.profile);
        renderPayLater(d.student.pay_later);
        renderTx();
    }

    function initials(p) { return ((p.first_name || (p.full_name || "?"))[0] || "") + ((p.last_name || "")[0] || ""); }
    function paintAvatar(el, p) {
        var key = (p.avatar_url || "") + "|" + initials(p);
        if (el.dataset.k === key) return;
        el.dataset.k = key; el.textContent = "";
        if (p.avatar_url) {
            var img = new Image(); img.alt = ""; img.src = p.avatar_url;
            img.onerror = function () { img.remove(); el.textContent = initials(p); };
            el.appendChild(img);
        } else el.textContent = initials(p);
    }
    function renderParent(p) {
        var first = p.first_name || (p.full_name || "").split(" ")[0];
        $("hello").textContent = "Good day, " + first;
        $("side-name").textContent = p.full_name;
        $("pf-name").textContent = p.full_name;
        $("pf-email").textContent = p.email || p.phone || "–";
        paintAvatar($("side-av"), p); paintAvatar($("pf-av"), p);
    }

    /* ---------- the linked student's wallet (same look as the student's own page) ---------- */
    function renderStudent(p) {
        var first = p.first_name || (p.full_name || "").split(" ")[0];
        $("hello-sub").textContent = first + "'s balance and latest activity.";
        $("wal-label").textContent = first + "'s wallet balance";
        $("bal").textContent = peso(p.balance);
        $("bal-updated").textContent = "Updated " + when(p.updated_at);
        $("st-name").textContent = p.full_name;
        $("st-name2").textContent = p.full_name;
        $("st-sid").textContent = p.student_id ? "Student ID " + p.student_id : "";
        paintAvatar($("st-av"), p);
        renderLimit(p, first);
    }
    function renderLimit(p, first) {
        var eff = Number(p.daily_limit) || 0;
        var spent = Number(p.spent_today) || 0, bar = $("lim-bar");
        if (!(eff > 0)) {
            $("lim-text").textContent = "Not set";
            $("lim-fill").style.width = "0%"; bar.className = "bar"; bar.setAttribute("aria-valuenow", 0);
            $("lim-sub").textContent = "No daily limit has been assigned to " + first + " yet.";
            return;
        }
        var pct = Math.min(100, spent / eff * 100);
        $("lim-text").textContent = money(spent) + " of " + money(eff);
        $("lim-fill").style.width = pct + "%";
        bar.className = "bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "");
        bar.setAttribute("aria-valuenow", Math.round(pct));
        $("lim-sub").textContent = spent >= eff ? first + " has reached the limit for today." : money(eff - spent) + " left today";
    }
    function renderTx() {
        var list = $("list-recent"); list.innerHTML = "";
        var rows = state.tx.slice(0, 5);
        if (!rows.length) { li(list, [["empty", state.txOk ? "No transactions yet. Taps and top-ups will show up here." : "Transaction history isn't available yet."]]); list.firstChild.className = "empty"; return; }
        rows.forEach(function (t) {
            var inn = isIn(t);
            li(list, [["what", t.description || TYPE_LABEL[t.type] || "Transaction"],
            ["amt" + (inn ? " in" : ""), (inn ? "+" : "−") + money(Math.abs(t.amount))],
            ["when", when(t.created_at)], ["via", t.location || ""]]);
        });
    }
    function renderEmpty(pending) {
        $("st-view").hidden = true; $("st-empty").hidden = false;
        $("st-scan").hidden = !!pending;   // nothing to scan while a link is waiting for confirmation
        $("hello-sub").textContent = "Your child's balance and latest activity.";
        if (pending) {
            $("empty-title").textContent = "Waiting for your confirmation";
            $("empty-text").textContent = "Confirm the link to " + pending.student_name + " to see their wallet.";
        } else {
            $("empty-title").textContent = "No student linked yet";
            $("empty-text").textContent = "Ask your child to open their TapMate wallet and choose “Link a parent” to show a QR code, then scan it here.";
        }
    }

    /* ---------- Pay Later (the student requests it; only the parent can activate it) ---------- */
    var plEl = $("pl-modal"), plBusy = false;
    function plRules(max) {
        return [
            "Pay Later is for students who need emergency funds: when they weren't able to load their balance, are facing a financial difficulty, or are in an emergency.",
            "It's limited to " + max + " uses. The funds are added directly to the student's tuition and must be paid before it can be activated again.",
            "If Pay Later funds aren't paid on time, the student won't be able to access this feature.",
            "Only you can activate it. Your child sends a request, then you confirm it here."
        ];
    }
    function renderPayLater(pl) {
        state.pl = pl || null;
        var card = $("pl-open");
        if (!pl) { card.hidden = true; return; }   // database not updated yet
        card.hidden = false;
        var first = (state.student && state.student.first_name) || "Your child";
        var on = pl.enabled && !pl.overdue, req = !!pl.activation_pending && !on;
        $("plc-sub").textContent = on ? money(pl.available) + " available of " + money(pl.limit)
            : req ? first + " asked you to activate Pay Later" : "Not active. Tap to learn more.";
        var b = $("plc-badge");
        b.hidden = !(on || req);
        b.textContent = on ? "Active" : "Request waiting";

        // modal content
        var rules = $("plm-rules"); rules.innerHTML = "";
        plRules(pl.max_uses).forEach(function (t) { var p = document.createElement("p"); p.textContent = t; rules.appendChild(p); });
        $("plm-stats").hidden = !on;
        if (on) { $("plm-avail").textContent = money(pl.available); $("plm-limit").textContent = money(pl.limit); $("plm-out").textContent = money(pl.outstanding); }
        var go = $("plm-go");
        if (on) { go.disabled = true; go.textContent = "Pay Later is already active"; }
        else if (req) { go.disabled = plBusy; go.textContent = plBusy ? "Activating…" : "Activate Pay Later"; }
        else { go.disabled = true; go.textContent = "This student hasn't requested for an activation yet."; }
        setErr($("plm-msg"), pl.overdue ? "Pay Later is unavailable until the student's unpaid Pay Later funds (" + money(pl.outstanding) + ") are settled." : "");
    }
    $("pl-open").onclick = function () { if (state.pl) openModal(plEl); };
    plEl.addEventListener("mousedown", function (e) { if (e.target === plEl) closeModal(plEl); });
    plEl.querySelector("[data-close]").onclick = function () { closeModal(plEl); };
    $("plm-go").onclick = async function () {
        if (plBusy || !state.pl || !state.pl.activation_pending) return;
        plBusy = true; renderPayLater(state.pl);
        var res;
        try { res = await db.rpc("parent_activate_pay_later", { p_token: getToken() }); if (res.error) throw res.error; }
        catch (err) { console.error(err); plBusy = false; renderPayLater(state.pl); return setErr($("plm-msg"), "Can't reach TapMate right now. Please try again."); }
        plBusy = false;
        var r = res.data || {};
        if (r.reason === "session") return goToLogin();
        if (r.ok) { closeModal(plEl); toast("Pay Later activated."); }
        else {
            var M = {
                already: "Pay Later is already active.", overdue: "Pay Later is unavailable until the unpaid amount is settled.",
                outstanding: "The student has an unpaid Pay Later amount to settle first.", max_uses: "The student has used all their Pay Later activations.",
                no_student: "No student is linked to your account."
            };
            setErr($("plm-msg"), M[r.reason] || "Something went wrong. Please try again.");
        }
        refresh();
    };

    /* ---------- first login: confirm the link ---------- */
    var agree = $("lk-agree"), go = $("lk-go"), linking = false;
    function showLink(p) {
        $("lk-name").textContent = p.student_name;
        if (!linkEl.hidden) return;
        agree.checked = false; go.disabled = true; setErr($("lk-msg"), "");
        openModal(linkEl);
    }
    function hideLink() { if (!linkEl.hidden && !linking) closeModal(linkEl); }
    agree.addEventListener("change", function () { go.disabled = !agree.checked || linking; });
    $("lk-out").onclick = signOut;
    go.onclick = async function () {
        if (!agree.checked || linking) return;
        linking = true; go.disabled = true; go.textContent = "Linking…";
        var res;
        try { res = await db.rpc("parent_confirm_link", { p_token: getToken() }); if (res.error) throw res.error; }
        catch (err) {
            console.error(err); linking = false; go.textContent = "Confirm & Link Account"; go.disabled = !agree.checked;
            return setErr($("lk-msg"), "Can't reach TapMate right now. Please try again.");
        }
        linking = false; go.textContent = "Confirm & Link Account";
        var r = res.data || {};
        if (r.reason === "session") return goToLogin();
        if (r.ok) { closeModal(linkEl); toast("Your account is now linked to " + $("lk-name").textContent + "."); return refresh(); }
        var M = { taken: "This student already has a linked parent.", none: "There's nothing to link right now." };
        setErr($("lk-msg"), M[r.reason] || "Something went wrong. Please try again.");
        go.disabled = !agree.checked;
        if (r.reason === "taken" || r.reason === "none") refresh();
    };

    /* ---------- Link to a student now: scan their QR with the camera, then enter the PIN ---------- */
    var scanEl = $("scan-modal"), scVideo = $("sc-video"), scCanvas = $("sc-canvas");
    var scStream = null, scRaf = 0, scBusy = false, scLink = "";
    var SC_ERR = {
        invalid_link: "That QR code isn't valid. Ask your child to refresh it and try again.",
        used: "That QR code was already used. Ask your child to refresh it.",
        expired: "That QR code expired. Ask your child to refresh it.",
        already_linked: "That student already has a linked parent.",
        parent_linked: "Your account is already linked to a student.",
        busy: "Too many attempts right now. Please try again in a few minutes.",
        wrong_pin: "That PIN isn't right. Check your child's screen and try again.",
        locked: "Too many wrong PINs. Ask your child to refresh the QR code, then scan it again.",
        pin_not_issued: "Your child's screen isn't showing a PIN yet. Scan the QR code again."
    };
    function scLinkFrom(text) {
        try { var l = new URL(text, location.href).searchParams.get("link"); if (l) return l; } catch (_) { }
        return /^[A-Za-z0-9_-]{16,}$/.test(text) ? text : "";
    }
    function scStep(which) { $("sc-step-scan").hidden = which !== "scan"; $("sc-step-pin").hidden = which !== "pin"; }
    function scStop() {
        cancelAnimationFrame(scRaf); scRaf = 0;
        if (scStream) { scStream.getTracks().forEach(function (t) { t.stop(); }); scStream = null; }
        scVideo.srcObject = null;
    }
    function closeScan() { scStop(); closeModal(scanEl); }
    // The QR reader normally loads with the page; if it didn't, try again here (own copy first, then a CDN)
    function loadScript(src) {
        return new Promise(function (ok, no) {
            var s = document.createElement("script");
            s.src = src; s.onload = ok; s.onerror = no;
            document.head.appendChild(s);
        });
    }
    async function ensureQrReader() {
        var srcs = ["../PARENT OVERVIEW/jsQR.js", "jsQR.js", "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"];
        for (var i = 0; i < srcs.length && !window.jsQR; i++) { try { await loadScript(srcs[i]); } catch (_) { } }
        return !!window.jsQR;
    }
    async function openScan() {
        scLink = ""; scBusy = false; scStep("scan"); setErr($("sc-msg"), ""); $("sc-pin").value = "";
        openModal(scanEl);
        // Ask for the camera first, inside the tap: Safari only allows the prompt from a user gesture
        var md = navigator.mediaDevices;
        if (!md || !md.getUserMedia) {
            return setErr($("sc-msg"), window.isSecureContext === false
                ? "The camera needs a secure (https) connection. Open this page using its https address."
                : "This browser can't use the camera (in-app browsers like Facebook or Messenger often can't). Open this page in Safari or Chrome.");
        }
        try {
            scStream = await md.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
            scVideo.setAttribute("playsinline", ""); scVideo.muted = true;
            scVideo.srcObject = scStream;
            await scVideo.play();
        } catch (err) {
            console.error(err); scStop();
            return setErr($("sc-msg"), err && err.name === "NotAllowedError"
                ? "Camera access is blocked. Allow the camera for this site in your browser settings, then tap Link to a student again."
                : "We couldn't open the camera. Close other apps that might be using it, then try again.");
        }
        if (!window.jsQR && !(await ensureQrReader())) {
            scStop();
            return setErr($("sc-msg"), "The QR scanner couldn't load. Check your connection and try again.");
        }
        scTick();
    }
    function scTick() {
        if (!scStream) return;
        if (!scBusy && scVideo.readyState === scVideo.HAVE_ENOUGH_DATA && scVideo.videoWidth) {
            var w = Math.min(640, scVideo.videoWidth), h = Math.round(w * scVideo.videoHeight / scVideo.videoWidth);
            scCanvas.width = w; scCanvas.height = h;
            var ctx = scCanvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(scVideo, 0, 0, w, h);
            var code = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
            if (code && code.data) scFound(code.data);
        }
        scRaf = requestAnimationFrame(scTick);
    }
    async function scFound(text) {
        scBusy = true;
        var link = scLinkFrom(text);
        if (!link) {
            setErr($("sc-msg"), "That isn't a TapMate student QR code. Scan the one on your child's wallet.");
            return setTimeout(function () { scBusy = false; }, 1800);
        }
        var res;
        try { res = await db.rpc("parent_scan_link", { p_token: getToken(), p_link: link }); if (res.error) throw res.error; }
        catch (err) { console.error(err); setErr($("sc-msg"), "Can't reach TapMate right now. Please try again."); return setTimeout(function () { scBusy = false; }, 1800); }
        var r = res.data || {};
        if (r.reason === "session") { scStop(); return goToLogin(); }
        if (!r.ok) { setErr($("sc-msg"), SC_ERR[r.reason] || "Something went wrong. Please try again."); return setTimeout(function () { scBusy = false; }, 2200); }
        scLink = link; scStop(); setErr($("sc-msg"), "");
        $("sc-pin-text").textContent = "Enter the PIN code shown on " + (r.student_name || "your child") + "'s screen.";
        scStep("pin");
        setTimeout(function () { $("sc-pin").focus(); }, 60);
    }
    $("sc-pin").addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 4); setErr($("sc-msg"), ""); });
    $("sc-step-pin").addEventListener("submit", async function (e) {
        e.preventDefault();
        var pin = $("sc-pin").value;
        if (!/^\d{4}$/.test(pin)) return setErr($("sc-msg"), "Enter the 4-digit PIN from your child's screen.");
        var go = $("sc-pin-go"); go.disabled = true;
        var res;
        try { res = await db.rpc("parent_link_with_pin", { p_token: getToken(), p_link: scLink, p_pin: pin }); if (res.error) throw res.error; }
        catch (err) { console.error(err); go.disabled = false; return setErr($("sc-msg"), "Can't reach TapMate right now. Please try again."); }
        go.disabled = false;
        var r = res.data || {};
        if (r.reason === "session") return goToLogin();
        if (r.ok) { closeScan(); toast("Almost done. Confirm the link to " + (r.student_name || "your child") + "."); return refresh(); }   // the confirm prompt opens from the pending link
        setErr($("sc-msg"), SC_ERR[r.reason] || "Something went wrong. Please try again.");
        if (r.reason === "locked" || r.reason === "expired" || r.reason === "used" || r.reason === "invalid_link") { $("sc-pin").value = ""; openScan(); setErr($("sc-msg"), SC_ERR[r.reason]); }
        else { $("sc-pin").value = ""; $("sc-pin").focus(); }
    });
    $("st-scan").onclick = openScan;
    scanEl.addEventListener("mousedown", function (e) { if (e.target === scanEl) closeScan(); });
    scanEl.querySelector("[data-close]").onclick = closeScan;

    /* ---------- go ---------- */
    refresh();
    setInterval(refresh, POLL_MS);
})();
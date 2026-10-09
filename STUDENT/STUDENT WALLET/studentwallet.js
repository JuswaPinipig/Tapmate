(function () {
    var cfg = window.APP_CONFIG || {};
    var SESSION_KEY = "tapmate_session";   // set by login.js after RFID + PIN
    var POLL_MS = 15000;
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var state = { tx: [], txOk: true, profile: null, pin: null, pl: null, parent: null };

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
    var TYPE_LABEL = { topup: "Wallet top-up", purchase: "Purchase", refund: "Refund" };
    function isIn(t) { return t.type ? t.type !== "purchase" : Number(t.amount) > 0; }
    var toastEl = $("toast"), tm;
    function toast(m) { toastEl.textContent = m; toastEl.classList.add("show"); clearTimeout(tm); tm = setTimeout(function () { toastEl.classList.remove("show"); }, 2400); }
    function setErr(el, msg) { el.textContent = msg || ""; el.hidden = !msg; }
    function li(listEl, parts) {
        var e = document.createElement("li");
        parts.forEach(function (p) { var s = document.createElement("span"); s.className = p[0]; s.textContent = p[1]; e.appendChild(s); });
        listEl.appendChild(e);
    }

    /* ---------- cabinet (collapsible sidebar) ---------- */
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

    /* ---------- views (Student Wallet only; Pay Later + Parent Link live inside it) ----------
       History and User Top Up are separate portals: addresses in config.js. */
    var VIEWS = ["wallet"];
    function route() {
        var v = (location.hash || "#wallet").slice(1);
        if (VIEWS.indexOf(v) < 0) v = "wallet";
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
    // Confirm dialog that resolves true (confirm) or false (go back)
    var cfResolve = null;
    function ask(title, text, yes) {
        $("cf-title").textContent = title; $("cf-text").textContent = text; $("cf-ok").textContent = yes || "Confirm";
        openModal($("confirm"));
        return new Promise(function (r) { cfResolve = r; });
    }
    function answer(v) { closeModal($("confirm")); var r = cfResolve; cfResolve = null; if (r) r(v); }
    $("cf-back").onclick = function () { answer(false); };
    $("cf-ok").onclick = function () { answer(true); };

    var profileEl = $("profile");
    function closeProfile() { resetPin(); closeModal(profileEl); }
    document.addEventListener("keydown", function (e) {
        var open = Array.prototype.slice.call(document.querySelectorAll(".modal.open")).pop();
        if (!open) return;
        if (e.key === "Escape") {
            if (open.id === "confirm") answer(false); else if (open.id === "profile") closeProfile(); else closeModal(open);
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
    profileEl.addEventListener("mousedown", function (e) { if (e.target === profileEl) closeProfile(); });
    profileEl.querySelector("[data-close]").onclick = closeProfile;
    $("open-profile").onclick = function () { openModal(profileEl); };

    /* ---------- data ---------- */
    async function refresh() {
        var token = getToken();
        if (!token) return goToLogin();
        var res;
        try { res = await db.rpc("student_portal", { p_token: token }); if (res.error) throw res.error; }
        catch (err) { console.error("student_portal failed:", err); setErr($("app-err"), "Can't reach TapMate right now. Retrying…"); return; }
        if (!res.data) return goToLogin();   // expired or invalid session

        setErr($("app-err"), "");
        var d = res.data;
        state.profile = d.profile; state.pin = d.pin;
        state.tx = d.transactions || []; state.txOk = d.transactions_ok !== false;
        renderProfile(d.profile); renderLimit(d.profile); renderCard(d.card, d.profile);
        renderPin(d.pin); state.parent = d.parent_link || { linked: false }; renderParent(); renderPayLater(d.pay_later); renderTx();
    }

    /* ---------- wallet ---------- */
    function initials(p) { return ((p.first_name || p.full_name || "?")[0] || "") + ((p.last_name || "")[0] || ""); }
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
    function renderProfile(p) {
        $("hello").textContent = "Good day, " + (p.first_name || p.full_name.split(" ")[0]);
        $("bal").textContent = peso(p.balance);
        $("bal-updated").textContent = "Updated " + when(p.updated_at);
        $("side-name").textContent = p.full_name;
        $("side-id").textContent = p.student_id || "";
        $("pf-name").textContent = p.full_name;
        $("pf-sid").textContent = p.student_id ? "Student ID " + p.student_id : "";
        $("pf-email").textContent = p.email || "–";
        paintAvatar($("side-av"), p); paintAvatar($("pf-av"), p);
    }
    // Daily limit bar: shows today's spending against the school-assigned daily limit
    function renderLimit(p) {
        var eff = Number(p.daily_limit) || 0;
        var spent = Number(p.spent_today) || 0, bar = $("lim-bar");
        if (!(eff > 0)) {
            $("lim-label").textContent = "Daily limit"; $("lim-text").textContent = "Not set";
            $("lim-fill").style.width = "0%"; bar.className = "bar"; bar.setAttribute("aria-valuenow", 0);
            $("lim-sub").textContent = "No daily limit has been assigned to you yet.";
            return;
        }
        var pct = Math.min(100, spent / eff * 100);
        $("lim-label").textContent = "Daily limit";
        $("lim-text").textContent = money(spent) + " of " + money(eff);
        $("lim-fill").style.width = pct + "%";
        bar.className = "bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "");
        bar.setAttribute("aria-valuenow", Math.round(pct));
        $("lim-sub").textContent = (spent >= eff ? "You've reached your limit for today." : money(eff - spent) + " left today");
    }
    function renderCard(c, p) {
        $("r-num").textContent = c ? "•••• •••• " + c.uid_last4 : "No card linked";
        $("rfid-empty").hidden = !!c; $("rfid-body").hidden = !c;
        if (!c) return;
        var locked = !!c.locked_until, noPin = !c.has_pin;
        $("dot").classList.toggle("off", locked || noPin);
        $("rstat").textContent = locked ? "Temporarily locked" : noPin ? "PIN needed" : "Active";
        $("rsub").textContent = locked ? "Too many wrong PINs. Try again after " + when(c.locked_until)
            : noPin ? "Ask an admin to set your PIN"
                : "Can be used for school gate pass and school canteen";
        $("r-pin").textContent = c.has_pin ? "••••" : "Not set";   // treated like a password
        $("r-sid").textContent = p.student_id || "–";
    }
    function renderTx() {
        var list = $("list-recent"); list.innerHTML = "";
        var rows = state.tx.slice(0, 5);
        if (!rows.length) { li(list, [["empty", state.txOk ? "No transactions yet. Your taps and top-ups will show up here." : "Transaction history isn't available yet."]]); list.firstChild.className = "empty"; return; }
        rows.forEach(function (t) {
            var inn = isIn(t);
            li(list, [["what", t.description || TYPE_LABEL[t.type] || "Transaction"],
            ["amt" + (inn ? " in" : ""), (inn ? "+" : "−") + money(Math.abs(t.amount))],
            ["when", when(t.created_at)], ["via", t.location || ""]]);
        });
    }

    /* ---------- Pay Later (all numbers come from the database) ---------- */
    function plInfo(max) {
        return [
            "Pay Later is for students who need emergency funds: when you weren't able to load your balance, are facing a financial difficulty, or are in an emergency. Please activate it only in these situations.",
            "Pay Later is limited to " + max + " uses. The funds are added directly to your tuition and must be paid before you can activate this feature again.",
            "If Pay Later funds aren't paid on time, you won't be able to access this feature."
        ];
    }
    function renderPayLater(pl) {
        state.pl = pl; if (!pl) return;
        var linked = !!(state.parent && state.parent.linked);
        $("pl-locked").hidden = linked;
        if (!linked) { $("pl-on").hidden = true; $("pl-off").hidden = true; return; }   // locked until a parent is linked
        var on = pl.enabled && !pl.overdue;
        $("pl-on").hidden = !on; $("pl-off").hidden = on;
        if (on) {
            $("pl-avail").textContent = money(pl.available); $("pl-limit").textContent = money(pl.limit); $("pl-out").textContent = money(pl.outstanding);
            $("pl-due").textContent = Number(pl.limit) <= 0 ? "Your Pay Later limit hasn't been set yet. It will show here once the admin sets it."
                : Number(pl.outstanding) > 0 ? "Pay " + money(pl.outstanding) + (pl.due_at ? " by " + when(pl.due_at) : "") + ". It's added to your tuition. If it isn't paid on time, you won't be able to access this feature."
                    : "Nothing is due right now.";
            $("pl-uses").textContent = "Activations used: " + pl.used_count + " of " + pl.max_uses + ".";
            $("pl-request").disabled = !!pl.request_pending;
            $("pl-request").textContent = pl.request_pending ? "Request pending" : "Request a higher limit";
            setErr($("pl-msg2"), pl.request_pending ? "Your request is waiting for the admin to review it." : "");
            return;
        }
        $("pl-title").textContent = pl.overdue ? "Pay Later is unavailable" : "Pay Later is off";
        var rules = $("pl-rules"); rules.innerHTML = "";
        plInfo(pl.max_uses).forEach(function (t) { var p = document.createElement("p"); p.textContent = t; rules.appendChild(p); });
        setErr($("pl-msg"), pl.overdue ? "Your Pay Later funds (" + money(pl.outstanding) + (pl.due_at ? ", due " + when(pl.due_at) : "") + ") weren't paid on time, so you can't access this feature. Settle the amount to regain access."
            : pl.used_count >= pl.max_uses ? "You've used all " + pl.max_uses + " Pay Later activations."
                : Number(pl.outstanding) > 0 ? "Pay your outstanding " + money(pl.outstanding) + " before activating Pay Later again." : "");
        $("pl-activate").disabled = !pl.can_activate;
    }
    async function plCall(fn, btn, okMsg, errMap) {
        btn.disabled = true;
        var res;
        try { res = await db.rpc(fn, { p_token: getToken() }); if (res.error) throw res.error; }
        catch (err) { console.error(err); toast("Can't reach TapMate right now."); await refresh(); return; }
        var r = res.data || {};
        if (r.reason === "session") return goToLogin();
        toast(r.ok ? okMsg : (errMap[r.reason] || "Something went wrong."));
        await refresh();
    }
    $("pl-activate").onclick = async function () {
        if (!(state.parent && state.parent.linked)) return toast("Link a parent first to unlock Pay Later.");
        var ok = await ask("Activate Pay Later?", plInfo(state.pl.max_uses).join("\n\n"), "Activate");
        if (!ok) return;
        plCall("student_activate_pay_later", this, "Pay Later activated.", {
            already: "Pay Later is already active.", no_parent: "Link a parent first to unlock Pay Later.", overdue: "Pay Later is unavailable until your payment is settled.",
            outstanding: "Pay your outstanding amount first.", max_uses: "You've used all your Pay Later activations."
        });
    };
    $("pl-request").onclick = async function () {
        var ok = await ask("Request a higher limit?", "The admin will review your Pay Later payment history before approving. You'll see your new limit here once it's approved.", "Send request");
        if (!ok) return;
        plCall("student_request_pay_later_increase", this, "Request sent to the admin.", {
            pending: "You already have a pending request.", inactive: "Activate Pay Later first.", overdue: "Pay Later is unavailable until your payment is settled."
        });
    };

    /* ---------- Parent link (popup: QR + 6-digit fallback, new code every 10 minutes) ---------- */
    var plinkEl = $("plink-modal");
    var PL = { exp: 0, timer: null, busy: false, lastPoll: 0 };
    function fmtCode(c) { return c ? c.slice(0, 3) + " " + c.slice(3) : "––– –––"; }
    function drawQr(text) {
        var box = $("qr-box"); box.innerHTML = "";
        if (!window.QRCode) { box.textContent = "QR unavailable"; return; }
        new QRCode(box, { text: text, width: 156, height: 156, correctLevel: QRCode.CorrectLevel.M });
    }
    async function newParentCode(manual) {
        if (PL.busy) return; PL.busy = true;
        var btn = $("plink-new"); btn.disabled = true;
        var res;
        try { res = await db.rpc("student_create_parent_link", { p_token: getToken() }); if (res.error) throw res.error; }
        catch (err) {
            console.error(err); PL.busy = false; btn.disabled = false; PL.exp = 0;
            return setErr($("plink-msg"), "Can't make a QR code right now. Tap “Refresh QR code” to try again.");
        }
        PL.busy = false; btn.disabled = false;
        var r = res.data || {};
        // Never bounce to login from here: a parent-link problem must not log the student out.
        if (r.reason === "linked") { closeModal(plinkEl); toast("Parent linked."); return refresh(); }
        if (!r.ok) {
            console.error("student_create_parent_link:", JSON.stringify(r)); PL.exp = 0;
            return setErr($("plink-msg"), "Could not make a QR code (" + (r.reason || "unknown") + "). Tap “Refresh QR code” to try again.");
        }
        setErr($("plink-msg"), "");
        PL.exp = new Date(r.expires_at).getTime();
        var base = cfg.PARENT_LINK_URL;
        // A phone can't follow a relative path, so turn it into a full https://... address first.
        if (base) { try { base = new URL(base, location.href).href; } catch (_) { } }
        drawQr(base ? base + (base.indexOf("?") < 0 ? "?" : "&") + "link=" + encodeURIComponent(r.qr_token) : "tapmate-link:" + r.qr_token);
        $("qr-box").classList.remove("stale");
        if (manual) toast("QR code refreshed.");
    }
    function tickParent() {
        if (plinkEl.hidden || !PL.exp) return;
        var left = Math.max(0, PL.exp - Date.now());
        if (left <= 0) { $("qr-box").classList.add("stale"); newParentCode(false); return; }
        if (Date.now() - PL.lastPoll > 4000) { PL.lastPoll = Date.now(); refresh(); }   // notice the parent linking
    }
    function renderParent() {
        var p = state.parent || { linked: false };
        $("pw-dot").classList.toggle("off", !p.linked);
        $("pw-text").textContent = p.linked ? (p.parent_name ? "Linked to " + p.parent_name : "Parent linked") : "Parent not currently linked";
        $("pw-btn").hidden = !!p.linked;
        if (p.linked && !plinkEl.hidden) { PL.exp = 0; closeModal(plinkEl); toast("Parent linked."); }
    }
    $("pw-btn").onclick = function () {
        PL.exp = 0; $("qr-box").innerHTML = ""; setErr($("plink-msg"), "");
        openModal(plinkEl);
        if (!PL.timer) PL.timer = setInterval(tickParent, 1000);
        newParentCode(false);
    };
    plinkEl.addEventListener("mousedown", function (e) { if (e.target === plinkEl) closeModal(plinkEl); });
    plinkEl.querySelector("[data-close]").onclick = function () { closeModal(plinkEl); };
    $("plink-new").onclick = function () { newParentCode(true); };

    /* ---------- PIN management (the only profile item a student can change) ---------- */
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
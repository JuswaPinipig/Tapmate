(function () {
    var cfg = window.APP_CONFIG || {}, SESSION_KEY = cfg.SESSION_KEY, LOCALE = cfg.LOCALE, CUR = cfg.CURRENCY_SYMBOL;
    var REF_LEN = 0, MAX_MB = 0;   // loaded from the database (student_topup_settings), never hard-coded here
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var S = { children: [], sid: null, profile: null, amount: null, file: null, busy: false, reading: false, readSeq: 0, aiRef: null, sig: null, plSig: null };

    /* ---------- session ---------- */
    function getToken() { try { var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); return s && s.token || null; } catch (_) { return null; } }
    function goToLogin() { try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { } location.replace(cfg.LOGIN_URL); }
    $("signout").onclick = async function () { var t = getToken(); if (t) { try { await db.rpc("card_logout", { p_token: t }); } catch (_) { } } goToLogin(); };

    /* ---------- helpers ---------- */
    function peso(n) { return Number(n || 0).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function money(n) { return CUR + peso(n); }
    function when(iso) { return iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" }) : "–"; }
    function setErr(el, m) { el.textContent = m || ""; el.hidden = !m; }
    function initialsOf(n) { var p = String(n || "").trim().split(/\s+/).filter(Boolean); return p.length ? (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() : "?"; }
    var tm; function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tm); tm = setTimeout(function () { t.classList.remove("show"); }, 2800); }
    function child() { return S.children.filter(function (c) { return c.id === S.sid; })[0] || null; }

    /* ---------- sidebar ---------- */
    var shell = $("shell"), mq = matchMedia("(max-width:760px)");
    try { if (localStorage.getItem("pw_collapsed") === "1") shell.classList.add("collapsed"); } catch (_) { }
    requestAnimationFrame(function () { requestAnimationFrame(function () { shell.classList.remove("init"); }); });
    $("collapse").onclick = function () { if (mq.matches) shell.classList.remove("open"); else { shell.classList.toggle("collapsed"); try { localStorage.setItem("pw_collapsed", shell.classList.contains("collapsed") ? "1" : "0"); } catch (_) { } } };
    $("menu").onclick = function () { shell.classList.add("open"); };
    $("scrim").onclick = function () { shell.classList.remove("open"); };

    /* two views in one page: Top Up and Pay Later */
    function showView(name) {
        if (name !== "paylater") name = "topup";
        ["topup", "paylater"].forEach(function (v) { $("v-" + v).hidden = v !== name; });
        document.querySelectorAll(".nav a").forEach(function (a) { if (a.dataset.view === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
        shell.classList.remove("open");
        if (name === "paylater") loadEntries(true);
    }
    document.querySelectorAll(".nav a").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); history.replaceState(null, "", "#" + a.dataset.view); showView(a.dataset.view); window.scrollTo(0, 0); }); });

    /* ---------- confirm dialog ---------- */
    var cfEl = $("confirm-dlg"), cfRes = null;
    function ask(o) {
        $("cf-title").textContent = o.title; $("cf-ref").textContent = o.ref || ""; $("cf-ref").hidden = !o.ref;
        $("cf-text").textContent = o.text; $("cf-back").textContent = o.no; $("cf-ok").textContent = o.yes;
        cfEl.hidden = false; requestAnimationFrame(function () { cfEl.classList.add("open"); });
        setTimeout(function () { $("cf-back").focus(); }, 60);
        return new Promise(function (r) { cfRes = r; });
    }
    function answer(v) { cfEl.classList.remove("open"); setTimeout(function () { cfEl.hidden = true; }, 260); var r = cfRes; cfRes = null; if (r) r(v); }
    $("cf-back").onclick = function () { answer(false); }; $("cf-ok").onclick = function () { answer(true); };

    /* ---------- profile (view only) + PIN ---------- */
    var pdEl = $("profile-dlg");
    function openProfile() { shell.classList.remove("open"); paintProfile(); $("pin-form").reset(); setErr($("pin-err"), ""); pdEl.hidden = false; requestAnimationFrame(function () { pdEl.classList.add("open"); }); }
    function closeProfile() { pdEl.classList.remove("open"); setTimeout(function () { pdEl.hidden = true; }, 230); }
    $("open-profile").onclick = openProfile; $("pd-close").onclick = closeProfile;
    pdEl.addEventListener("mousedown", function (e) { if (e.target === pdEl) closeProfile(); });
    document.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; if (cfRes) answer(false); else if (!pdEl.hidden) closeProfile(); });

    function paintAvatar(el, p) {
        el.textContent = ""; var ini = initialsOf(p.full_name);
        if (p.avatar_url) { var i = new Image(); i.alt = ""; i.src = p.avatar_url; i.onerror = function () { i.remove(); el.textContent = ini; }; el.appendChild(i); } else el.textContent = ini;
    }
    function paintProfile() {
        var p = S.profile; if (!p) return;
        $("pd-name").textContent = p.full_name || "Parent"; $("pd-email").textContent = p.email || ""; $("pd-phone").textContent = p.phone || "–";
        $("pd-kids").textContent = S.children.length ? S.children.map(function (c) { return c.full_name; }).join(", ") : "None yet";
        paintAvatar($("pd-av"), p);
        var limit = p.pin_limit || 3, used = p.pin_used || 0, left = Math.max(0, limit - used), reached = left === 0;
        $("pin-left").textContent = "PIN changes remaining: " + left + "/" + limit;
        $("pin-meter").hidden = reached; $("pin-limit").hidden = !reached;
        if (reached) $("pin-limit-t").textContent = "You have reached the maximum of " + limit + " PIN changes within 24 hours. You can change your PIN again after the cooldown ends" + (p.pin_next_at ? " (" + when(p.pin_next_at) + ")." : ".");
        ["pin-cur", "pin-new", "pin-new2", "pin-save"].forEach(function (id) { $(id).disabled = reached; });
    }
    ["pin-cur", "pin-new", "pin-new2"].forEach(function (id) { $(id).addEventListener("input", function () { this.value = this.value.replace(/\D/g, "").slice(0, 4); }); });
    $("pin-form").addEventListener("submit", async function (e) {
        e.preventDefault(); var p = S.profile; if (!p) return;
        var cur = $("pin-cur").value, nw = $("pin-new").value, n2 = $("pin-new2").value;
        function fail(m, el) { setErr($("pin-err"), m); if (el) el.focus(); }
        setErr($("pin-err"), "");
        if (!/^\d{4}$/.test(cur)) return fail("Enter your current 4-digit PIN.", $("pin-cur"));
        if (!/^\d{4}$/.test(nw)) return fail("Your new PIN must be exactly 4 digits.", $("pin-new"));
        if (nw === cur) return fail("Your new PIN must be different from your current PIN.", $("pin-new"));
        if (nw !== n2) return fail("The new PINs don't match.", $("pin-new2"));
        var left = (p.pin_limit || 3) - (p.pin_used || 0);
        var yes = await ask({ title: "Change your PIN?", yes: "Change PIN", no: "Go back", text: "This uses 1 of your remaining PIN changes (" + left + " left in this 24-hour period)." });
        if (!yes) return;
        $("pin-save").disabled = true;
        try {
            var res = await db.rpc("parent_change_own_pin", { p_token: getToken(), p_current: cur, p_new: nw });
            if (res.error) throw res.error;
            Object.assign(S.profile, res.data || {}); $("pin-form").reset(); toast("PIN changed.");
        } catch (err) { fail(err.message || "Couldn't change your PIN. Please try again.", $("pin-cur")); load(); }
        paintProfile();
    });

    /* ---------- portal data ---------- */
    function load() { return loadPortal(); }
    async function loadPortal() {
        var t = getToken(); if (!t) return goToLogin();
        var res; try { res = await db.rpc("parent_portal", { p_token: t }); if (res.error) throw res.error; } catch (e) { console.error(e); return setErr($("app-err"), "Can't reach TapMate right now."); }
        if (!res.data) return goToLogin();
        setErr($("app-err"), "");
        S.profile = res.data.profile || {}; S.children = res.data.children || [];
        $("side-name").textContent = S.profile.full_name || "Parent"; paintAvatar($("side-av"), S.profile);
        if (!pdEl.hidden) paintProfile();
        $("no-child").hidden = S.children.length > 0; $("app").hidden = !S.children.length;
        if (!S.children.length) return;
        if (!child()) S.sid = S.children[0].id;
        paintPicker(); paintChild(); loadHistory(); loadEntries();
    }

    function paintPicker() {
        var sel = $("child-sel"), sig = S.children.map(function (c) { return c.id + c.full_name; }).join("|");
        if (sel.dataset.sig !== sig) {
            sel.innerHTML = ""; S.children.forEach(function (c) { var o = document.createElement("option"); o.value = c.id; o.textContent = c.full_name + (c.student_id ? " (" + c.student_id + ")" : ""); sel.appendChild(o); }); sel.dataset.sig = sig;
        }
        sel.value = S.sid;
        var one = S.children.length === 1;
        sel.hidden = one; document.querySelector('label[for="child-sel"]').hidden = one;
        $("child-one").hidden = !one; if (one) $("child-one").textContent = S.children[0].full_name + (S.children[0].student_id ? " (" + S.children[0].student_id + ")" : "");
    }
    $("child-sel").onchange = function () {
        S.sid = this.value; clearFile(); S.amount = null; document.querySelectorAll("#chips button").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
        S.sig = null; S.plSig = null; paintChild(); update(); loadHistory(true); loadEntries(true);
    };

    function paintChild() {
        var c = child(); if (!c) return;
        $("w-lbl").textContent = c.full_name + "'s wallet balance"; $("bal").textContent = peso(c.balance); $("bal-updated").textContent = "Updated " + when(c.updated_at);
        paintPayLater(c);
    }

    /* ---------- pay later ---------- */
    function paintPayLater(c) {
        var limit = Number(c.pay_later_limit || 0), out = Number(c.outstanding || 0), avail = Math.max(0, limit - out), on = !!c.pay_later_enabled;
        $("pl-name").textContent = c.full_name;
        var b = $("pl-badge"); b.textContent = on ? "Active" : "Not active"; b.className = "badge" + (on ? " ok" : "");
        $("pl-limit").textContent = money(limit); $("pl-out").textContent = money(out); $("pl-avail").textContent = money(avail);
        var pct = limit > 0 ? Math.min(100, Math.round(out / limit * 100)) : 0, bar = $("pl-bar");
        bar.firstElementChild.style.width = pct + "%"; bar.classList.toggle("warn", pct >= 80 && pct < 100); bar.classList.toggle("full", pct >= 100);
        $("pl-usage").textContent = out > 0 ? "You've used " + pct + "% of the limit (" + money(out) + " of " + money(limit) + ")." : "Nothing has built up yet.";
        $("pl-toggle").textContent = on ? "Deactivate pay later" : "Activate pay later"; $("pl-toggle").className = on ? "btn-line danger" : "btn-fill";
    }
    $("pl-toggle").onclick = async function () {
        var c = child(); if (!c || S.busy) return;
        var next = !c.pay_later_enabled;
        var yes = await ask({
            title: (next ? "Activate" : "Deactivate") + " pay later for " + c.full_name + "?", yes: next ? "Activate" : "Deactivate", no: "Cancel",
            text: next ? c.full_name + " will be able to buy now and settle later, up to " + money(c.pay_later_limit) + ". What they use builds up on this page until it is paid."
                : c.full_name + " will no longer be able to buy now and settle later." + (Number(c.outstanding) > 0 ? "\n\nThe " + money(c.outstanding) + " already built up stays on the ledger." : "")
        });
        if (!yes) return;
        S.busy = true; this.disabled = true; setErr($("pl-msg"), "");
        try {
            var res = await db.rpc("parent_set_pay_later", { p_token: getToken(), p_student_id: c.id, p_enabled: next });
            if (res.error) throw res.error;
            c.pay_later_enabled = next; paintPayLater(c); toast("Pay later " + (next ? "activated" : "deactivated") + ".");
        } catch (e) { console.error(e); setErr($("pl-msg"), e.message || "Couldn't update pay later. Please try again."); }
        S.busy = false; this.disabled = false;
    };
    function row(ul, cls, parts) { var li = document.createElement("li"); if (cls) li.className = cls; parts.forEach(function (p) { var s = document.createElement("span"); s.className = p[0]; s.textContent = p[1]; li.appendChild(s); }); ul.appendChild(li); }
    async function loadEntries(force) {
        var c = child(); if (!c) return; var ul = $("pl-list"), res;
        try { res = await db.rpc("parent_pay_later_entries", { p_token: getToken(), p_student_id: c.id }); if (res.error) throw res.error; }
        catch (e) { console.error(e); ul.innerHTML = ""; return row(ul, "empty", [["empty", "Pay later activity isn't available yet."]]); }
        var rows = Array.isArray(res.data) ? res.data : [], sig = JSON.stringify(rows);
        if (!force && sig === S.plSig) return; S.plSig = sig; ul.innerHTML = "";
        if (!rows.length) return row(ul, "empty", [["empty", "No pay later activity yet."]]);
        rows.slice(0, 10).forEach(function (r) { var ch = r.kind === "charge"; row(ul, "", [["what", ch ? "Pay later purchase" : "Payment"], ["amt " + (ch ? "out" : "in"), (ch ? "" : "−") + money(r.amount)], ["when", when(r.created_at)], ["via", r.note || ""]]); });
    }

    /* ---------- top-up history (amount, uploaded, approving admin) ---------- */
    var PAGE_SIZE = Number(cfg.HISTORY_PAGE_SIZE) || 4;
    var H = { rows: [], page: 1, sig: null };
    function pageList(cur, total) {
        var i, out = [];
        if (total <= 7) { for (i = 1; i <= total; i++) out.push(i); return out; }
        var a = Math.max(2, cur - 1), b = Math.min(total - 1, cur + 1);
        if (cur <= 3) { a = 2; b = 4; } if (cur >= total - 2) { a = total - 3; b = total - 1; }
        out.push(1); if (a > 2) out.push("…"); for (i = a; i <= b; i++) out.push(i);
        if (b < total - 1) out.push("…"); out.push(total); return out;
    }
    function renderHistory(focus) {
        var ul = $("hist"), pg = $("hist-pager"), rows = H.rows, ae = document.activeElement;
        if (!focus && ae && ae.dataset && ae.dataset.k && pg.contains(ae)) focus = ae.dataset.k;
        ul.innerHTML = ""; pg.innerHTML = "";
        if (!rows.length) { pg.hidden = true; return row(ul, "empty", [["empty", "No top-ups yet. They'll show up here."]]); }
        var pages = Math.ceil(rows.length / PAGE_SIZE); H.page = Math.min(Math.max(H.page, 1), pages);
        rows.slice((H.page - 1) * PAGE_SIZE, H.page * PAGE_SIZE).forEach(function (t) {
            row(ul, "", [["what", "Top-up"], ["amt" + (t.status === "approved" ? " in" : ""), (t.status === "approved" ? "+" : "") + money(t.amount)], ["when", when(t.created_at)],
            ["via", t.status === "approved" ? "Approved by " + (t.approved_by_name || "admin") : t.status === "rejected" ? "Declined" : "Pending review"]]);
        });
        pg.hidden = pages < 2; if (pages < 2) return;
        function btn(label, target, cls, aria, off, key) {
            var b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label; b.setAttribute("aria-label", aria); b.dataset.k = key; b.disabled = !!off;
            if (cls.indexOf("on") > -1) b.setAttribute("aria-current", "page");
            b.onclick = function () { H.page = target; renderHistory(key); }; pg.appendChild(b);
        }
        btn("‹", H.page - 1, "pg arrow", "Previous page", H.page === 1, "prev");
        pageList(H.page, pages).forEach(function (p) {
            if (p === "…") { var g = document.createElement("span"); g.className = "pg-gap"; g.textContent = "…"; g.setAttribute("aria-hidden", "true"); pg.appendChild(g); }
            else btn(String(p), p, H.page === p ? "pg on" : "pg", "Page " + p, false, String(p));
        });
        btn("›", H.page + 1, "pg arrow", "Next page", H.page === pages, "next");
        if (focus) { var f = pg.querySelector('[data-k="' + focus + '"]'); if (!f || f.disabled) f = pg.querySelector('[aria-current="page"]'); if (f) f.focus(); }
    }
    async function loadHistory(toFirstPage) {
        var c = child(), res; if (!c) return;
        try { res = await db.rpc("parent_topup_history", { p_token: getToken(), p_student_id: c.id }); if (res.error) throw res.error; }
        catch (e) { console.error(e); H.rows = []; H.sig = null; $("hist-pager").hidden = true; $("hist").innerHTML = ""; return row($("hist"), "empty", [["empty", "Top-up history isn't available yet."]]); }
        var rows = Array.isArray(res.data) ? res.data : [], sig = c.id + JSON.stringify(rows);
        if (toFirstPage) H.page = 1; else if (sig === H.sig) return;
        H.rows = rows; H.sig = sig; renderHistory();
    }

    $("cur").textContent = CUR;
    var qr = $("qr"); qr.src = encodeURI(cfg.GCASH_QR);
    qr.onerror = function () { qr.replaceWith(Object.assign(document.createElement("p"), { className: "how", textContent: "GCash QR image not found. Check GCASH_QR in config.js." })); };

    /* ---------- settings (amounts, reference length, max file size) ---------- */
    function buildChips(amounts) {
        $("chips").innerHTML = "";
        amounts.forEach(function (a) {
            var b = document.createElement("button"); b.type = "button"; b.textContent = Number(a).toLocaleString(LOCALE); b.setAttribute("aria-pressed", "false");
            b.onclick = function () {
                S.amount = Number(a); document.querySelectorAll("#chips button").forEach(function (x) { x.setAttribute("aria-pressed", x === b); });
                $("pay-cap").textContent = "Scan with GCash and pay exactly " + money(a) + ".";
                update(); if (!$("ref").value) setTimeout(function () { $("ref").focus({ preventScroll: true }); }, 500);
            };
            $("chips").appendChild(b);
        });
    }
    async function loadSettings() {
        var res; try { res = await db.rpc("student_topup_settings"); if (res.error) throw res.error; }
        catch (e) { console.error(e); return setErr($("app-err"), "Can't load top-up settings right now."); }
        var s = res.data || {}; REF_LEN = Number(s.ref_length) || 0; MAX_MB = Number(s.max_file_mb) || 0;
        $("ref").maxLength = REF_LEN; $("ref").placeholder = "0".repeat(REF_LEN);
        $("ref-hint").textContent = "(" + REF_LEN + " digits)"; $("ref-len").textContent = REF_LEN; $("max-mb").textContent = MAX_MB;
        buildChips(s.amounts || []); update();
    }

    /* ---------- step 2: reference number, digits only ---------- */
    function setAi(state, text) { var el = $("ai-line"); el.hidden = !state; el.dataset.s = state || ""; el.textContent = text || ""; }
    function refBusy(on) { var r = $("ref"); r.readOnly = on; r.placeholder = on ? "Reading your receipt…" : "0".repeat(REF_LEN); }
    $("ref").addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, REF_LEN);
        if (S.aiRef) setAi(this.value === S.aiRef ? "ok" : "edit", this.value === S.aiRef ? "Filled in from your receipt. Please check it." : "You changed the number. Please check it against your receipt.");
        update();
    });

    /* ---------- step 3: proof upload, strictly JPG / PNG ---------- */
    async function validType(f) {
        if (!/\.(jpe?g|png)$/i.test(f.name) || !/^image\/(jpeg|png)$/.test(f.type)) return null;
        var h = new Uint8Array(await f.slice(0, 4).arrayBuffer());
        if (h[0] === 0xFF && h[1] === 0xD8 && h[2] === 0xFF) return "jpg";
        if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return "png";
        return null;
    }
    async function pick(f) {
        if (!f) return; setErr($("file-msg"), "");
        var ext = await validType(f);
        if (!ext) return setErr($("file-msg"), "Only .jpg or .png images are allowed.");
        if (f.size > MAX_MB * 1048576) return setErr($("file-msg"), "The image must be " + MAX_MB + " MB or smaller.");
        clearFile(); S.file = f; S.ext = ext;
        $("thumb").src = S.url = URL.createObjectURL(f); $("fname").textContent = f.name; $("proof").hidden = false; $("drop").hidden = true; update(); readReference(f);
    }
    function clearFile() {
        if (S.url) URL.revokeObjectURL(S.url);
        S.file = S.url = null; $("file").value = ""; $("proof").hidden = true; $("drop").hidden = false;
        S.readSeq++; S.reading = false; S.aiRef = null;
        $("ref").value = ""; refBusy(false); setAi("");
    }
    $("file").onchange = function () { pick(this.files[0]); };
    $("rm").onclick = function () { clearFile(); update(); };
    ["dragover", "dragenter"].forEach(function (ev) { $("drop").addEventListener(ev, function (e) { e.preventDefault(); this.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { $("drop").addEventListener(ev, function (e) { e.preventDefault(); this.classList.remove("over"); if (ev === "drop") pick(e.dataTransfer.files[0]); }); });

    function show(id, on) { var el = $(id); el.classList.toggle("open", on); el.inert = !on; }
    function update() {
        var fileOk = !!S.file, refOk = REF_LEN > 0 && $("ref").value.length === REF_LEN;
        $("cnt").textContent = $("ref").value.length;
        show("st-pay", !!S.amount); show("st-ref", !!S.amount && fileOk);
        var ready = !!S.amount && fileOk && !S.reading && refOk;
        $("confirm").classList.toggle("show", ready); $("confirm").inert = !ready; $("confirm").disabled = !ready;
    }

    /* ---------- AI assist: read the reference number off the receipt ---------- */
    var AI_FAIL = {
        limit: "You've used the receipt reader a lot for now. Please type the reference number from your receipt.",
        notreceipt: "That doesn't look like a GCash receipt. Check you picked the right image, or type the reference number.",
        unclear: "I couldn't clearly read the reference number. Please type it from your receipt.",
        error: "I couldn't read your receipt automatically. Please type the reference number from it."
    };
    async function readReference(file) {
        var seq = ++S.readSeq, d;
        S.reading = true; S.aiRef = null;
        $("ref").value = ""; refBusy(true); setAi("reading", "Reading your receipt… this takes a few seconds."); update();
        try {
            var fd = new FormData(); fd.append("token", getToken() || ""); fd.append("file", file, file.name);
            var res = await db.functions.invoke("read-topup-receipt", { body: fd });
            if (res.error) throw res.error;
            d = res.data || {};
        } catch (e) { console.error(e); d = { ok: false, reason: "ai_error" }; }
        if (seq !== S.readSeq) return;
        S.reading = false; refBusy(false);
        if (d.reason === "session") return goToLogin();
        var found = null;
        if (d.ok && d.is_receipt !== false && Array.isArray(d.candidates)) found = d.candidates.filter(function (c) { return /^\d+$/.test(c) && c.length === REF_LEN; })[0] || null;
        if (!found) {
            setAi("warn", AI_FAIL[!d.ok ? (d.reason === "limit" ? "limit" : "error") : d.is_receipt === false ? "notreceipt" : "unclear"]);
            update(); setTimeout(function () { if (seq === S.readSeq) $("ref").focus({ preventScroll: true }); }, 450);
            return;
        }
        $("ref").value = S.aiRef = found;
        var unsure = d.clear === false;
        setAi(unsure ? "warn" : "ok", unsure ? "Filled in from your receipt, but some digits weren't clear. Please check each one." : "Filled in from your receipt. Please check it.");
        update(); review(unsure);
    }

    /* ---------- submit ---------- */
    function errMsg(r) { return ({ pending_limit: "There are too many pending top-ups. Wait for the admin to review them.", amount: "That amount isn't allowed.", format: "The reference number must be exactly " + REF_LEN + " digits.", student: "That student isn't linked to your account." })[r]; }
    async function review(unsure) {
        if (S.busy || S.reading || $("confirm").disabled) return;
        var c = child(), ref = $("ref").value;
        var yes = await ask({
            title: "Is your reference number correct?", ref: ref, yes: "Confirm", no: "Edit",
            text: money(S.amount) + " via GCash for " + (c ? c.full_name : "your child") + "\n\n" + (unsure ? "Some digits weren't clear, so check each one against your receipt.\n\n" : "Compare it with your receipt.\n\n") +
                "Tap Edit to change it, or Confirm to send it to the admin for approval."
        });
        if (!yes) { $("ref").focus(); $("ref").select(); return; }
        submit();
    }
    $("tu-form").addEventListener("submit", function (e) { e.preventDefault(); review(false); });

    async function submit() {
        var c = child(); if (S.busy || !c) return;
        var amount = S.amount, ref = $("ref").value;
        S.busy = true; $("confirm").disabled = true; $("confirm").textContent = "Submitting…"; setErr($("tu-msg"), "");
        try {
            var path = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)) + "." + S.ext;
            var up = await db.storage.from("topup-proofs").upload(path, S.file, { contentType: S.ext === "png" ? "image/png" : "image/jpeg", upsert: false });
            if (up.error) throw up.error;
            var res = await db.rpc("parent_submit_topup", { p_token: getToken(), p_student_id: c.id, p_method: "gcash", p_amount: amount, p_reference: ref, p_proof_path: path });
            if (res.error) throw res.error;
            var r = res.data || {};
            if (r.reason === "session") return goToLogin();
            if (!r.ok) { console.warn("parent_submit_topup rejected:", r); throw { friendly: errMsg(r.reason) || ("Could not submit the top up. (" + (r.reason || "unknown") + ")") }; }
            clearFile(); S.amount = null; document.querySelectorAll("#chips button").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
            toast("Top up submitted. Waiting for admin approval."); loadHistory(true);
        } catch (err) { console.error(err); setErr($("tu-msg"), err.friendly || "Couldn't submit right now. Please try again."); }
        S.busy = false; $("confirm").textContent = "Confirm top up"; update();
    }

    /* ---------- start ---------- */
    showView((location.hash || "").replace("#", ""));
    loadSettings(); loadPortal(); setInterval(loadPortal, cfg.POLL_MS); update();
})();
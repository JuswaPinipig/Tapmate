(function () {
    var cfg = window.APP_CONFIG || {}, LOCALE = cfg.LOCALE || "en-PH", CUR = cfg.CURRENCY_SYMBOL || "₱";
    var SESSION_KEYS = ["tapmate_session", cfg.SESSION_KEY];   // the parent login saves its session as tapmate_session
    var RECEIPT_FN = cfg.PARENT_RECEIPT_FN || "read-parent-topup-receipt";
    var REF_LEN = 0, MAX_MB = 0;   // loaded from the database (student_topup_settings), never hard-coded here
    var $ = function (id) { return document.getElementById(id); };
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var S = { amount: null, file: null, busy: false, reading: false, readSeq: 0, aiRef: null };

    /* session */
    function getToken() {
        for (var i = 0; i < SESSION_KEYS.length; i++) {
            if (!SESSION_KEYS[i]) continue;
            try { var s = JSON.parse(sessionStorage.getItem(SESSION_KEYS[i]) || "null"); if (s && s.token) return s.token; } catch (_) { }
        }
        return null;
    }
    function goToLogin() { SESSION_KEYS.forEach(function (k) { try { if (k) sessionStorage.removeItem(k); } catch (_) { } }); location.replace(cfg.LOGIN_URL); }
    async function signOut() { var t = getToken(); if (t) { try { await db.rpc("card_logout", { p_token: t }); } catch (_) { } } goToLogin(); }
    $("signout").onclick = signOut; $("mbar-logout").onclick = signOut;

    /* helpers */
    function peso(n) { return Number(n).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    function money(n) { return CUR + peso(n); }
    function when(iso) { return iso ? new Date(iso).toLocaleString(LOCALE, { dateStyle: "medium", timeStyle: "short" }) : "–"; }
    function setErr(el, m) { el.textContent = m || ""; el.hidden = !m; }
    var tm; function toast(m) { var t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tm); tm = setTimeout(function () { t.classList.remove("show"); }, 2800); }
    document.querySelectorAll("[data-link]").forEach(function (a) {
        var u = cfg[a.dataset.link];
        if (u) a.setAttribute("href", u); else a.addEventListener("click", function (e) { e.preventDefault(); toast("This page isn't linked yet. Set " + a.dataset.link + " in config.js."); });
    });
    /* parent profile (read only) */
    var profileEl = $("profile");
    function openProfile() { profileEl.hidden = false; requestAnimationFrame(function () { profileEl.classList.add("open"); }); setTimeout(function () { var b = profileEl.querySelector("[data-close]"); if (b) b.focus(); }, 60); }
    function closeProfile() { profileEl.classList.remove("open"); setTimeout(function () { profileEl.hidden = true; }, 260); }
    $("open-profile").onclick = openProfile;
    profileEl.querySelector("[data-close]").onclick = closeProfile;
    profileEl.addEventListener("mousedown", function (e) { if (e.target === profileEl) closeProfile(); });

    /* sidebar */
    var shell = $("shell"), mq = matchMedia("(max-width:760px)");
    try { if (localStorage.getItem("sw_collapsed") === "1") shell.classList.add("collapsed"); } catch (_) { }
    requestAnimationFrame(function () { requestAnimationFrame(function () { shell.classList.remove("init"); }); });
    $("collapse").onclick = function () { if (mq.matches) shell.classList.remove("open"); else { shell.classList.toggle("collapsed"); try { localStorage.setItem("sw_collapsed", shell.classList.contains("collapsed") ? "1" : "0"); } catch (_) { } } };
    $("menu").onclick = function () { shell.classList.add("open"); };
    $("scrim").onclick = function () { shell.classList.remove("open"); };

    /* balance + sidebar profile: the parent's portal (same call as the Overview page) */
    function paintAvatar(el, p) { el.textContent = ""; var ini = ((p.first_name || p.full_name || "?")[0] || "") + ((p.last_name || "")[0] || ""); if (p.avatar_url) { var i = new Image(); i.alt = ""; i.src = p.avatar_url; i.onerror = function () { i.remove(); el.textContent = ini; }; el.appendChild(i); } else el.textContent = ini; }
    function showEmpty(d, why) {
        $("v-topup").hidden = true; $("no-child").hidden = false;
        if (why) { $("nc-title").textContent = "Can't load your student right now"; $("nc-text").textContent = why; return; }
        if (d.pending) {
            $("nc-title").textContent = "Confirm your link first";
            $("nc-text").textContent = "Open Overview and confirm the link to " + (d.pending.student_name || "your student") + ". Top up is available right after.";
        } else {
            $("nc-title").textContent = "No student linked yet";
            $("nc-text").textContent = "Top up is available once a student is linked to your account. Ask your child to show their \u201cLink a parent\u201d QR code, then scan it on the Overview page.";
        }
    }
    async function load() {
        var t = getToken(); if (!t) return goToLogin();
        var res; try { res = await db.rpc("parent_portal", { p_token: t }); if (res.error) throw res.error; } catch (e) { console.error(e); return setErr($("app-err"), "Can't reach TapMate right now."); }
        var d = res.data; if (!d) return goToLogin();
        setErr($("app-err"), "");
        var me = d.parent || {};
        $("side-name").textContent = me.full_name || "Parent"; paintAvatar($("side-av"), me);
        $("pf-name").textContent = me.full_name || "–"; $("pf-email").textContent = me.email || me.phone || ""; paintAvatar($("pf-av"), me);
        if (!d.linked) { H.rows = []; H.sig = null; return showEmpty(d); }
        if (!d.student || !d.student.profile) return showEmpty(d, "Please try again in a moment.");
        var p = d.student.profile, first = p.first_name || (p.full_name || "").split(" ")[0] || "Your child";
        $("no-child").hidden = true; $("v-topup").hidden = false;
        $("hello-h").textContent = "Top up " + first + "'s wallet"; $("w-lbl").textContent = first + "'s wallet balance";
        $("bal").textContent = peso(p.balance); $("bal-updated").textContent = "Updated " + when(p.updated_at);
        loadHistory();
    }

    /* top-up history: amount loaded, date & time uploaded, approving admin */
    function row(ul, cls, parts) { var li = document.createElement("li"); if (cls) li.className = cls; parts.forEach(function (p) { var s = document.createElement("span"); s.className = p[0]; s.textContent = p[1]; li.appendChild(s); }); ul.appendChild(li); }
    /* history pages: PAGE_SIZE rows per page, buttons like  < 1 2 3 4 5 >  (long lists collapse to  1 ... 4 5 6 ... 12) */
    var PAGE_SIZE = Number(cfg.HISTORY_PAGE_SIZE) || 4;
    var H = { rows: [], page: 1, sig: null };
    function pageList(cur, total) {
        var i, out = [];
        if (total <= 7) { for (i = 1; i <= total; i++) out.push(i); return out; }
        var a = Math.max(2, cur - 1), b = Math.min(total - 1, cur + 1);
        if (cur <= 3) { a = 2; b = 4; }
        if (cur >= total - 2) { a = total - 3; b = total - 1; }
        out.push(1); if (a > 2) out.push("…");
        for (i = a; i <= b; i++) out.push(i);
        if (b < total - 1) out.push("…"); out.push(total); return out;
    }
    function renderHistory(focus) {
        var ul = $("hist"), pg = $("hist-pager"), rows = H.rows;
        var ae = document.activeElement;                       // keep keyboard focus on the pager across re-renders
        if (!focus && ae && ae.dataset && ae.dataset.k && pg.contains(ae)) focus = ae.dataset.k;
        ul.innerHTML = ""; pg.innerHTML = "";
        if (!rows.length) { pg.hidden = true; return row(ul, "empty", [["empty", "No top-ups yet. They'll show up here."]]); }
        var pages = Math.ceil(rows.length / PAGE_SIZE);
        H.page = Math.min(Math.max(H.page, 1), pages);
        rows.slice((H.page - 1) * PAGE_SIZE, H.page * PAGE_SIZE).forEach(function (t) {
            row(ul, "", [["what", "Top-up"], ["amt" + (t.status === "approved" ? " in" : ""), (t.status === "approved" ? "+" : "") + money(t.amount)], ["when", when(t.created_at)],
            ["via", t.status === "approved" ? "Approved by " + (t.approved_by_name || "admin") : t.status === "rejected" ? "Declined" : "Pending review"]]);
        });
        pg.hidden = pages < 2; if (pages < 2) return;
        function btn(label, target, cls, aria, off, key) {
            var b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = label;
            b.setAttribute("aria-label", aria); b.dataset.k = key; b.disabled = !!off;
            if (cls.indexOf("on") > -1) b.setAttribute("aria-current", "page");
            b.onclick = function () { H.page = target; renderHistory(key); };
            pg.appendChild(b);
        }
        btn("‹", H.page - 1, "pg arrow", "Previous page", H.page === 1, "prev");
        pageList(H.page, pages).forEach(function (p) {
            if (p === "…") { var g = document.createElement("span"); g.className = "pg-gap"; g.textContent = "…"; g.setAttribute("aria-hidden", "true"); pg.appendChild(g); }
            else btn(String(p), p, H.page === p ? "pg on" : "pg", "Page " + p, false, String(p));
        });
        btn("›", H.page + 1, "pg arrow", "Next page", H.page === pages, "next");
        if (focus) {
            var f = pg.querySelector('[data-k="' + focus + '"]');
            if (!f || f.disabled) f = pg.querySelector('[aria-current="page"]');
            if (f) f.focus();
        }
    }
    async function loadHistory(toFirstPage) {
        var res;
        try { res = await db.rpc("parent_topup_history", { p_token: getToken() }); if (res.error) throw res.error; }
        catch (e) {
            console.error(e); H.rows = []; H.sig = null; $("hist-pager").hidden = true; $("hist").innerHTML = "";
            return row($("hist"), "empty", [["empty", "Top-up history isn't available yet."]]);
        }
        var rows = Array.isArray(res.data) ? res.data : [], sig = JSON.stringify(rows);
        if (toFirstPage) H.page = 1;                           // after a new submit, show the newest row
        else if (sig === H.sig) return;                        // polling found nothing new: leave the page alone
        H.rows = rows; H.sig = sig; renderHistory();
    }

    $("cur").textContent = CUR;

    /* QR image */
    var qr = $("qr"); qr.src = encodeURI(cfg.PARENT_GCASH_QR || cfg.GCASH_QR || "../../STUDENT/TOP-UP/assets/GCash QR.jpg");
    qr.onerror = function () { qr.replaceWith(Object.assign(document.createElement("p"), { className: "how", textContent: "GCash QR image not found. Check GCASH_QR in config.js." })); };

    /* settings (amounts, reference length, max file size) come from the database */
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
        var s = res.data || {}; REF_LEN = Number(s.ref_length) || 0; MAX_MB = Number(s.max_file_mb) || 0; S.maxPending = s.max_pending;
        $("ref").maxLength = REF_LEN; $("ref").placeholder = "0".repeat(REF_LEN);
        $("ref-hint").textContent = "(" + REF_LEN + " digits)"; $("ref-len").textContent = REF_LEN; $("max-mb").textContent = MAX_MB;
        buildChips(s.amounts || []); update();
    }

    /* step 2: reference number, digits only */
    function setAi(state, text) { var el = $("ai-line"); el.hidden = !state; el.dataset.s = state || ""; el.textContent = text || ""; }
    function refBusy(on) { var r = $("ref"); r.readOnly = on; r.placeholder = on ? "Reading your receipt…" : "0".repeat(REF_LEN); }
    $("ref").addEventListener("input", function () {
        this.value = this.value.replace(/\D/g, "").slice(0, REF_LEN);
        if (S.aiRef) setAi(this.value === S.aiRef ? "ok" : "edit", this.value === S.aiRef ? "Filled in from your receipt. Please check it." : "You changed the number. Please check it against your receipt.");
        update();
    });

    /* step 3: proof upload, strictly JPG / PNG (extension, MIME and file signature), max size from settings */
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
        S.readSeq++; S.reading = false; S.aiRef = null;          // forget any read that is still running
        $("ref").value = ""; refBusy(false); setAi("");
    }
    $("file").onchange = function () { pick(this.files[0]); };
    $("rm").onclick = function () { clearFile(); update(); };
    ["dragover", "dragenter"].forEach(function (ev) { $("drop").addEventListener(ev, function (e) { e.preventDefault(); this.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { $("drop").addEventListener(ev, function (e) { e.preventDefault(); this.classList.remove("over"); if (ev === "drop") pick(e.dataTransfer.files[0]); }); });

    /* each step slides in once the one before it is done; Confirm pops up last */
    function show(id, on) { var el = $(id); el.classList.toggle("open", on); el.inert = !on; }
    function update() {
        var fileOk = !!S.file;
        var refOk = REF_LEN > 0 && $("ref").value.length === REF_LEN;
        $("cnt").textContent = $("ref").value.length;
        show("st-pay", !!S.amount); show("st-ref", !!S.amount && fileOk);
        var ready = !!S.amount && fileOk && !S.reading && refOk;
        $("confirm").classList.toggle("show", ready); $("confirm").inert = !ready; $("confirm").disabled = !ready;
    }

    /* AI assist: read the reference number off the uploaded receipt. Only a helper: the student always confirms
       (or edits) the number, and the admin still checks it against the image. */
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
            var res = await db.functions.invoke(RECEIPT_FN, { body: fd });
            if (res.error) throw res.error;
            d = res.data || {};
        } catch (e) { console.error(e); d = { ok: false, reason: "ai_error" }; }
        if (seq !== S.readSeq) return;                       // the file was removed or replaced while reading
        S.reading = false; refBusy(false);
        if (d.reason === "session") return goToLogin();
        var found = null;
        if (d.ok && d.is_receipt !== false && Array.isArray(d.candidates)) {
            found = d.candidates.filter(function (c) { return /^\d+$/.test(c) && c.length === REF_LEN; })[0] || null;
        }
        if (!found) {
            setAi("warn", AI_FAIL[!d.ok ? (d.reason === "limit" ? "limit" : "error") : d.is_receipt === false ? "notreceipt" : "unclear"]);
            update(); setTimeout(function () { if (seq === S.readSeq) $("ref").focus({ preventScroll: true }); }, 450);
            return;
        }
        $("ref").value = S.aiRef = found;
        var unsure = d.clear === false;
        setAi(unsure ? "warn" : "ok", unsure ? "Filled in from your receipt, but some digits weren't clear. Please check each one." : "Filled in from your receipt. Please check it.");
        update();
        review(unsure);                                      // "Is your reference number correct?"
    }

    /* confirm dialog */
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
    document.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; if (cfRes) answer(false); else if (!profileEl.hidden) closeProfile(); });

    /* submit */
    function errMsg(r) { return ({ pending_limit: "You have too many pending top-ups. Wait for the admin to review them.", amount: "That amount isn't allowed.", no_student: "No student is linked to your account.", link: "Couldn't reach your student's account. Please refresh and try again.", format: "The reference number must be exactly " + REF_LEN + " digits." })[r]; }
    /* "Is your reference number correct?"  Edit = back to the field, Confirm = send it to the admin */
    async function review(unsure) {
        if (S.busy || S.reading || $("confirm").disabled) return;
        var ref = $("ref").value;
        var yes = await ask({
            title: "Is your reference number correct?", ref: ref, yes: "Confirm", no: "Edit",
            text: money(S.amount) + " via GCash for your child\n\n" + (unsure ? "Some digits weren't clear, so check each one against your receipt.\n\n" : "Compare it with your receipt.\n\n") +
                "Tap Edit to change it, or Confirm to send it to the admin for approval."
        });
        if (!yes) { $("ref").focus(); $("ref").select(); return; }
        submit();
    }
    $("tu-form").addEventListener("submit", function (e) { e.preventDefault(); review(false); });

    async function submit() {
        if (S.busy) return;
        var amount = S.amount, ref = $("ref").value;
        S.busy = true; $("confirm").disabled = true; $("confirm").textContent = "Submitting…"; setErr($("tu-msg"), "");
        try {
            var path = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)) + "." + S.ext;
            var up = await db.storage.from("topup-proofs").upload(path, S.file, { contentType: S.ext === "png" ? "image/png" : "image/jpeg", upsert: false });
            if (up.error) throw up.error;
            var res = await db.rpc("parent_submit_topup", { p_token: getToken(), p_method: "gcash", p_amount: amount, p_reference: ref, p_proof_path: path });
            if (res.error) throw res.error;
            var r = res.data || {};
            if (r.reason === "session") return goToLogin();
            if (!r.ok) { console.warn("parent_submit_topup rejected:", r); throw { friendly: errMsg(r.reason) || ("Could not submit your top up. (" + (r.reason || "unknown") + ")") }; }
            clearFile(); S.amount = null; document.querySelectorAll("#chips button").forEach(function (x) { x.setAttribute("aria-pressed", "false"); });
            toast("Top up submitted. Waiting for admin approval."); loadHistory(true);
        } catch (err) { console.error(err); setErr($("tu-msg"), err.friendly || "Couldn't submit right now. Please try again."); }
        S.busy = false; $("confirm").textContent = "Confirm top up"; update();
    }

    loadSettings(); load(); setInterval(load, Number(cfg.POLL_MS) || 15000); update();
})();
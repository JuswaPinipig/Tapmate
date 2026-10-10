(function () {
    "use strict";
    var cfg = window.APP_CONFIG || {};
    var db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    var $ = function (id) { return document.getElementById(id); };

    var link = "";      // QR token or 6-digit code
    // Remembered for this browser tab only, so a refresh doesn't lose the QR link.
    var KEY = "tapmate_parent_link";
    function keep(v) { try { sessionStorage.setItem(KEY, v); } catch (_) { } }
    function kept() { try { return sessionStorage.getItem(KEY) || ""; } catch (_) { return ""; } }
    function forget() { try { sessionStorage.removeItem(KEY); } catch (_) { } }
    var step = 1;

    var REASONS = {
        invalid_link: "That code isn't valid. Check it and try again.",
        expired: "This code has expired. Ask your child to show a new one in their wallet.",
        used: "This code has already been used. Ask your child to show a new one.",
        already_linked: "This student already has a linked parent.",
        busy: "Too many attempts. Please wait a few minutes and try again.",
        bad_contact: "Enter a valid email or Philippine mobile number.",
        bad_name: "Enter your first and last name.",
        weak_password: "Use at least 8 characters with a letter and a number.",
        bad_pin: "Use 4 digits that aren't all the same.",
        wrong_pin: "That PIN doesn't match the one in the student's account. Check it and try again.",
        locked: "Too many wrong PIN attempts. Ask your child to show a new QR code.",
        pin_not_issued: "Please go back one step and continue again to get your PIN.",
        exists: "An account with that email or number already exists. Choose “I already have an account” to link instead.",
        bad_login: "Wrong email/number or password. Check them and try again."
    };

    function show(id) {
        ["s-load", "s-code", "s-choice", "s-existing", "s-form", "s-done", "s-fail"].forEach(function (s) { $(s).hidden = s !== id; });
    }
    // TEMPORARY: show the real database error so we can fix it. Remove once sign-up works.
    function why(ex) { var m = ex && (ex.message || ex.details || ex.hint); return m ? " (" + String(m).slice(0, 160) + ")" : ""; }
    function setMsg(el, t) { el.textContent = t || ""; el.hidden = !t; }

    /* ---------- link check ---------- */
    async function checkLink(value, fromCodeForm) {
        show("s-load");
        var res;
        try { res = await db.rpc("parent_link_preview", { p_link: value }); if (res.error) throw res.error; }
        catch (e) { console.error(e); show(fromCodeForm ? "s-code" : "s-fail"); setMsg($("code-msg"), "Something went wrong. Please try again."); return fail("Something went wrong", "We couldn't check your link. Check your connection and try again."); }
        var r = res.data || {};
        if (!r.ok) {
            forget();
            if (fromCodeForm || !value) { show("s-code"); return setMsg($("code-msg"), REASONS[r.reason] || REASONS.invalid_link); }
            return fail("Can't use this link", REASONS[r.reason] || REASONS.invalid_link);
        }
        link = value; keep(value);
        var who = r.student_first_name ? "You're linking to " + r.student_first_name + "'s TapMate wallet." : "";
        ["linking", "linking-choice", "linking-existing"].forEach(function (id) { $(id).textContent = who; });
        goStep(1); show("s-choice");
    }
    function fail(title, text) { $("fail-title").textContent = title; $("fail-text").textContent = text; show("s-fail"); }

    /* ---------- steps ---------- */
    function goStep(n) {
        step = n;
        document.querySelectorAll("[data-step]").forEach(function (s) { s.hidden = +s.dataset.step !== n; });
        document.querySelectorAll("#steps li").forEach(function (li, i) { li.classList.toggle("on", i + 1 === n); li.classList.toggle("done", i + 1 < n); });
        $("back").hidden = false;
        $("next").textContent = n === 3 ? "Create account" : "Next";
        setMsg($("msg"), "");
    }

    // Email, or a PH mobile number normalised to +639XXXXXXXXX (same rules as the database)
    function normContact(v) {
        v = (v || "").trim();
        if (v.indexOf("@") >= 0) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v.toLowerCase() : null;
        var p = v.replace(/[\s\-()]/g, "");
        if (/^09\d{9}$/.test(p)) p = "+63" + p.slice(1);
        else if (/^639\d{9}$/.test(p)) p = "+" + p;
        return /^\+639\d{9}$/.test(p) ? p : null;
    }

    function validate(n) {
        if (n === 1) {
            if (!$("first").value.trim() || !$("last").value.trim()) return "Enter your first and last name.";
            if (!normContact($("contact").value)) return REASONS.bad_contact;
        } else if (n === 2) {
            var p = $("pw").value;
            if (p.length < 8 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) return REASONS.weak_password;
            if (p !== $("pw2").value) return "Passwords don't match.";
        } else {
            if (!/^\d{4}$/.test($("pin").value)) return "Enter the 4-digit PIN shown in the student's account.";
        }
        return "";
    }

    async function requestPin() {
        var btn = $("next"); btn.disabled = true; btn.textContent = "Please wait…";
        var res;
        try { res = await db.rpc("parent_request_pin", { p_link: link }); if (res.error) throw res.error; }
        catch (ex) { console.error(ex); btn.disabled = false; btn.textContent = "Next"; return setMsg($("msg"), "Something went wrong. Please try again." + why(ex)); }
        btn.disabled = false;
        var r = res.data || {};
        if (!r.ok) {
            btn.textContent = "Next";
            if (["invalid_link", "expired", "used", "already_linked"].indexOf(r.reason) >= 0) { forget(); return fail("Can't use this link", REASONS[r.reason]); }
            return setMsg($("msg"), REASONS[r.reason] || "Couldn't continue. Please try again.");
        }
        goStep(3);
    }

    $("back").onclick = function () { if (step === 1) show("s-choice"); else goStep(step - 1); };

    /* ---------- choice: new parent vs existing parent ---------- */
    $("choose-new").onclick = function () { show("s-form"); $("first").focus(); };
    $("choose-existing").onclick = function () { setMsg($("ex-msg"), ""); show("s-existing"); $("ex-contact").focus(); };
    $("ex-back").onclick = function () { setMsg($("ex-msg"), ""); show("s-choice"); };

    /* ---------- existing parent: log in and link ---------- */
    $("s-existing").addEventListener("submit", async function (e) {
        e.preventDefault();
        var contact = normContact($("ex-contact").value), pw = $("ex-pw").value;
        if (!contact) return setMsg($("ex-msg"), REASONS.bad_contact);
        if (!pw) return setMsg($("ex-msg"), "Enter your password.");
        var btn = $("ex-next"); btn.disabled = true; btn.textContent = "Linking…";
        var res;
        try {
            res = await db.rpc("parent_link_existing", { p_link: link, p_contact: contact, p_password: pw });
            if (res.error) throw res.error;
        } catch (ex) {
            console.error(ex); btn.disabled = false; btn.textContent = "Link student";
            return setMsg($("ex-msg"), "Something went wrong. Please try again." + why(ex));
        }
        btn.disabled = false; btn.textContent = "Link student";
        var r = res.data || {};
        if (!r.ok) {
            if (["invalid_link", "expired", "used", "already_linked"].indexOf(r.reason) >= 0) { forget(); return fail("Can't use this link", REASONS[r.reason]); }
            if (r.reason === "bad_login") $("ex-pw").value = "";
            return setMsg($("ex-msg"), REASONS[r.reason] || "Couldn't link this student. Please try again.");
        }
        $("ex-pw").value = "";
        $("done-title").textContent = "Student linked";
        $("done-text").textContent = "This student is now linked to your parent account. You can log in to view their wallet.";
        forget(); show("s-done");
    });
    $("pin").addEventListener("input", function () { this.value = this.value.replace(/\D/g, ""); });

    $("s-form").addEventListener("submit", async function (e) {
        e.preventDefault();
        var err = validate(step);
        if (err) return setMsg($("msg"), err);
        if (step === 2) return requestPin();            // the PIN is issued in the student's account
        if (step < 3) return goStep(step + 1);

        var btn = $("next"); btn.disabled = true; btn.textContent = "Creating…";
        var res;
        try {
            res = await db.rpc("parent_sign_up", {
                p_link: link, p_contact: normContact($("contact").value),
                p_first_name: $("first").value.trim(), p_last_name: $("last").value.trim(),
                p_password: $("pw").value, p_pin: $("pin").value
            });
            if (res.error) throw res.error;
        } catch (ex) {
            console.error(ex); btn.disabled = false; btn.textContent = "Create account";
            return setMsg($("msg"), "Something went wrong. Please try again." + why(ex));
        }
        btn.disabled = false; btn.textContent = "Create account";
        var r = res.data || {};
        if (!r.ok) {
            // Link problems end the flow; field problems send the parent back to the right step
            if (["invalid_link", "expired", "used", "already_linked", "locked"].indexOf(r.reason) >= 0) { forget(); return fail("Can't use this link", REASONS[r.reason]); }
            if (r.reason === "bad_contact" || r.reason === "bad_name" || r.reason === "exists") goStep(1);
            else if (r.reason === "weak_password") goStep(2);
            else if (r.reason === "pin_not_issued") goStep(2);
            else if (r.reason === "wrong_pin" || r.reason === "bad_pin") { goStep(3); $("pin").value = ""; }
            return setMsg($("msg"), REASONS[r.reason] || "Couldn't create your account.");
        }
        ["pw", "pw2", "pin"].forEach(function (id) { $(id).value = ""; });
        $("done-title").textContent = "Account created";
        $("done-text").textContent = "Your account is ready and linked. You can now log in.";
        forget(); show("s-done");
    });

    /* ---------- code form / retry ---------- */
    $("code").addEventListener("input", function () {
        var d = this.value.replace(/\D/g, "").slice(0, 6);
        this.value = d.length > 3 ? d.slice(0, 3) + " " + d.slice(3) : d;
    });
    $("s-code").addEventListener("submit", function (e) {
        e.preventDefault();
        var d = $("code").value.replace(/\D/g, "");
        if (d.length !== 6) return setMsg($("code-msg"), "Enter all 6 digits.");
        checkLink(d, true);
    });
    $("retry").onclick = function () { setMsg($("code-msg"), ""); $("code").value = ""; show("s-code"); $("code").focus(); };

    $("login-link").href = cfg.LOGIN_URL || "../LOGIN/login.html";

    /* ---------- show / hide password ---------- */
    document.querySelectorAll("[data-eye]").forEach(function (b) {
        b.addEventListener("click", function () {
            var i = $(b.dataset.eye), show = i.type === "password";
            i.type = show ? "text" : "password";
            b.textContent = show ? "Hide" : "Show";
            b.setAttribute("aria-label", show ? "Hide password" : "Show password");
        });
    });

    /* ---------- background video: respect reduced motion / data saver, never block the page ---------- */
    (function () {
        var v = $("bg-video"); if (!v) return;
        var calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
        var saver = navigator.connection && navigator.connection.saveData;
        if (calm || saver) { v.removeAttribute("autoplay"); v.pause(); v.style.display = "none"; return; }
        v.muted = true;
        var p = v.play(); if (p && p.catch) p.catch(function () { v.style.display = "none"; });
        v.addEventListener("error", function () { v.style.display = "none"; }, true);
    })();

    /* ---------- start: ?link=<token> from the QR ---------- */
    var q = new URLSearchParams(location.search).get("link");
    if (q) { try { history.replaceState(null, "", location.pathname); } catch (_) { } checkLink(q.trim(), false); }
    else if (kept()) { checkLink(kept(), true); }      // page was refreshed: pick up where the QR left off
    else { show("s-code"); }
})();
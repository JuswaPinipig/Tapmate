// ============================================================
// TapMate admin profile (shared by every admin page)
//
// Drop-in: add these two tags to an admin page, nothing else needed.
//   <link rel="stylesheet" href="adminprofile.css">          (in <head>)
//   <script src="adminprofile.js"></script>                  (AFTER the page's own script, before </body>)
//
// It uses the page's existing `db`, `cardToken()` and `LOGIN_PAGE`, so the
// page must already be signed in with the card session (all admin pages are).
// It takes over the sidebar profile button (#profileBtn) and fills
// #pfAvatar / #pfName / #pfSub. Backend: migrations v6 + v7.
// ============================================================
(function () {
    "use strict";
    const $ = (id) => document.getElementById(id);
    const btn0 = $("profileBtn");
    if (!btn0 || typeof db === "undefined" || !db || typeof cardToken !== "function") return;

    document.body.insertAdjacentHTML("beforeend", `
    <dialog id="profileDialog" class="dialog pf-dialog" aria-labelledby="pdTitle">
        <div class="dlg-head">
            <h3 id="pdTitle">My profile</h3>
            <button type="button" class="icon-btn" id="pdClose" aria-label="Close">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round">
                    <path d="M6 6l12 12M18 6 6 18" />
                </svg>
            </button>
        </div>

        <!-- Box 1: profile -->
        <form id="pdForm" class="pd-box pd-profile" novalidate>
            <div class="pd-photo">
                <button type="button" id="pdPhotoBtn" class="pd-photo-btn" aria-label="Change profile picture" tabindex="-1">
                    <span id="pdAvatar" class="pf-avatar pd-avatar" aria-hidden="true">A</span>
                    <span class="pd-cam" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                            <circle cx="12" cy="13" r="4" />
                        </svg>
                    </span>
                </button>
                <input id="pdFile" type="file" accept="image/png,image/jpeg,image/webp" hidden>
            </div>
            <div id="pdName" class="pd-name">Admin</div>
            <div id="pdEmail" class="pd-email"></div>

            <div class="pd-tools" aria-hidden="true"><div>
                <button type="button" class="btn ghost small" id="pdChange">Change photo</button>
                <button type="button" class="btn ghost small" id="pdRemovePhoto">Remove</button>
            </div></div>

            <p id="pdError" class="pd-msg" hidden></p>
            <div class="pd-actions">
                <button type="button" class="btn ghost" id="pdEdit">Edit profile</button>
                <button type="button" class="btn ghost" id="pdCancel" hidden>Cancel</button>
                <button type="submit" class="btn primary" id="pdSave" hidden>Save changes</button>
            </div>
        </form>

        <!-- Box 2: PIN management (the 3-per-24h limit applies only to this) -->
        <section class="pd-box">
            <h4 class="pd-h">PIN management</h4>
            <div id="pinMeter" class="pin-meter" aria-live="polite">
                <b id="pinRemaining">PIN changes remaining: 3/3</b>
                <small id="pinNote">You can change your PIN up to 3 times within a 24-hour period.</small>
            </div>
            <div id="pinLimit" class="pin-limit" hidden>
                <b>PIN change limit reached</b>
                <small id="pinLimitText"></small>
            </div>
            <form id="pinForm" novalidate>
                <div class="pd-pins">
                    <label class="field"><span>Current</span><input id="pinCur" type="password" inputmode="numeric"
                            maxlength="4" autocomplete="off" placeholder="••••"></label>
                    <label class="field"><span>New</span><input id="pinNew" type="password" inputmode="numeric"
                            maxlength="4" autocomplete="off" placeholder="••••"></label>
                    <label class="field"><span>Confirm</span><input id="pinNew2" type="password" inputmode="numeric"
                            maxlength="4" autocomplete="off" placeholder="••••"></label>
                </div>
                <p id="pinError" class="pd-msg" hidden></p>
                <button type="submit" class="btn primary pd-wide" id="pinSave">Change PIN</button>
            </form>
        </section>
    </dialog>
    <dialog id="pfConfirm" class="dialog confirm" aria-labelledby="pfcTitle">
        <div class="cf-body"><h3 id="pfcTitle"></h3><p id="pfcText"></p></div>
        <div class="cf-foot">
            <button type="button" class="btn ghost" id="pfcNo">Go Back</button>
            <button type="button" class="btn primary" id="pfcYes">Continue</button>
        </div>
    </dialog>`);

    // Replace the button with a clean copy so any older click handler is gone
    const profileBtn = btn0.cloneNode(true);
    btn0.replaceWith(profileBtn);
    const pfAvatar = $("pfAvatar"), pfName = $("pfName"), pfSub = $("pfSub");

    const say = (msg, isErr) => { if (typeof toast === "function") toast(msg, !!isErr); };
    const errText = (err) => (err && err.message) || "Something went wrong. Please try again.";
    const initialsOf = (name) => {
        const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
        if (!parts.length) return "A";
        return ((parts[0][0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
    };
    const closeDrawer = () => {
        const app = $("app"), sc = $("scrim");
        if (app) app.classList.remove("drawer-open");
        if (sc) sc.hidden = true;
    };
    const AUDIT_NOTE = "This action will be recorded in the audit logs for record-keeping and transparency.";

    // ---- confirm prompt (own copy, so it works on every page) ----
    const pfConfirm = $("pfConfirm"), pfcYes = $("pfcYes"), pfcNo = $("pfcNo");
    function confirmAction({ title, html, yes = "Continue", no = "Go Back" }) {
        return new Promise((resolve) => {
            $("pfcTitle").textContent = title;
            $("pfcText").innerHTML = html;
            pfcYes.textContent = yes;
            pfcNo.textContent = no;
            pfConfirm.returnValue = "";
            const done = () => { pfConfirm.removeEventListener("close", done); resolve(pfConfirm.returnValue === "yes"); };
            pfConfirm.addEventListener("close", done);
            pfConfirm.showModal();
            pfcNo.focus();
        });
    }
    pfcYes.addEventListener("click", () => pfConfirm.close("yes"));
    pfcNo.addEventListener("click", () => pfConfirm.close("no"));

    const profileDialog = $("profileDialog");
    const pdForm = $("pdForm"), pdAvatar = $("pdAvatar"), pdFile = $("pdFile"), pdPhotoBtn = $("pdPhotoBtn");
    const pdEdit = $("pdEdit"), pdCancel = $("pdCancel"), pdSave = $("pdSave"), pdError = $("pdError");
    const pdChange = $("pdChange"), pdRemovePhoto = $("pdRemovePhoto");
    const pinForm = $("pinForm"), pinCur = $("pinCur"), pinNew = $("pinNew"), pinNew2 = $("pinNew2");
    const pinSave = $("pinSave"), pinError = $("pinError");
    const PIN_PATTERN = /^\d{4}$/;
    const AVATAR_SIZE = 256;                    // saved picture is a 256x256 JPEG
    const AVATAR_MAX_FILE = 8 * 1024 * 1024;    // largest file we'll try to read
    let me = null;                              // the signed-in admin's profile + PIN allowance
    let pdEditing = false;
    let pendingAvatar;                          // undefined = unchanged, null = remove, string = new picture

    function fullNameOf(p) {
        return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
    }

    // Show the picture if there is one, otherwise the initials
    function paintAvatar(el, url, name) {
        el.style.backgroundImage = url ? 'url("' + url + '")' : "";
        el.textContent = url ? "" : initialsOf(name);
    }

    function paintProfile() {
        if (!me) return;
        const name = fullNameOf(me) || "Admin";
        pfName.textContent = name;
        paintAvatar(pfAvatar, me.avatar, name);
        paintAvatar(pdAvatar, pendingAvatar !== undefined ? pendingAvatar : me.avatar, name);
        $("pdName").textContent = name;
        $("pdEmail").textContent = me.email || "";
    }

    function setPdEditing(on) {
        pdEditing = on;
        pendingAvatar = undefined;
        $("pdForm").classList.toggle("editing", on);
        pdForm.querySelector(".pd-tools").setAttribute("aria-hidden", String(!on));
        pdPhotoBtn.tabIndex = on ? 0 : -1;
        pdEdit.hidden = on;
        pdCancel.hidden = !on;
        pdSave.hidden = !on;
        pdError.hidden = true;
        pdFile.value = "";
        paintProfile();
        syncPhotoTools();
    }

    function syncPhotoTools() {
        const shown = pendingAvatar !== undefined ? pendingAvatar : (me && me.avatar);
        pdRemovePhoto.disabled = !shown;
    }

    // Centre-crop to a square, shrink and re-encode so it stays small (~20 KB)
    function imageToAvatar(file) {
        return new Promise((resolve, reject) => {
            if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return reject(new Error("Please choose a PNG, JPG or WEBP image."));
            if (file.size > AVATAR_MAX_FILE) return reject(new Error("That image is too large. Choose one under 8 MB."));
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const c = document.createElement("canvas");
                c.width = c.height = AVATAR_SIZE;
                const ctx = c.getContext("2d");
                const side = Math.min(img.width, img.height);
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
                ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
                URL.revokeObjectURL(url);
                resolve(c.toDataURL("image/jpeg", 0.85));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file couldn't be read as an image.")); };
            img.src = url;
        });
    }

    function pickPhoto() { if (pdEditing) pdFile.click(); }
    pdPhotoBtn.addEventListener("click", pickPhoto);
    pdChange.addEventListener("click", pickPhoto);
    pdFile.addEventListener("change", async () => {
        const f = pdFile.files && pdFile.files[0];
        if (!f) return;
        try {
            pendingAvatar = await imageToAvatar(f);
            pdError.hidden = true;
            paintProfile();
            syncPhotoTools();
        } catch (err) {
            pdError.textContent = err.message;
            pdError.hidden = false;
        } finally {
            pdFile.value = "";
        }
    });
    pdRemovePhoto.addEventListener("click", () => {
        pendingAvatar = null;
        paintProfile();
        syncPhotoTools();
    });

    // "PIN changes remaining: 2/3" + the cooldown message once the 3rd change is used
    function paintPinAllowance() {
        if (!me) return;
        const limit = me.pin_limit || 3, used = me.pin_used || 0;
        const left = Math.max(0, limit - used);
        const reached = left === 0;
        $("pinRemaining").textContent = "PIN changes remaining: " + left + "/" + limit;
        $("pinMeter").hidden = reached;
        $("pinLimit").hidden = !reached;
        if (reached) {
            const at = me.pin_next_at ? new Date(me.pin_next_at) : null;
            $("pinLimitText").textContent = "You have reached the maximum of " + limit +
                " PIN changes within 24 hours. You can change your PIN again after the cooldown period ends" +
                (at ? " (" + at.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) + ")." : ".");
        }
        [pinCur, pinNew, pinNew2, pinSave].forEach((el) => { el.disabled = reached; });
    }

    async function loadProfile() {
        if (!db || !cardToken()) return;
        try {
            const { data, error } = await db.rpc("admin_get_own_profile", { p_token: cardToken() });
            if (error || !data) return;       // migration not run yet: keep the defaults
            me = data;
            paintProfile();
            paintPinAllowance();
            pfSub.textContent = "Edit profile";
        } catch (_) { /* keep the defaults */ }
    }

    // ---- open / smooth close ----
    const PD_CLOSE_MS = 200;                  // keep in sync with .pf-dialog.closing in the CSS
    let pdClosing = false;

    async function openProfile() {
        closeDrawer();
        pinForm.reset();
        pinError.hidden = true;
        setPdEditing(false);
        profileDialog.showModal();
        await loadProfile();                  // refresh the allowance every time it opens
        if (!pdEditing) paintProfile();
    }

    function closeProfile() {
        if (!profileDialog.open || pdClosing) return;
        pdClosing = true;
        profileDialog.classList.add("closing");
        setTimeout(() => {
            profileDialog.classList.remove("closing");
            profileDialog.close();
            pdClosing = false;
        }, PD_CLOSE_MS);
    }

    profileBtn.addEventListener("click", (e) => { e.preventDefault(); openProfile(); });
    $("pdClose").addEventListener("click", closeProfile);
    profileDialog.addEventListener("cancel", (e) => { e.preventDefault(); closeProfile(); });   // Esc key
    profileDialog.addEventListener("mousedown", (e) => {                                        // click outside
        const r = profileDialog.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!inside) closeProfile();
    });

    pdEdit.addEventListener("click", () => setPdEditing(true));
    pdCancel.addEventListener("click", () => setPdEditing(false));

    // Profile -> Edit -> Change picture -> Save -> "Finalize profile editing?" -> saved
    pdForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!pdEditing || !me) return;
        if (pendingAvatar === undefined) {
            setPdEditing(false);
            return say("No changes to save.");
        }
        const ok = await confirmAction({
            title: "Finalize profile editing?",
            html: "Please review your changes before continuing. Your updated profile information will be saved.<br><br>" + AUDIT_NOTE,
            yes: "Finalize", no: "Go Back", ask: false
        });
        if (!ok) return;

        pdSave.disabled = true;
        try {
            const { data, error } = await db.rpc("admin_update_own_avatar", { p_token: cardToken(), p_avatar: pendingAvatar });
            if (error) throw error;
            me.avatar = data.avatar;
            setPdEditing(false);
            say("Profile updated.");
        } catch (err) {
            pdError.textContent = errText(err);
            pdError.hidden = false;
        } finally {
            pdSave.disabled = false;
        }
    });

    // PIN management: the only place the 3-per-24-hours limit applies
    pinForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!me) return;
        const fail = (msg, el) => { pinError.textContent = msg; pinError.hidden = false; if (el) el.focus(); };
        pinError.hidden = true;
        if (!PIN_PATTERN.test(pinCur.value)) return fail("Enter your current 4-digit PIN.", pinCur);
        if (!PIN_PATTERN.test(pinNew.value)) return fail("Your new PIN must be exactly 4 digits.", pinNew);
        if (pinNew.value === pinCur.value) return fail("Your new PIN must be different from your current PIN.", pinNew);
        if (pinNew.value !== pinNew2.value) return fail("The new PINs don't match.", pinNew2);

        const left = (me.pin_limit || 3) - (me.pin_used || 0);
        const ok = await confirmAction({
            title: "Change your PIN?",
            html: "This uses 1 of your remaining PIN changes (" + left + " left in this 24-hour period).<br><br>" + AUDIT_NOTE,
            yes: "Change PIN", no: "Go Back", ask: false
        });
        if (!ok) return;

        pinSave.disabled = true;
        try {
            const { data, error } = await db.rpc("admin_change_own_pin", {
                p_token: cardToken(), p_current: pinCur.value, p_new: pinNew.value
            });
            if (error) throw error;
            Object.assign(me, data);
            pinForm.reset();
            say("PIN changed.");
        } catch (err) {
            fail(errText(err), pinCur);
            await loadProfile();              // the allowance may have changed server-side
        } finally {
            paintPinAllowance();              // re-enables the form unless the limit is reached
        }
    });


    loadProfile();
})();
// ============================================================
// TapMate Admin | Top Up Approvals
// Same shell as User Account Management: sidebar, admin profile
// (photo + PIN) and confirm prompts are shared code.
// ============================================================

// ============================================================
// 1. SUPABASE SETUP
// ============================================================
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";
const PROOF_BUCKET = "topup-proofs";          // where student-top-up.js uploads the receipts

const configured =
    !SUPABASE_URL.startsWith("YOUR_") && !SUPABASE_ANON_KEY.startsWith("YOUR_");
const LOGIN_PAGE = "../../LOGIN/login.html";  // same folder depth as the account management page
function cardToken() {
    try { return (JSON.parse(sessionStorage.getItem("tapmate_session")) || {}).token || ""; }
    catch (_) { return ""; }
}
// The token is also sent as a header so the database can let admins (and only admins) open the receipt images.
const db = configured
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { "x-card-token": cardToken() } }
    })
    : null;

async function requireAdmin() {
    if (!cardToken()) return false;
    try {
        const { data, error } = await db.rpc("card_session", { p_token: cardToken() });
        return !error && !!data && data.role === "admin";
    } catch (_) {
        return false;
    }
}

// ============================================================
// 2. SETTINGS
// ============================================================
const PAGE_SIZE = 5;                  // requests per page
const PAGE_BUTTONS = 5;               // page numbers shown at once: 1 2 3 4 5
const DEBOUNCE_MS = 250;              // wait after typing before querying
const REFRESH_MS = 20000;             // pending list refreshes itself while no dialog is open
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

// ============================================================
// 3. ELEMENTS
// ============================================================
const $ = (id) => document.getElementById(id);

const appEl = $("app");
const collapseBtn = $("collapseBtn");
const menuBtn = $("menuBtn");
const scrim = $("scrim");

const searchInput = $("searchInput");
const clearSearch = $("clearSearch");
const rowsEl = $("rows");
const emptyEl = $("emptyState");
const resultsTitle = $("resultsTitle");
const resultsCount = $("resultsCount");
const bannerEl = $("banner");
const toastEl = $("toast");
const pagerEl = $("pager");
const statusPills = $("statusPills");
const pillSlider = $("pillSlider");

const confirmDialog = $("confirmDialog");
const cfTitle = $("cfTitle");
const cfText = $("cfText");
const cfYes = $("cfYes");
const cfNo = $("cfNo");

// ============================================================
// 4. HELPERS
// ============================================================
function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
}

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function when(iso) {
    return iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "\u2013";
}

let toastTimer, toastHide;
// The toast is a popover so it shows ABOVE the open dialog and slides in from the right.
function toast(msg, isError = false) {
    clearTimeout(toastTimer);
    clearTimeout(toastHide);
    toastEl.textContent = msg;
    toastEl.className = "toast" + (isError ? " err" : "");
    toastEl.hidden = false;
    if (toastEl.showPopover) {
        try { toastEl.hidePopover(); } catch (_) { /* not open */ }
        toastEl.showPopover();
    }
    toastTimer = setTimeout(() => {
        toastEl.classList.add("out");
        toastHide = setTimeout(() => {
            toastEl.hidden = true;
            if (toastEl.hidePopover) { try { toastEl.hidePopover(); } catch (_) { /* closed */ } }
        }, 300);
    }, isError ? 5500 : 3200);
}

function showBanner(msg) {
    bannerEl.textContent = msg;
    bannerEl.hidden = !msg;
}

// ============================================================
// 5. SIDEBAR (collapsible cabinet)
// ============================================================
const COLLAPSE_KEY = "tapmate.admin.sidebarCollapsed";
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

function setCollapsed(collapsed) {
    appEl.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (_) { /* ignore */ }
}

function setDrawer(open) {
    appEl.classList.toggle("drawer-open", open);
    scrim.hidden = !open;
}

collapseBtn.addEventListener("click", () => {
    if (isMobile()) return setDrawer(false);
    setCollapsed(!appEl.classList.contains("collapsed"));
});
menuBtn.addEventListener("click", () => setDrawer(true));

// The current page's own button shouldn't reload/navigate to itself
document.querySelector(".nav-btn.active").addEventListener("click", (e) => {
    e.preventDefault();
    if (isMobile()) setDrawer(false);
});
scrim.addEventListener("click", () => setDrawer(false));

try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch (_) { /* ignore */ }

// ------------------------------------------------------------
// Admin profile (sidebar): picture editing + PIN management.
// Names are NOT editable here.
// ------------------------------------------------------------
const profileBtn = $("profileBtn");
const pfAvatar = $("pfAvatar");
const pfName = $("pfName");
const pfSub = $("pfSub");

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

function logout() {
    try { sessionStorage.removeItem("tapmate_session"); } catch (_) { /* ignore */ }
    window.location.replace(LOGIN_PAGE);
}
$("logoutBtn").addEventListener("click", logout);

function fullNameOf(p) {
    return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
}

// Show the picture if there is one, otherwise the initials
function paintAvatar(el, url, name) {
    el.style.backgroundImage = url ? 'url("' + url + '")' : "";
    el.textContent = url ? "" : initials(name);
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
    if (isMobile()) setDrawer(false);
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
        return toast("No changes to save.");
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
        toast("Profile updated.");
    } catch (err) {
        pdError.textContent = friendlyError(err);
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
        toast("PIN changed.");
    } catch (err) {
        fail(friendlyError(err), pinCur);
        await loadProfile();              // the allowance may have changed server-side
    } finally {
        paintPinAllowance();              // re-enables the form unless the limit is reached
    }
});

// ---------- confirm prompt + audited admin actions ----------
const AUDIT_NOTE = "This action will be recorded in the audit logs for record-keeping and transparency.";

function confirmAction({ title, html, yes = "Continue", no = "Cancel", ask = true, danger = false }) {
    return new Promise((resolve) => {
        cfTitle.textContent = title;
        cfText.innerHTML = html;
        cfYes.textContent = yes;
        cfNo.textContent = no;
        $("cfAsk").hidden = !ask;
        cfYes.classList.toggle("danger-fill", danger);
        confirmDialog.returnValue = "";
        const done = () => { confirmDialog.removeEventListener("close", done); resolve(confirmDialog.returnValue === "yes"); };
        confirmDialog.addEventListener("close", done);
        confirmDialog.showModal();
        cfNo.focus();
    });
}
cfYes.addEventListener("click", () => confirmDialog.close("yes"));
cfNo.addEventListener("click", () => confirmDialog.close("no"));

function friendlyError(err) {
    const msg = (err.message || "") + " " + (err.details || "");
    if (err.code === "23505") {
        if (msg.includes("rfid")) return "That RFID card is already assigned to another student.";
        if (msg.includes("student_id")) return "A student with that ID number already exists.";
        if (msg.includes("email")) return "That school email is already used by another account.";
        return "This record already exists.";
    }
    if (err.code === "23514") return "One of the values isn't in the allowed format.";
    if (err.code === "42501" || /row-level security/i.test(msg)) {
        return "Permission denied. Sign in as an admin and check your Supabase RLS policies.";
    }
    return err.message || "Something went wrong. Please try again.";
}

// ============================================================
// 6. TOP-UP REQUESTS
// ============================================================
const STATUS_INFO = {
    pending: { title: "Pending top-ups", empty: "No pending top-ups right now. New requests from students will show up here." },
    approved: { title: "Approved top-ups", empty: "No approved top-ups yet." },
    rejected: { title: "Declined top-ups", empty: "No declined top-ups." }
};
let status = "pending";
let term = "";
let page = 1;
let listSeq = 0;

function moveSlider() {
    const b = statusPills.querySelector(".pill.on");
    if (!b) { pillSlider.style.width = "0px"; return; }
    pillSlider.style.width = b.offsetWidth + "px";
    pillSlider.style.transform = "translateX(" + b.offsetLeft + "px)";
}
requestAnimationFrame(() => { moveSlider(); pillSlider.classList.add("ready"); });
window.addEventListener("resize", moveSlider);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSlider);

function setStatus(s, reload = true) {
    status = s;
    statusPills.querySelectorAll(".pill").forEach((p) => {
        const on = p.dataset.status === s;
        p.classList.toggle("on", on);
        p.setAttribute("aria-selected", String(on));
    });
    resultsTitle.textContent = STATUS_INFO[s].title;
    moveSlider();
    if (reload) loadList(1);
}
statusPills.addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (b && b.dataset.status !== status) setStatus(b.dataset.status);
});

function paintCounts(c) {
    if (!c) return;
    $("cntPending").textContent = c.pending ?? 0;
    $("cntApproved").textContent = c.approved ?? 0;
    $("cntRejected").textContent = c.rejected ?? 0;
    moveSlider();
}

function renderRows(rows) {
    rowsEl.innerHTML = "";
    rows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.dataset.id = r.id;
        const cell = (cls, text) => { const td = document.createElement("td"); if (cls) td.className = cls; td.textContent = text; tr.appendChild(td); return td; };
        cell("sid", r.student_id || "\u2013");
        cell("who", r.full_name || "Unknown student");
        cell("when", when(r.created_at));
        cell("amt", peso.format(r.amount));
        const act = document.createElement("td");
        act.className = "right";
        act.innerHTML = '<button type="button" class="btn ghost small view-btn" data-view="' + escapeHtml(r.id) + '" aria-label="View top-up of ' + escapeHtml(r.full_name || r.student_id) + '">' +
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>View</button>';
        tr.appendChild(act);
        rowsEl.appendChild(tr);
    });
}

function renderPager(total) {
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) { pagerEl.hidden = true; pagerEl.innerHTML = ""; return; }
    const from = (page - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, page * PAGE_SIZE);
    let html = '<span class="info">Showing ' + from + "\u2013" + to + " of " + total + "</span>" +
        '<span class="pages">' +
        '<button type="button" data-page="' + (page - 1) + '"' + (page === 1 ? " disabled" : "") + ' aria-label="Previous page">&lsaquo;</button>';
    // Sliding window of PAGE_BUTTONS numbers around the current page (1 2 3 4 5, then 2 3 4 5 6 ...)
    const start = Math.max(1, Math.min(page - Math.floor(PAGE_BUTTONS / 2), pages - PAGE_BUTTONS + 1));
    const end = Math.min(pages, start + PAGE_BUTTONS - 1);
    const num = (p) => '<button type="button" data-page="' + p + '"' +
        (p === page ? ' class="on" aria-current="page"' : "") + ' aria-label="Page ' + p + '">' + p + "</button>";
    const gap = '<button type="button" disabled aria-hidden="true">&hellip;</button>';
    if (start > 1) html += num(1) + (start > 2 ? gap : "");
    for (let p = start; p <= end; p++) html += num(p);
    if (end < pages) html += (end < pages - 1 ? gap : "") + num(pages);
    html += '<button type="button" data-page="' + (page + 1) + '"' + (page === pages ? " disabled" : "") + ' aria-label="Next page">&rsaquo;</button></span>';
    pagerEl.innerHTML = html;
    pagerEl.hidden = false;
}
pagerEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b || b.disabled) return;
    loadList(Number(b.dataset.page));
    resultsTitle.scrollIntoView({ behavior: "smooth", block: "start" });
});

async function loadList(p = 1, silent = false) {
    if (!db) return;
    const seq = ++listSeq;
    try {
        const { data, error } = await db.rpc("admin_topup_list", {
            p_token: cardToken(), p_status: status, p_search: term,
            p_limit: PAGE_SIZE, p_offset: (p - 1) * PAGE_SIZE
        });
        if (seq !== listSeq) return;                       // a newer request replaced this one
        if (error) throw error;
        if (!data || data.ok === false) {
            if (data && data.reason === "session") return logout();
            throw new Error("Couldn't load the top-up requests.");
        }
        if (!data.rows.length && p > 1 && data.total > 0) return loadList(p - 1, silent);   // page emptied (e.g. last one reviewed)
        page = p;
        showBanner("");
        paintCounts(data.counts);
        renderRows(data.rows);
        renderPager(data.total);
        resultsCount.textContent = data.total + (data.total === 1 ? " request" : " requests");
        emptyEl.hidden = data.rows.length > 0;
        if (!data.rows.length) emptyEl.textContent = term ? "No requests match \u201c" + term + "\u201d." : STATUS_INFO[status].empty;
    } catch (err) {
        if (seq !== listSeq) return;
        if (!silent) {
            showBanner("Couldn't load top-ups. " + friendlyError(err) + " (Has admin-top-up-approval.sql been run?)");
            renderRows([]); renderPager(0); resultsCount.textContent = "";
            emptyEl.hidden = true;
        }
    }
}

// ---------- search ----------
const runSearch = debounce(() => { term = searchInput.value.trim(); loadList(1); }, DEBOUNCE_MS);
searchInput.addEventListener("input", () => { clearSearch.hidden = !searchInput.value; runSearch(); });
searchInput.addEventListener("keydown", (e) => { if (e.key === "Escape" && searchInput.value) { clearSearch.click(); } });
clearSearch.addEventListener("click", () => {
    searchInput.value = ""; clearSearch.hidden = true; term = ""; loadList(1); searchInput.focus();
});

// keep the list fresh while the admin is just waiting for students to submit
setInterval(() => {
    if (document.visibilityState === "visible" && !document.querySelector("dialog[open]")) loadList(page, true);
}, REFRESH_MS);

// ============================================================
// 7. REVIEW DIALOG (detailed report + approve / decline)
// ============================================================
const reviewDialog = $("reviewDialog");
const declineDialog = $("declineDialog");
const lightbox = $("lightbox");
const rvFrame = $("rvFrame"), rvOpen = $("rvOpen");
const rvApprove = $("rvApprove"), rvDecline = $("rvDecline");
let current = null;       // the request being reviewed
let busy = false;

function paintBadge(el, st) {
    el.hidden = false;
    el.className = "badge " + (st === "approved" ? "ok" : st === "rejected" ? "bad" : "warn");
    el.textContent = st === "approved" ? "Approved" : st === "rejected" ? "Declined" : "Pending";
}

function frameNote(text) {
    rvFrame.innerHTML = "";
    const p = document.createElement("p");
    p.className = "rv-note";
    p.textContent = text;
    rvFrame.appendChild(p);
}

// The receipt image stays hidden until the AI check has finished (or failed), so the admin always sees the
// AI's verdict BEFORE the image. `pf` tracks both halves; the image is revealed once both are done, and
// Approve / Decline stay disabled until then.
let pf = null;

function canAct() { return !!(current && !busy && pf && pf.shown); }
function syncFoot() { rvApprove.disabled = rvDecline.disabled = !canAct(); }

function pfRender() {
    if (!pf) return;
    if (!pf.shown) {
        rvOpen.hidden = true;
        if (!pf.aiDone) frameNote("The AI is verifying this receipt. The image will appear when the check is done\u2026");
        else if (!pf.loaded) frameNote("Loading receipt\u2026");
        else if (pf.error) { frameNote(pf.error); pf.shown = true; }
        else {
            rvFrame.innerHTML = "";
            rvFrame.appendChild(pf.img);
            rvOpen.dataset.src = pf.url;
            rvOpen.hidden = false;
            pf.shown = true;
        }
    }
    syncFoot();
}

async function fetchProof(path, p) {
    if (!path) { p.error = "No receipt image was uploaded."; p.loaded = true; return pfRender(); }
    let url = null;
    try {
        const { data, error } = await db.storage.from(PROOF_BUCKET).createSignedUrl(path, 600);
        if (!error && data) url = data.signedUrl;
    } catch (_) { /* fall back below */ }
    if (!url) {
        const { data } = db.storage.from(PROOF_BUCKET).getPublicUrl(path);
        url = data && data.publicUrl;
    }
    if (pf !== p) return;
    const img = new Image();                       // preloaded now, put on screen later by pfRender()
    img.alt = "Uploaded GCash receipt";
    img.onload = () => { if (pf !== p) return; p.img = img; p.url = url; p.loaded = true; pfRender(); };
    img.onerror = () => {
        if (pf !== p) return;
        p.error = "Couldn't load the receipt image. Check the storage policy in admin-top-up-approval.sql.";
        p.loaded = true; pfRender();
    };
    img.src = url;
}

function openLightbox() {
    const src = rvOpen.dataset.src;
    if (!src) return;
    $("lbImg").src = src;
    lightbox.showModal();
}
rvFrame.addEventListener("click", (e) => { if (e.target.tagName === "IMG") openLightbox(); });
rvOpen.addEventListener("click", (e) => { e.preventDefault(); openLightbox(); });
$("lbClose").addEventListener("click", () => lightbox.close());
lightbox.addEventListener("click", (e) => { if (e.target === lightbox) lightbox.close(); });

function paintReview() {
    const r = current;
    const name = r.full_name || "Unknown student";
    $("rvAvatar").textContent = initials(name);
    $("rvName").textContent = name;
    $("rvSid").textContent = r.student_id || "\u2013";
    $("rvAmount").textContent = peso.format(r.amount);
    $("rvWhen").textContent = when(r.created_at);
    $("rvRef").textContent = r.reference_no || "\u2013";
    paintBadge($("rvBadge"), r.status);

    const pending = r.status === "pending";
    $("rvFoot").hidden = !pending;
    const res = $("rvResult");
    res.hidden = pending;
    if (!pending) {
        const ok = r.status === "approved";
        res.className = "rv-result " + (ok ? "ok" : "bad");
        res.innerHTML = "";
        const b = document.createElement("b");
        b.textContent = (ok ? "Approved" : "Declined") + " by " + (r.approved_by_name || "an admin") + " \u00b7 " + when(r.reviewed_at);
        res.appendChild(b);
        if (!ok && r.decline_reason) res.appendChild(document.createTextNode("Reason: " + r.decline_reason));
        if (ok) res.appendChild(document.createTextNode(peso.format(r.amount) + " was added to the student's wallet."));
    }
}

async function openReview(id, btn) {
    if (btn) btn.disabled = true;
    try {
        const { data, error } = await db.rpc("admin_topup_detail", { p_token: cardToken(), p_id: String(id) });
        if (error) throw error;
        if (!data || !data.ok) {
            if (data && data.reason === "session") return logout();
            toast("That request no longer exists.", true);
            return loadList(page, true);
        }
        current = data.request;
        const p = pf = { aiDone: current.status !== "pending", loaded: false, error: null, img: null, url: null, shown: false };
        paintReview();
        reviewDialog.showModal();
        reviewDialog.scrollTop = 0;
        pfRender();                                // shows "verifying..." while the AI works
        fetchProof(current.proof_path, p);         // loads the image in the background
        if (current.status === "pending") runAi(); else rvAi.hidden = true;
    } catch (err) {
        toast(friendlyError(err), true);
    } finally {
        if (btn) btn.disabled = false;
    }
}
rowsEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-view]");
    if (b) openReview(b.dataset.view, b);
});

function closeReview() { if (!busy && reviewDialog.open) reviewDialog.close(); }
$("rvClose").addEventListener("click", closeReview);
reviewDialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
reviewDialog.addEventListener("close", () => { pf = null; aiSeq++; current = null; rvFrame.innerHTML = ""; rvOpen.hidden = true; rvOpen.dataset.src = ""; rvAi.hidden = true; });
reviewDialog.addEventListener("mousedown", (e) => {                     // click outside
    const r = reviewDialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeReview();
});


// ---------- AI receipt check (advisory only) ----------
// The Edge Function reads the receipt and compares the reference number, amount and date it sees with what the
// student submitted. Nothing here approves, declines or enables a button. The admin always decides.
const rvAi = $("rvAi"), aiMsg = $("aiMsg"), aiRedo = $("aiRedo"), aiChecks = $("aiChecks");
let aiSeq = 0;

const KEYS = ["ref", "amount", "date"];
const FIELD_NAME = { ref: "reference number", amount: "amount", date: "date" };
const STATE_LABEL = { match: "Matches", near: "Check closely", mismatch: "Doesn't match", unreadable: "Not readable", loading: "Checking\u2026" };
const AI_MSG = {
    match: "The reference number, amount and date all match the receipt. Still look over the image yourself before approving.",
    unreadable: "I couldn't clearly read this receipt. It may be blurry or not a GCash receipt. Please check it yourself.",
    error: "The AI check isn't available right now. You can still review the receipt yourself.",
    noimage: "There's no receipt image for the AI to check.",
    loading: "Reading the receipt\u2026"
};

function joinNames(list) {
    return list.length < 2 ? list.join("") : list.slice(0, -1).join(", ") + " and " + list[list.length - 1];
}
function aiText(state, c) {
    if (c && (state === "mismatch" || state === "near")) {
        const pick = (test) => KEYS.filter((k) => c[k] && test(c[k].status)).map((k) => FIELD_NAME[k]);
        if (state === "mismatch") {
            const n = pick((x) => x === "mismatch");
            return "The " + joinNames(n) + (n.length > 1 ? " don't" : " doesn't") + " match the receipt. Please check the image yourself before deciding.";
        }
        return "Nearly there, but please look closely at the " + joinNames(pick((x) => x !== "match")) + " on the receipt.";
    }
    return AI_MSG[state] || AI_MSG.error;
}

// dates are compared as Philippine calendar days (same as the Edge Function)
const manilaDay = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const prettyDay = (ymd) => new Date(ymd + "T00:00:00").toLocaleDateString("en-PH", { dateStyle: "medium" });
function prettyTime(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM");
}

function paintCheck(k, status, typed, seen, note) {
    const li = aiChecks.querySelector('[data-k="' + k + '"]');
    li.dataset.s = status;
    li.querySelector(".ck-state").textContent = STATE_LABEL[status];
    li.querySelector(".ck-typed").textContent = typed;
    li.querySelector(".ck-seen").textContent = seen;
    const n = li.querySelector(".ck-note");
    n.textContent = note || "";
    n.hidden = !note;
}

const UNCLEAR = "Part of the image wasn't clear.";
function paintResults(c) {
    const r = c.ref, a = c.amount, d = c.date;
    paintCheck("ref", r.status, r.typed || "\u2013",
        r.read && r.read.length ? r.read.join(" / ") : "Not readable",
        r.status !== "near" ? "" : r.diff > 0 ? r.diff + (r.diff === 1 ? " digit differs." : " digits differ.") : UNCLEAR);
    paintCheck("amount", a.status, peso.format(a.typed),
        a.read && a.read.length ? a.read.map((x) => peso.format(x)).join(" / ") : "Not readable",
        a.status === "near" ? UNCLEAR : "");
    let dNote = "";
    if (d.status === "near") dNote = d.days === 1 ? "Receipt is dated the day before the request." : UNCLEAR;
    else if (d.status === "mismatch") dNote = d.days < 0 ? "Receipt is dated after the request was submitted." : "Receipt is " + d.days + " days older than the request.";
    paintCheck("date", d.status, prettyDay(d.typed),
        d.read ? prettyDay(d.read) + (d.time ? " \u00b7 " + prettyTime(d.time) : "") : "Not readable", dNote);
}

function paintAi(state, c) {
    rvAi.hidden = false;
    rvAi.dataset.state = state;
    aiMsg.textContent = aiText(state, c);
    if (state === "loading" && current) {
        aiChecks.hidden = false;                   // show what is being compared while the AI reads
        paintCheck("ref", "loading", current.reference_no || "\u2013", "Reading\u2026");
        paintCheck("amount", "loading", peso.format(current.amount), "Reading\u2026");
        paintCheck("date", "loading", prettyDay(manilaDay(current.created_at)), "Reading\u2026");
    } else if (c && c.ref && c.amount && c.date) {
        aiChecks.hidden = false;
        paintResults(c);
    } else {
        aiChecks.hidden = true;
    }
    aiRedo.hidden = state === "loading";
}

async function checkAi(force, seq) {
    if (!current.proof_path) return paintAi("noimage");
    // a result already saved for this exact reference, amount and date shows instantly
    const saved = current.ai_check;
    if (!force && saved && saved.v === 2 && saved.ref && saved.amount && saved.date
        && saved.ref.typed === String(current.reference_no || "").replace(/\D/g, "")
        && Number(saved.amount.typed) === Number(current.amount)
        && saved.date.typed === manilaDay(current.created_at)) {
        return paintAi(saved.status, saved);
    }
    paintAi("loading");
    try {
        const { data, error } = await db.functions.invoke("check-topup-receipt", { body: { token: cardToken(), id: String(current.id), force } });
        if (seq !== aiSeq) return;                         // dialog closed or another request opened
        if (error || !data) throw error || new Error("no response");
        if (data.reason === "session") return logout();
        if (!data.ok) return paintAi(data.reason === "no_image" ? "noimage" : "error");
        current.ai_check = data.check;
        paintAi(data.check.status, data.check);
    } catch (err) {
        if (seq !== aiSeq) return;
        console.error(err);
        paintAi("error");
    }
}

async function runAi(force = false) {
    if (!current) return;
    const seq = ++aiSeq;
    await checkAi(force, seq);
    // the first check is over (result, error or no image): now the receipt image may be shown
    if (seq === aiSeq && pf && !pf.aiDone) { pf.aiDone = true; pfRender(); }
}
aiRedo.addEventListener("click", () => runAi(true));

// ---------- approve / decline ----------
const REVIEW_ERRORS = {
    already_reviewed: "Another admin already reviewed this request.",
    not_found: "That request no longer exists.",
    no_account: "This student's account couldn't be found, so nothing was added.",
    reason_required: "Please enter a reason for declining."
};

// returns true when the review was saved
async function submitReview(action, reason) {
    if (!current || busy) return false;
    const r = current;
    const name = r.full_name || r.student_id;
    busy = true;
    rvApprove.disabled = rvDecline.disabled = true;
    $("dcSubmit").disabled = true;
    try {
        const { data, error } = await db.rpc("admin_topup_review", {
            p_token: cardToken(), p_id: String(r.id), p_action: action, p_reason: reason || null
        });
        if (error) throw error;
        if (!data || !data.ok) {
            if (data && data.reason === "session") { logout(); return false; }
            toast(REVIEW_ERRORS[data && data.reason] || "Couldn't save your decision. Please try again.", true);
            if (data && (data.reason === "already_reviewed" || data.reason === "not_found")) {
                declineDialog.close(); reviewDialog.close(); loadList(page, true);
            }
            return false;
        }
        toast(action === "approve"
            ? "Approved. " + peso.format(r.amount) + " was added to " + name + "'s wallet."
            : "Top-up declined. " + name + " will see your reason.");
        return true;
    } catch (err) {
        toast(friendlyError(err), true);
        return false;
    } finally {
        busy = false;
        syncFoot();
        $("dcSubmit").disabled = false;
    }
}

function afterReview() {
    declineDialog.close();
    reviewDialog.close();
    loadList(page, true);
}

rvApprove.addEventListener("click", async () => {
    if (!canAct()) return;
    const name = current.full_name || current.student_id;
    const ok = await confirmAction({
        title: "Approve this top up?",
        html: "<strong>" + escapeHtml(peso.format(current.amount)) + "</strong> will be added to <strong>" + escapeHtml(name) +
            "</strong>'s wallet. Please make sure the amount and reference number match the GCash receipt.",
        yes: "Approve", no: "Go Back", ask: false
    });
    if (!ok) return;
    if (await submitReview("approve")) afterReview();
});

// decline: a reason is required
const dcReason = $("dcReason"), dcError = $("dcError"), dcCount = $("dcCount");
function dcFail(msg) {
    dcError.textContent = msg; dcError.hidden = false;
    dcReason.classList.add("invalid"); dcReason.focus();
}
rvDecline.addEventListener("click", () => {
    if (!canAct()) return;
    dcReason.value = ""; dcCount.textContent = "0";
    dcError.hidden = true; dcReason.classList.remove("invalid");
    declineDialog.showModal();
    dcReason.focus();
});
dcReason.addEventListener("input", () => {
    dcCount.textContent = dcReason.value.length;
    if (dcReason.value.trim()) { dcError.hidden = true; dcReason.classList.remove("invalid"); }
});
$("dcClose").addEventListener("click", () => { if (!busy) declineDialog.close(); });
$("dcBack").addEventListener("click", () => { if (!busy) declineDialog.close(); });
declineDialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
$("dcForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = dcReason.value.trim();
    if (!reason) return dcFail("A reason is required to decline a top-up.");
    if (await submitReview("decline", reason)) afterReview();
});

// ============================================================
// 8. START
// ============================================================
(async function start() {
    setStatus("pending", false);
    if (!configured) {
        showBanner("Supabase isn't connected yet. Add your project URL and anon key at the top of admin-top-up-approval.js.");
        emptyEl.hidden = false;
        emptyEl.textContent = "Connect Supabase to see top-up requests.";
    } else if (!(await requireAdmin())) {
        window.location.replace(LOGIN_PAGE);   // not signed in as an admin
        return;
    } else {
        loadList(1);
    }
    loadProfile();
})();
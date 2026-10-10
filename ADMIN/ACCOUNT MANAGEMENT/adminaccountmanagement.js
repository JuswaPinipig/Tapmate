// ============================================================
// 1. SUPABASE SETUP
//    Paste your project's URL and anon (public) key from
//    Supabase > Project Settings > API.
//    Never put the service_role key in front-end code.
// ============================================================
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

const TABLE = "accounts"; // see adminaccountmanagement.sql

const configured =
    !SUPABASE_URL.startsWith("YOUR_") && !SUPABASE_ANON_KEY.startsWith("YOUR_");
// Admins sign in on the RFID + PIN login page, which stores a session token.
// We send it with every request; the database checks it (see login.sql, section 9).
const LOGIN_PAGE = "../../LOGIN/login.html"; // admin page is ADMIN/ACCOUNT MANAGEMENT/, so two levels up
function cardToken() {
    try { return (JSON.parse(sessionStorage.getItem("tapmate_session")) || {}).token || ""; }
    catch (_) { return ""; }
}
const db = configured
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { "x-card-token": cardToken() } }
    })
    : null;

// True only if the stored token is valid and belongs to an active admin
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
const SUGGEST_LIMIT = 8;        // rows in the autocomplete dropdown
const RESULT_LIMIT = 50;        // rows in the table
const DEBOUNCE_MS = 180;        // wait after typing before querying
const MIN_CHARS = 1;            // start suggesting from this many characters
const STUDENT_ID_PATTERN = /^\d{4}-\d{6}$/; // YYYY-NNNNNN, e.g. 2026-123456
const PAGE_SIZE = 5;             // accounts per page
const PAGE_BUTTONS = 5;          // page numbers shown at once: 1 2 3 4 5
const PHONE_PATTERN = /^09\d{9}$/;      // 09XXXXXXXXX
const EMAIL_DOMAIN = "sjc.edu.ph";          // school emails must end with @sjc.edu.ph
const DEFAULT_DAILY_LIMIT = 200;            // pre-filled spending limit for new students (PHP)
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

// ============================================================
// 3. ELEMENTS
// ============================================================
const $ = (id) => document.getElementById(id);

const appEl = $("app");
const collapseBtn = $("collapseBtn");
const menuBtn = $("menuBtn");
const scrim = $("scrim");

const searchBox = $("searchBox");
const searchInput = $("searchInput");
const clearSearch = $("clearSearch");
const suggestionsEl = $("suggestions");

const rowsEl = $("rows");
const emptyEl = $("emptyState");
const resultsTitle = $("resultsTitle");
const resultsCount = $("resultsCount");
const bannerEl = $("banner");
const toastEl = $("toast");
const pagerEl = $("pager");
const thId = $("thId");
const rolePills = $("rolePills");


// ============================================================
// 4. HELPERS
// ============================================================
function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text, term) {
    const safe = escapeHtml(text);
    if (!term) return safe;
    const re = new RegExp(escapeRegExp(escapeHtml(term)), "ig");
    return safe.replace(re, (m) => "<mark>" + m + "</mark>");
}

function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
}

// Characters that would break PostgREST's or() filter syntax
function cleanTerm(q) {
    return q.replace(/[,()%_*\\]/g, " ").replace(/\s+/g, " ").trim();
}

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
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

// ============================================================
// 6. DATA ACCESS (Supabase)
// ============================================================
const COLUMNS = "id, role, status, student_id, first_name, middle_name, last_name, suffix, full_name, email, phone, rfid_uid, rfid_frozen, guardians, balance, daily_limit, pay_later_enabled";

const ROLES = {
    all: { singular: "account", plural: "accounts", idLabel: "Student ID / Email", search: "Search by full name, student ID number or email" },
    student: { singular: "student", plural: "students", idLabel: "Student ID number", search: "Search by student ID number or full name" },
    faculty: { singular: "faculty account", plural: "faculty accounts", idLabel: "Email", search: "Search by full name or email" },
    admin: { singular: "admin account", plural: "admin accounts", idLabel: "Email", search: "Search by full name or email" },
    cashier: { singular: "cashier account", plural: "cashier accounts", idLabel: "Email", search: "Search by full name or email" },
    parent: { singular: "parent account", plural: "parent accounts", idLabel: "Email / Phone", search: "Search by parent name, email, phone, or their student's name or ID" }
};
let roleFilter = ""; // "" = no filter: show every account
let archivedView = false;
let currentTerm = "";
let currentPage = 1;

function displayName(s) {
    return (s.full_name || "") + (s.suffix ? " " + s.suffix : "");
}

async function searchAccounts(term, { limit = PAGE_SIZE, page = 1 } = {}) {
    if (roleFilter === "parent") {   // parents come from their own function (it also returns the linked student)
        const { data, error } = await db.rpc("admin_parent_list", {
            p_token: cardToken(), p_search: cleanTerm(term), p_archived: archivedView,
            p_limit: limit, p_offset: (page - 1) * limit
        });
        if (error) throw error;
        const rows = data || [];
        return { rows, count: rows.length ? Number(rows[0].total_count) : 0 };
    }
    let q = db.from(TABLE).select(COLUMNS, { count: "exact" });
    if (roleFilter) q = q.eq("role", roleFilter);
    q = archivedView ? q.eq("status", "archived") : q.neq("status", "archived");
    const t = cleanTerm(term);
    if (t) {
        q = q.or(`full_name.ilike.%${t}%,student_id.ilike.%${t}%,email.ilike.%${t}%`).order("full_name", { ascending: true });
    } else {
        q = q.order("created_at", { ascending: false });
    }
    const from = (page - 1) * limit;
    const { data, error, count } = await q.range(from, from + limit - 1);
    if (error) throw error;
    return { rows: data || [], count: count ?? (data || []).length };
}

// ============================================================
// 7. LIVE SEARCH + AUTOCOMPLETE (YouTube-style)
// ============================================================
let suggestions = [];
let activeIndex = -1;
let suggestSeq = 0; // ignores out-of-order responses

function openSuggestions(open) {
    suggestionsEl.hidden = !open;
    searchBox.classList.toggle("open", open);
    searchBox.setAttribute("aria-expanded", String(open));
    if (!open) activeIndex = -1;
}

function renderSuggestions(list, term, note) {
    suggestionsEl.innerHTML = "";
    if (note) {
        const li = document.createElement("li");
        li.className = "sg-note";
        li.textContent = note;
        suggestionsEl.appendChild(li);
        openSuggestions(true);
        return;
    }
    list.forEach((s, i) => {
        const li = document.createElement("li");
        li.className = "sg-item";
        li.id = "sg-" + i;
        li.setAttribute("role", "option");
        li.dataset.index = i;
        li.innerHTML =
            '<span class="sg-avatar">' + escapeHtml(initials(s.full_name)) + "</span>" +
            '<span class="sg-body">' +
            '<span class="sg-name">' + highlight(displayName(s), term) + "</span>" +
            '<span class="sg-id">' + highlight(s.role === "parent" ? (s.email || s.phone || "") : (s.student_id || s.email || ""), term) + "</span>" +
            "</span>" +
            '<span class="sg-state">' + (s.role === "parent" ? (s.student_name ? "Linked" : "Not linked") : (s.rfid_uid ? "RFID linked" : "No RFID")) + "</span>";
        suggestionsEl.appendChild(li);
    });
    openSuggestions(list.length > 0);
}

function setActive(i) {
    const items = suggestionsEl.querySelectorAll(".sg-item");
    items.forEach((el) => el.classList.remove("active"));
    activeIndex = i;
    if (i >= 0 && items[i]) {
        items[i].classList.add("active");
        items[i].scrollIntoView({ block: "nearest" });
        searchInput.setAttribute("aria-activedescendant", items[i].id);
    } else {
        searchInput.removeAttribute("aria-activedescendant");
    }
}

const runSuggest = debounce(async () => {
    const term = searchInput.value.trim();
    clearSearch.hidden = !term;

    if (!db) return;
    if (term.length < MIN_CHARS) {
        openSuggestions(false);
        loadTable("");
        return;
    }

    const seq = ++suggestSeq;
    try {
        const list = (await searchAccounts(term, { limit: SUGGEST_LIMIT })).rows;
        if (seq !== suggestSeq) return; // a newer keystroke already won
        suggestions = list;
        if (!list.length) renderSuggestions([], term, "No students match \"" + term + "\"");
        else renderSuggestions(list, cleanTerm(term));
        setActive(-1);
        loadTable(term); // the table follows the search live
    } catch (err) {
        if (seq === suggestSeq) {
            openSuggestions(false);
            showBanner("Search failed: " + (err.message || err));
        }
    }
}, DEBOUNCE_MS);

function pickSuggestion(s) {
    searchInput.value = displayName(s);
    clearSearch.hidden = false;
    openSuggestions(false);
    suggestSeq++; // cancel pending suggest responses
    renderTable([s], "Selected account", "", 1);
    flashRow(s.id);
}

searchInput.addEventListener("input", runSuggest);
searchInput.addEventListener("focus", () => {
    if (suggestions.length && searchInput.value.trim()) openSuggestions(true);
});

searchInput.addEventListener("keydown", (e) => {
    const open = !suggestionsEl.hidden;
    const count = suggestions.length;

    if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!open && count) openSuggestions(true);
        if (count) setActive((activeIndex + 1) % count);
    } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (count) setActive(activeIndex <= 0 ? count - 1 : activeIndex - 1);
    } else if (e.key === "Enter") {
        e.preventDefault();
        if (open && activeIndex >= 0) {
            pickSuggestion(suggestions[activeIndex]);
        } else {
            openSuggestions(false);
            loadTable(searchInput.value.trim());
        }
    } else if (e.key === "Escape") {
        if (open) openSuggestions(false);
        else if (searchInput.value) resetSearch();
    }
});

suggestionsEl.addEventListener("mousedown", (e) => {
    // mousedown (not click) so the input doesn't lose focus first
    const item = e.target.closest(".sg-item");
    if (!item) return;
    e.preventDefault();
    pickSuggestion(suggestions[Number(item.dataset.index)]);
});

document.addEventListener("click", (e) => {
    if (!searchBox.contains(e.target)) openSuggestions(false);
});

function resetSearch() {
    searchInput.value = "";
    clearSearch.hidden = true;
    suggestions = [];
    suggestSeq++;
    openSuggestions(false);
    loadTable("");
    searchInput.focus();
}
clearSearch.addEventListener("click", resetSearch);

// ============================================================
// 8. RESULTS TABLE
// ============================================================
let tableSeq = 0;
let currentRows = [];

async function loadTable(term, page = 1) {
    if (!db) return;
    currentTerm = term;
    currentPage = page;
    const seq = ++tableSeq;
    try {
        let res = await searchAccounts(term, { page });
        if (!res.rows.length && page > 1) { // that page no longer exists (e.g. after archiving)
            currentPage = Math.max(1, Math.ceil(res.count / PAGE_SIZE));
            res = await searchAccounts(term, { page: currentPage });
        }
        if (seq !== tableSeq) return;
        renderTable(res.rows, archivedView ? (term ? "Archived results for \"" + term + "\"" : "Archived accounts") : (term ? "Results for \"" + term + "\"" : "Recently added"), term, res.count);
    } catch (err) {
        if (seq === tableSeq) showBanner("Could not load accounts: " + (err.message || err));
    }
}

const ARCHIVE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/></svg>';

function renderTable(list, title, term = "", total = list.length) {
    const info = ROLES[roleFilter || "all"];
    currentRows = list;
    const parentView = roleFilter === "parent";
    document.querySelectorAll("th[data-v]").forEach((th) => { th.hidden = (th.dataset.v === "parent") !== parentView; });
    thId.textContent = info.idLabel;
    resultsTitle.textContent = title || "Accounts";
    resultsCount.textContent = total + " " + (total === 1 ? info.singular : info.plural);
    rowsEl.innerHTML = "";
    renderPager(total);

    if (!list.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = parentView && !archivedView && !term
            ? "No parent accounts yet. Parents appear here after they sign up from their child's QR code."
            : archivedView
                ? "No archived " + info.plural + (term ? " match your search." : " yet.")
                : term
                    ? "No " + info.plural + " found. Try another name or " + (!roleFilter ? "student ID or email" : roleFilter === "student" ? "ID number" : "email") + ", or create a new account."
                    : "No " + info.plural + " yet. Click \"New account\" to add the first one.";
        return;
    }
    emptyEl.hidden = true;

    const t = cleanTerm(term);
    list.forEach((s) => {
        const archived = s.status === "archived";
        const tr = document.createElement("tr");
        tr.dataset.id = s.id;
        if (archived) tr.className = "archived";
        if (parentView) {
            const linkCell = s.student_name
                ? '<div class="linked-cell"><span class="badge ok">Linked</span><small>' + escapeHtml(s.student_name) + (s.student_id ? " \u2022 " + escapeHtml(s.student_id) : "") + "</small></div>"
                : s.pending_student_name
                    ? '<div class="linked-cell"><span class="badge warn">Awaiting confirmation</span><small>' + escapeHtml(s.pending_student_name) + "</small></div>"
                    : '<span class="badge none">Not linked</span>';
            tr.innerHTML =
                '<td class="mono">' + highlight(s.email || s.phone || "-", t) + "</td>" +
                "<td>" + highlight(displayName(s), t) + "</td>" +
                "<td>" + linkCell + "</td>" +
                '<td><span class="badge ' + (archived ? "none" : "ok") + '">' + (archived ? "Archived" : "Active") + "</span></td>" +
                '<td class="right"><span class="row-actions">' +
                (archived ? "" : '<button class="btn ghost small" data-act="edit" type="button">Edit</button>') +
                "</span></td>";
            rowsEl.appendChild(tr);
            return;
        }
        const isParentRow = s.role === "parent";   // parent rows in the "all accounts" view
        const rfidCell = isParentRow ? "\u2013" : archived
            ? '<span class="badge none">Archived</span>'
            : (s.rfid_uid ? '<span class="badge ok">Linked</span>' : '<span class="badge none">Not linked</span>') +
            (s.rfid_frozen ? ' <span class="badge warn">Frozen</span>' : "");
        tr.innerHTML =
            '<td class="mono">' + highlight((s.role === "student" ? s.student_id : s.email) || "-", t) + "</td>" +
            "<td>" + highlight(displayName(s), t) +
            (!roleFilter ? ' <span class="badge none role-tag">' + escapeHtml(s.role.charAt(0).toUpperCase() + s.role.slice(1)) + "</span>" : "") + "</td>" +
            '<td class="num">' + peso.format(Number(s.balance || 0)) + "</td>" +
            '<td class="num">' + peso.format(Number(s.daily_limit || 0)) + "</td>" +
            "<td>" + rfidCell + "</td>" +
            '<td class="right"><span class="row-actions">' +
            (archived
                ? '<button class="btn ghost small" data-act="unarchive" type="button">Unarchive</button>'
                : '<button class="btn ghost small" data-act="edit" type="button">Edit</button>' +
                (isParentRow ? "" : '<button class="btn ghost small icon-only" data-act="archive" type="button" title="Archive account" aria-label="Archive account">' + ARCHIVE_ICON + "</button>")) +
            "</span></td>";
        rowsEl.appendChild(tr);
    });
}

// ---------- pagination (5 per page) ----------
function renderPager(total) {
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) { pagerEl.hidden = true; pagerEl.innerHTML = ""; return; }
    const from = (currentPage - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, currentPage * PAGE_SIZE);
    let html = '<span class="info">Showing ' + from + "\u2013" + to + " of " + total + "</span>" +
        '<span class="pages">' +
        '<button type="button" data-page="' + (currentPage - 1) + '"' + (currentPage === 1 ? " disabled" : "") + ' aria-label="Previous page">&lsaquo;</button>';
    // Sliding window of PAGE_BUTTONS numbers around the current page (1 2 3 4 5, then 2 3 4 5 6 ...)
    const start = Math.max(1, Math.min(currentPage - Math.floor(PAGE_BUTTONS / 2), pages - PAGE_BUTTONS + 1));
    const end = Math.min(pages, start + PAGE_BUTTONS - 1);
    const num = (p) => '<button type="button" data-page="' + p + '"' +
        (p === currentPage ? ' class="on" aria-current="page"' : "") + ' aria-label="Page ' + p + '">' + p + "</button>";
    const gap = '<button type="button" disabled aria-hidden="true">&hellip;</button>';
    if (start > 1) html += num(1) + (start > 2 ? gap : "");
    for (let p = start; p <= end; p++) html += num(p);
    if (end < pages) html += (end < pages - 1 ? gap : "") + num(pages);
    html += '<button type="button" data-page="' + (currentPage + 1) + '"' + (currentPage === pages ? " disabled" : "") + ' aria-label="Next page">&rsaquo;</button></span>';
    pagerEl.innerHTML = html;
    pagerEl.hidden = false;
}

pagerEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (!b || b.disabled) return;
    loadTable(currentTerm, Number(b.dataset.page));
    resultsTitle.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- role pills ----------
function setRole(role, reload = true) {
    roleFilter = role;
    rolePills.querySelectorAll(".pill").forEach((p) => {
        const on = p.dataset.role === role;
        p.classList.toggle("on", on);
        p.setAttribute("aria-selected", String(on));
    });
    const info = ROLES[role || "all"];
    searchInput.placeholder = info.search;
    thId.textContent = info.idLabel;
    moveSlider();
    suggestions = [];
    suggestSeq++;
    openSuggestions(false);
    if (reload) loadTable(searchInput.value.trim(), 1);
}
rolePills.addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    // clicking the active pill again clears the filter and shows every account
    setRole(b.dataset.role === roleFilter ? "" : b.dataset.role);
});

function flashRow(id) {
    const tr = rowsEl.querySelector('tr[data-id="' + id + '"]');
    if (tr) { tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash"); }
}

rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("tr").dataset.id;
    const student = currentRows.find((s) => String(s.id) === String(id));
    if (!student) return;
    if (btn.dataset.act === "archive") return archiveAccount(student);
    if (btn.dataset.act === "unarchive") return unarchiveAccount(student);
    if (student.role === "parent") return openParentDialog(student);
    openDialog(student, 1);
});

// ============================================================
// 9. ACCOUNT DIALOG (role -> 1 Information -> 2 RFID -> 3 Wallet)
// ============================================================
const addBtn = $("addBtn");
const dialog = $("studentDialog");
const form = $("studentForm");
const dialogTitle = $("dialogTitle");
const dlgClose = $("dlgClose");
const fRole = $("fRole");
const roleNote = $("roleNote");
const wizard = $("wizard");
const tabsEl = $("tabs");
const summaryEl = $("summary");
const fFirst = $("fFirst");
const fMiddle = $("fMiddle");
const fLast = $("fLast");
const fSuffix = $("fSuffix");
const fPhone = $("fPhone");
const cardTools = $("cardTools");
const freezeBtn = $("freezeBtn");
const freezeHint = $("freezeHint");
const pinBtn = $("pinBtn");
const confirmDialog = $("confirmDialog");
const cfTitle = $("cfTitle");
const cfText = $("cfText");
const cfYes = $("cfYes");
const cfNo = $("cfNo");
const fEmail = $("fEmail");
const emailPreview = $("emailPreview");
const fStudentId = $("fStudentId");
const fRfid = $("fRfid");
const rfidHint = $("rfidHint");
const rfidClear = $("rfidClear");
const fBalance = $("fBalance");
const fLimit = $("fLimit");
const fPayLater = $("fPayLater");
const backBtn = $("backBtn");
const nextBtn = $("nextBtn");
const saveBtn = $("saveBtn");
const saveWrap = $("saveWrap");

let editing = null;  // the student being edited, or null when creating
let step = 1;
let maxStep = 1;     // furthest step reached while creating

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

// ---------- steps ----------
function goStep(n) {
    step = n;
    maxStep = Math.max(maxStep, n);
    wizard.querySelectorAll(".step").forEach((el) => (el.hidden = Number(el.dataset.step) !== n));
    tabsEl.querySelectorAll("button").forEach((b) => {
        const k = Number(b.dataset.step);
        b.classList.toggle("on", k === n);
        b.disabled = !editing && k > maxStep;
    });
    syncTabs();
    renderFooter();
    const first = wizard.querySelector('.step[data-step="' + n + '"] input');
    if (first) setTimeout(() => first.focus(), 0);
}

function renderFooter() {
    const hasRole = !!fRole.value;
    backBtn.hidden = !hasRole || !!editing || step === 1;
    nextBtn.hidden = !hasRole || !!editing || step === lastStep();
    const showSave = hasRole && (!!editing || step === lastStep());
    const wasHidden = saveWrap.hidden;
    saveWrap.hidden = !showSave;
    if (showSave && wasHidden) {            // smooth Next -> Create student swap
        saveWrap.classList.remove("enter");
        void saveWrap.offsetWidth;
        saveWrap.classList.add("enter");
    }
    saveBtn.textContent = editing ? "Save changes" : (isStaff() ? "Create account" : "Create student");
    updateSaveState();
}

// Create student stays grayed out until balance AND daily limit are both >= 1.00
function walletReady() {
    const b = money(fBalance), l = money(fLimit);
    return b !== null && l !== null && b >= 1 && l >= 1;
}

function updateSaveState() {
    const locked = !editing && !walletReady();
    saveBtn.disabled = locked;
    saveWrap.classList.toggle("locked", locked);
}

tabsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-step]");
    if (b && !b.disabled) goStep(Number(b.dataset.step));
});
backBtn.addEventListener("click", () => goStep(stepAfter(-1)));
nextBtn.addEventListener("click", async () => {
    if (await validateStep(step)) goStep(stepAfter(1));
});

// Staff (faculty / admin / cashier) share one flow; only the labels and a few fields differ
const isStaff = () => ["faculty", "admin", "cashier"].includes(fRole.value);

// Students: 1 Information, 2 ID, 3 Guardian Information, 4 Wallet. Staff skip step 3.
const seq = () => (isStaff() ? [1, 2, 4] : [1, 2, 3, 4]);
const lastStep = () => { const s = seq(); return s[s.length - 1]; };
function stepAfter(d) {
    const s = seq();
    return s[Math.max(0, Math.min(s.length - 1, s.indexOf(step) + d))];
}
function syncTabs() {
    const s = seq();
    tabsEl.querySelectorAll("button").forEach((b) => {
        const i = s.indexOf(Number(b.dataset.step));
        b.hidden = i < 0;
        if (i >= 0) b.querySelector(".n").textContent = String(i + 1);
    });
}

function applyRole() {
    const staff = isStaff();
    const word = staff ? "Staff" : "Student";
    $("tabLbl2").textContent = word + " ID";
    $("tabLbl4").textContent = word + " Wallet";
    $("sidField").hidden = staff;
    syncTabs();
    $("saveTip").textContent = "Please set an appropriate amount for the " + word.toLowerCase() +
        "'s E-wallet balance and Spending limit to proceed";
}

fRole.addEventListener("change", () => {
    const has = !!fRole.value;
    wizard.hidden = !has;
    roleNote.hidden = true;
    applyRole();
    if (has) goStep(editing ? step : 1); else renderFooter();
});

// ---------- names: letters (and single spaces between words) only ----------
const NAME_RE = /^[\p{L}\p{M}]+( [\p{L}\p{M}]+)*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cleanName = (v) => v.replace(/[^\p{L}\p{M} ]/gu, "").replace(/^ +/, "").replace(/ {2,}/g, " ");
[fFirst, fMiddle, fLast].forEach((el) => el.addEventListener("input", () => {
    const c = cleanName(el.value);
    if (c !== el.value) el.value = c;
}));
fSuffix.addEventListener("input", () => {
    const c = fSuffix.value.replace(/[^A-Za-z.]/g, "");
    if (c !== fSuffix.value) fSuffix.value = c;
});

// ---------- guardians (students only, 1 required, max 3) ----------
const MAX_GUARDIANS = 3;
const guardianList = $("guardianList");
const addGuardianBtn = $("addGuardianBtn");
let guardians = [];
const newGuardian = () => ({ name: "", method: "", contact: "" });

function setContactField(card, g, focus) {
    const wrap = card.querySelector('[data-g="contactWrap"]');
    const input = card.querySelector('[data-g="contact"]');
    wrap.hidden = !g.method;
    if (!g.method) return;
    const sms = g.method === "sms";
    wrap.querySelector("span").textContent = sms ? "Mobile number (SMS)" : "Email address";
    input.type = sms ? "tel" : "email";
    input.inputMode = sms ? "numeric" : "email";
    input.maxLength = sms ? 11 : 120;
    input.placeholder = sms ? "09123456789" : "guardian@email.com";
    input.value = g.contact;
    if (focus) { wrap.classList.remove("g-contact"); void wrap.offsetWidth; wrap.classList.add("g-contact"); input.focus(); }
}

function renderGuardians(focusIdx) {
    guardianList.innerHTML = "";
    guardians.forEach((g, i) => {
        const card = document.createElement("div");
        card.className = "g-card";
        card.innerHTML =
            '<div class="g-head"><b>Guardian ' + (i + 1) + (i === 0 ? ' <span class="req">(required)</span>' : "") + "</b>" +
            (i > 0 ? '<button type="button" class="btn ghost small" data-g="remove">Remove</button>' : "") + "</div>" +
            '<label class="field"><span>Full name</span><input data-g="name" type="text" maxlength="80" autocomplete="off" placeholder="Guardian\'s full name"></label>' +
            '<label class="field"><span>Contact method</span><select class="select" data-g="method">' +
            '<option value="">Select Email or SMS</option><option value="email">Email</option><option value="sms">SMS</option></select></label>' +
            '<label class="field" data-g="contactWrap" hidden><span></span><input data-g="contact" autocomplete="off"></label>';
        card.querySelector('[data-g="name"]').value = g.name;
        card.querySelector('[data-g="method"]').value = g.method;
        guardianList.appendChild(card);
        setContactField(card, g, false);
    });
    $("guardianCount").textContent = guardians.length + "/" + MAX_GUARDIANS;
    addGuardianBtn.disabled = guardians.length >= MAX_GUARDIANS;
    addGuardianBtn.title = addGuardianBtn.disabled ? "A maximum of 3 guardians can be added" : "";
    if (focusIdx !== undefined) guardianList.children[focusIdx].querySelector('[data-g="name"]').focus();
}

addGuardianBtn.addEventListener("click", () => {
    if (guardians.length >= MAX_GUARDIANS) return;
    guardians.push(newGuardian());
    renderGuardians(guardians.length - 1);
});

guardianList.addEventListener("input", (e) => {
    const card = e.target.closest(".g-card");
    const key = e.target.dataset.g;
    if (!card || !key) return;
    const g = guardians[Array.prototype.indexOf.call(guardianList.children, card)];
    if (key === "name") {
        const c = cleanName(e.target.value);
        if (c !== e.target.value) e.target.value = c;
        g.name = c;
    } else if (key === "contact") {
        if (g.method === "sms") {
            const d = e.target.value.replace(/\D/g, "").slice(0, 11);
            if (d !== e.target.value) e.target.value = d;
        }
        g.contact = e.target.value;
    }
    e.target.classList.remove("invalid");
});

guardianList.addEventListener("change", (e) => {
    if (e.target.dataset.g !== "method") return;
    const card = e.target.closest(".g-card");
    const g = guardians[Array.prototype.indexOf.call(guardianList.children, card)];
    g.method = e.target.value;
    g.contact = "";
    setContactField(card, g, true);
});

guardianList.addEventListener("click", (e) => {
    const b = e.target.closest('[data-g="remove"]');
    if (!b) return;
    guardians.splice(Array.prototype.indexOf.call(guardianList.children, b.closest(".g-card")), 1);
    renderGuardians();
});

function validateGuardians() {
    for (let i = 0; i < guardians.length; i++) {
        const g = guardians[i];
        const card = guardianList.children[i];
        const mark = (k) => card.querySelector('[data-g="' + k + '"]').classList.add("invalid");
        const label = "Guardian " + (i + 1) + ": ";
        if (!g.name.trim() || !NAME_RE.test(g.name.trim())) { mark("name"); toast(label + "enter the guardian's full name (letters only).", true); return false; }
        if (!g.method) { mark("method"); toast(label + "choose Email or SMS.", true); return false; }
        if (g.method === "sms" && !PHONE_PATTERN.test(g.contact)) { mark("contact"); toast(label + "enter an 11-digit mobile number starting with 09.", true); return false; }
        if (g.method === "email" && !EMAIL_RE.test(g.contact.trim())) { mark("contact"); toast(label + "enter a valid email address.", true); return false; }
    }
    return true;
}

// ---------- email (strictly @sjc.edu.ph) ----------
function updatePreview() {
    emailPreview.textContent = "Preview: " + (fEmail.value || "studentname") + "@" + EMAIL_DOMAIN;
}

function checkEmailInput(final) {
    const v = fEmail.value.trim().toLowerCase();
    const at = v.indexOf("@");
    if (at === -1) { fEmail.value = v; return updatePreview(); }

    const local = v.slice(0, at);
    const dom = v.slice(at + 1);
    const ok = dom === "" || dom === EMAIL_DOMAIN || (!final && EMAIL_DOMAIN.startsWith(dom));
    if (!ok) toast("Domain typed is not a valid school email domain please double check", true);
    if (!ok || dom === "" || dom === EMAIL_DOMAIN) fEmail.value = local;
    updatePreview();
}
fEmail.addEventListener("input", () => checkEmailInput(false));
fEmail.addEventListener("change", () => checkEmailInput(true));

// Student ID: 20261234567 -> 2026-123456
fStudentId.addEventListener("input", () => {
    const d = fStudentId.value.replace(/\D/g, "").slice(0, 10);
    fStudentId.value = d.length > 4 ? d.slice(0, 4) + "-" + d.slice(4) : d;
    fStudentId.classList.remove("invalid");
});
fPhone.addEventListener("input", () => {
    fPhone.value = fPhone.value.replace(/\D/g, "").slice(0, 11);
    fPhone.classList.remove("invalid");
});
[fFirst, fLast, fBalance, fLimit].forEach((el) => el.addEventListener("input", () => el.classList.remove("invalid")));
[fBalance, fLimit].forEach((el) => el.addEventListener("input", updateSaveState));

// ---------- RFID (no two accounts may share a card) ----------
let rfidHeld = false; // true once a scan was accepted; the next scan replaces it

function markRfid(state) {
    fRfid.classList.toggle("scanned", state === "scanned");
    if (editing && editing.status === "archived") {
        rfidHint.textContent = "This account is archived, so an RFID can't be assigned.";
    } else if (editing && editing.rfid_uid) {
        rfidHint.textContent = "RFID card linked to this account.";
    } else {
        rfidHint.textContent = state === "scanned"
            ? "Card is available. It will be linked when you save."
            : "Click the field, then tap the card on the reader. A card can only be linked to one account.";
    }
}

// Box is editable while creating or when the account has no card; locked once a card is linked.
function syncRfidControls() {
    const linked = !!(editing && editing.rfid_uid);
    const archived = !!(editing && editing.status === "archived");
    fRfid.readOnly = linked || archived;
    fRfid.placeholder = linked ? "" : "Click here, then tap the card on the reader";
    rfidClear.textContent = linked ? "Unlink" : "Clear";
    rfidClear.classList.toggle("danger", linked);
    rfidClear.classList.toggle("ghost", !linked);
    rfidClear.disabled = archived;
    cardTools.hidden = !editing;
    const frozen = !!(editing && editing.rfid_frozen);
    freezeBtn.textContent = frozen ? "Unfreeze card" : "Freeze card";
    freezeBtn.disabled = !linked;
    freezeHint.textContent = !linked ? "Link an RFID card first to be able to freeze it."
        : frozen ? "This card is frozen. Transactions made with it are blocked until you unfreeze it."
            : "Temporarily blocks transactions made with this card. You can unfreeze it anytime.";
    pinBtn.disabled = archived;
    markRfid("");
}

async function rfidOwner(uid) {
    let q = db.from(TABLE).select("full_name, suffix, student_id").eq("rfid_uid", uid);
    if (editing) q = q.neq("id", editing.id);
    const { data, error } = await q.limit(1);
    if (error) throw error;
    return (data && data[0]) || null;
}

function resetRfid() {
    fRfid.value = "";
    fRfid.classList.remove("invalid", "scanned");
    rfidHeld = false;
    markRfid("");
}

// Returns true if the card is free. A card linked to someone else is rejected and NOT kept in the box.
async function checkRfid() {
    const uid = fRfid.value.trim();
    if (!uid) return true;
    try {
        const owner = await rfidOwner(uid);
        if (owner) {
            resetRfid();
            toast(uid + " is assigned to " + displayName(owner) + " please use another RFID card.", true);
            return false;
        }
        return true;
    } catch (err) {
        toast(friendlyError(err), true);
        return false;
    }
}

// A new scan after an accepted one: wipe the old number, then let the new characters fill in.
fRfid.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (fRfid.readOnly) return;
        if (fRfid.value.trim() && (await checkRfid())) { markRfid("scanned"); rfidHeld = true; }
        return;
    }
    if (fRfid.readOnly) return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable && !/^\d$/.test(e.key)) { e.preventDefault(); return; } // RFID numbers are digits only
    if (rfidHeld && printable) resetRfid();
});
fRfid.addEventListener("paste", () => { if (rfidHeld && !fRfid.readOnly) resetRfid(); });
fRfid.addEventListener("input", () => {
    const d = fRfid.value.replace(/\D/g, "");
    if (d !== fRfid.value) fRfid.value = d;
    fRfid.classList.remove("invalid");
    markRfid("");
});
rfidClear.addEventListener("click", () => {
    if (editing && editing.rfid_uid) return unlinkRfid();
    resetRfid();
    fRfid.focus();
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

// These run in the database (see the migration SQL) so the change and its audit-log entry happen together.
async function rpc(fn, args) {
    if (!db) throw new Error("Supabase isn't configured yet.");
    const { error } = await db.rpc(fn, Object.assign({ p_token: cardToken() }, args));
    if (error) throw error;
}

async function unlinkRfid() {
    const uid = editing.rfid_uid;
    const name = displayName(editing);
    const ok = await confirmAction({
        title: "Unlink RFID " + uid + " from " + name + "?",
        html: "Unlinking this RFID will prevent it from being used for transactions under this account.<br><br>" + AUDIT_NOTE,
        danger: true
    });
    if (!ok) return;
    rfidClear.disabled = true;
    try {
        await rpc("admin_unlink_rfid", { p_id: editing.id });
        editing.rfid_uid = null;
        editing.rfid_frozen = false;
        resetRfid();
        renderSummary(editing);
        toast("RFID " + uid + " unlinked from " + name);
        loadTable(currentTerm, currentPage);
    } catch (err) {
        toast(friendlyError(err), true);
    } finally {
        syncRfidControls();
        if (!fRfid.readOnly) fRfid.focus();
    }
}

async function toggleFreeze() {
    if (!editing || !editing.rfid_uid) return;
    const next = !editing.rfid_frozen;
    freezeBtn.disabled = true;
    try {
        await rpc("admin_set_frozen", { p_id: editing.id, p_frozen: next });
        editing.rfid_frozen = next;
        renderSummary(editing);
        toast(next ? "Card frozen. Transactions with it are now blocked." : "Card unfrozen.");
        loadTable(currentTerm, currentPage);
    } catch (err) {
        toast(friendlyError(err), true);
    } finally {
        syncRfidControls();
    }
}
freezeBtn.addEventListener("click", toggleFreeze);

async function resetPin() {
    if (!editing) return;
    const name = displayName(editing);
    const ok = await confirmAction({
        title: "Reset " + name + "'s PIN?",
        html: "Resetting the PIN will set it to the default PIN <strong>1234</strong>. " + escapeHtml(name) +
            " will be immediately notified to update their PIN.<br><br>" + AUDIT_NOTE
    });
    if (!ok) return;
    pinBtn.disabled = true;
    try {
        await rpc("admin_reset_pin", { p_id: editing.id });
        toast(name + "'s PIN was reset to the default.");
    } catch (err) {
        toast(friendlyError(err), true);
    } finally {
        pinBtn.disabled = !!(editing && editing.status === "archived");
    }
}
pinBtn.addEventListener("click", resetPin);

async function archiveAccount(s) {
    const name = displayName(s);
    const ok = await confirmAction({
        title: "Archive " + name + "?",
        html: "Archiving this account will deactivate the " + (s.role === "student" ? "student's" : "user's") +
            " RFID for login and canteen transactions.<br><br>" + AUDIT_NOTE,
        danger: true
    });
    if (!ok) return;
    try {
        await rpc("admin_archive_account", { p_id: s.id });
        toast(name + " was archived.");
        await loadTable(currentTerm, currentPage);
    } catch (err) {
        toast(friendlyError(err), true);
    }
}

// ---------- archived accounts view ----------
const archiveViewBtn = $("archiveViewBtn");
function setArchivedView(on, reload = true) {
    archivedView = on;
    archiveViewBtn.classList.toggle("on", on);
    archiveViewBtn.setAttribute("aria-pressed", String(on));
    $("archiveViewLbl").textContent = on ? "Back to accounts" : "Archived accounts";
    suggestions = [];
    suggestSeq++;
    openSuggestions(false);
    if (reload) loadTable(searchInput.value.trim(), 1);
}
archiveViewBtn.addEventListener("click", () => setArchivedView(!archivedView));

async function unarchiveAccount(s) {
    const name = displayName(s);
    const ok = await confirmAction({
        title: "Unarchive " + name + "?",
        html: "Unarchiving this account will make it active again. Its RFID was removed when it was archived, so a new RFID card must be assigned by editing the account.<br><br>" + AUDIT_NOTE
    });
    if (!ok) return;
    try {
        await rpc("admin_unarchive_account", { p_id: s.id });
        toast(name + " was unarchived. Assign an RFID card by editing the account.");
        await loadTable(currentTerm, currentPage);
    } catch (err) {
        toast(friendlyError(err), true);
    }
}

// ---------- sliding role pill ----------
const pillSlider = $("pillSlider");
function moveSlider() {
    const b = rolePills.querySelector(".pill.on");
    if (!b) { pillSlider.style.width = "0px"; return; } // no filter: hide the highlight
    if (!b.offsetWidth) return;
    pillSlider.style.width = b.offsetWidth + "px";
    pillSlider.style.transform = "translateX(" + b.offsetLeft + "px)";
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
}
moveSlider();
requestAnimationFrame(() => { moveSlider(); pillSlider.classList.add("ready"); });
window.addEventListener("resize", moveSlider);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSlider);

// Enter in a field moves forward instead of submitting early
form.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type === "checkbox") return;
    e.preventDefault();
    if (!nextBtn.hidden) nextBtn.click();
    else if (!saveBtn.hidden) form.requestSubmit();
});

// ---------- validation ----------
function money(el) {
    const raw = el.value.trim();
    const n = Number(raw);
    if (raw === "" || !isFinite(n) || n < 0 || n > 99999999.99) return null;
    return Math.round(n * 100) / 100;
}

async function validateStep(n) {
    if (n === 1) {
        if (!fFirst.value.trim() || !fLast.value.trim()) {
            (!fFirst.value.trim() ? fFirst : fLast).classList.add("invalid");
            toast("First name and last name are required.", true);
            return false;
        }
        const nameBad = [[fFirst, true], [fMiddle, false], [fLast, true]].find(([el, req]) => {
            const v = el.value.trim();
            return v ? !NAME_RE.test(v) : req;
        });
        if (nameBad) {
            nameBad[0].classList.add("invalid");
            toast("Names can only contain letters (no numbers, symbols or quotation marks).", true);
            return false;
        }
        checkEmailInput(true);
        if (!/^[a-z0-9._-]+$/.test(fEmail.value)) {
            toast("Enter the school email username (letters, numbers, dots or dashes) before @" + EMAIL_DOMAIN + ".", true);
            fEmail.focus();
            return false;
        }
        if (fRole.value === "student" && !STUDENT_ID_PATTERN.test(fStudentId.value)) {
            fStudentId.classList.add("invalid");
            toast("Student ID number must be in the format YYYY-NNNNNN.", true);
            return false;
        }
        if (!PHONE_PATTERN.test(fPhone.value)) {
            fPhone.classList.add("invalid");
            toast("Phone number must be 11 digits and start with 09 (e.g. 09123456789).", true);
            return false;
        }
    }
    if (n === 2) {
        if (!fRfid.value.trim() && !editing) {
            fRfid.classList.add("invalid");
            toast("Tap a card on the reader to assign an RFID.", true);
            return false;
        }
        if (!(await checkRfid())) return false;
        if (fRfid.value.trim()) { markRfid("scanned"); rfidHeld = true; }
    }
    if (n === 3 && !validateGuardians()) return false;
    if (n === 4) {
        if (money(fBalance) === null) { fBalance.classList.add("invalid"); toast("Enter a valid E-wallet balance (0 or more).", true); return false; }
        if (money(fLimit) === null) { fLimit.classList.add("invalid"); toast("Enter a valid daily spending limit (0 or more).", true); return false; }
        if (!editing && !walletReady()) {
            toast("Please set an appropriate amount for the student's E-wallet balance and Spending limit to proceed", true);
            return false;
        }
    }
    return true;
}

// ---------- open / close ----------
function renderSummary(s) {
    $("smAvatar").textContent = initials(s.full_name);
    $("smName").textContent = displayName(s);
    $("smRole").textContent = cap(s.role || "student");
    const st = $("smStatus");
    st.textContent = cap(s.status || "active");
    st.className = "badge " + ((s.status || "active") === "active" ? "ok" : "none");
    $("smFrozen").hidden = !s.rfid_frozen;
    const meta = [];
    if (s.role === "student") meta.push("ID: " + (s.student_id || "-"));
    if (s.phone) meta.push(s.phone);
    if (s.email) meta.push(s.email);
    $("smMeta").textContent = meta.join("  \u2022  ");
    $("smBalance").textContent = peso.format(Number(s.balance || 0));
    $("smLimit").textContent = peso.format(Number(s.daily_limit || 0));
    $("smRfid").textContent = s.rfid_uid ? (s.rfid_frozen ? "Frozen" : "Linked") : "None";
}

function openDialog(student = null, startStep = 1) {
    editing = student;
    maxStep = 1;
    form.reset();
    rfidHeld = false;
    dialog.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    markRfid("");

    dialogTitle.textContent = student ? "Edit account" : "New account";
    fRole.disabled = !!student;
    summaryEl.hidden = !student;

    if (student) {
        fRole.value = student.role || "student";
        fFirst.value = student.first_name || "";
        fMiddle.value = student.middle_name || "";
        fLast.value = student.last_name || "";
        fSuffix.value = student.suffix || "";
        fPhone.value = student.phone || "";
        fEmail.value = (student.email || "").split("@")[0];
        fStudentId.value = student.student_id || "";
        fRfid.value = student.rfid_uid || "";
        rfidHeld = !!student.rfid_uid;
        fBalance.value = Number(student.balance || 0).toFixed(2);
        fLimit.value = Number(student.daily_limit || 0).toFixed(2);
        fPayLater.checked = !!student.pay_later_enabled;
        guardians = Array.isArray(student.guardians) && student.guardians.length
            ? student.guardians.map((g) => ({ name: g.name || "", method: g.method || "", contact: g.contact || "" }))
            : [newGuardian()];
        renderSummary(student);
    } else {
        guardians = [newGuardian()];
        fRole.value = "";
        fBalance.value = "0.00";
        fLimit.value = DEFAULT_DAILY_LIMIT.toFixed(2);
        fPayLater.checked = false;
    }

    syncRfidControls();
    renderGuardians();
    updatePreview();
    step = startStep;
    fRole.dispatchEvent(new Event("change"));
    dialog.showModal();
    if (student) goStep(startStep); else fRole.focus();
}

function closeDialog() { if (dialog.open) dialog.close(); }

addBtn.addEventListener("click", () => openDialog(null));
dlgClose.addEventListener("click", closeDialog);

// ---------- save / delete ----------
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

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!db) return toast("Supabase isn't configured yet. Add your URL and anon key in the JS file.", true);
    if (!fRole.value) return;

    for (const n of seq()) {
        if (!(await validateStep(n))) { goStep(n); return; }
    }

    const payload = {
        role: fRole.value,
        first_name: fFirst.value.replace(/\s+/g, " ").trim(),
        middle_name: fMiddle.value.replace(/\s+/g, " ").trim() || null,
        last_name: fLast.value.replace(/\s+/g, " ").trim(),
        suffix: fSuffix.value.replace(/\s+/g, " ").trim() || null,
        email: fEmail.value + "@" + EMAIL_DOMAIN,
        student_id: fRole.value === "student" ? fStudentId.value : null,
        phone: fPhone.value,
        rfid_uid: fRfid.value.trim() || null,
        balance: money(fBalance),
        daily_limit: money(fLimit),
        pay_later_enabled: fPayLater.checked,
        guardians: fRole.value === "student"
            ? guardians.map((g) => ({ name: g.name.trim(), method: g.method, contact: g.method === "email" ? g.contact.trim().toLowerCase() : g.contact }))
            : []
    };

    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = "Saving...";
    try {
        const query = editing
            ? db.from(TABLE).update(payload).eq("id", editing.id)
            : db.from(TABLE).insert(payload);
        const { data, error } = await query.select(COLUMNS).single();
        if (error) throw error;

        closeDialog();
        toast(editing ? "Account updated" : "Account created");
        searchInput.value = "";
        clearSearch.hidden = true;
        if (archivedView) setArchivedView(false, false);
        if (roleFilter && data.role !== roleFilter) setRole(data.role, false); // jump to the pill the account belongs to
        await loadTable("");
        flashRow(data.id);
    } catch (err) {
        toast(friendlyError(err), true);
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = label;
    }
});

// ============================================================
// 10. PARENT ACCOUNTS (edit email, link / unlink a student)
// ============================================================
const parentDialog = $("parentDialog");
const paEmail = $("paEmail"), paSearch = $("paSearch"), paResults = $("paResults");
let parentAcc = null;       // the parent being edited (fresh from admin_get_parent)
let paSeq = 0;

function paMessage(el, msg) { el.textContent = msg || ""; el.hidden = !msg; }

function paRender(p, resetEmail = true) {
    $("paAvatar").textContent = initials(p.full_name);
    $("paName").textContent = p.full_name || "Parent";
    const st = $("paStatus");
    st.textContent = cap(p.status || "active");
    st.className = "badge " + ((p.status || "active") === "active" ? "ok" : "none");
    $("paMeta").textContent = [p.email, p.phone].filter(Boolean).join("  \u2022  ");
    if (resetEmail) { paEmail.value = p.email || ""; paMessage($("paEmailMsg"), ""); $("paEmailSave").disabled = true; }

    const linked = !!p.student;
    $("paLinked").hidden = !linked;
    $("paNone").hidden = linked || !!p.loading;
    if (linked) {
        $("paStAv").textContent = initials(p.student.full_name);
        $("paStName").textContent = p.student.full_name;
        $("paStId").textContent = "Student ID " + (p.student.student_id || "-");
    }
    const pend = $("paPending");
    pend.hidden = !(p.pending && !linked);
    if (!pend.hidden) pend.textContent = "Waiting for the parent to confirm the link to " + p.pending.full_name + ". Linking a student here replaces that request.";
    paMessage($("paMsg"), "");
}

async function loadParent(id, resetEmail = true) {
    try {
        const { data, error } = await db.rpc("admin_get_parent", { p_token: cardToken(), p_id: id });
        if (error) throw error;
        parentAcc = data;
        paRender(data, resetEmail);
    } catch (err) {
        toast(friendlyError(err), true);
    }
}

async function openParentDialog(row) {
    parentAcc = null;
    paSeq++;
    paSearch.value = "";
    paResults.innerHTML = "";
    paRender({ id: row.id, full_name: displayName(row), email: row.email, phone: row.phone, status: row.status, loading: true });
    parentDialog.showModal();
    await loadParent(row.id);
}
$("paClose").addEventListener("click", () => parentDialog.close());
$("paDone").addEventListener("click", () => parentDialog.close());

// ---- email ----
$("paEmailForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!parentAcc) return;
    const v = paEmail.value.trim().toLowerCase();
    const msg = $("paEmailMsg");
    if (!EMAIL_RE.test(v)) { paEmail.classList.add("invalid"); return paMessage(msg, "Enter a valid email address."); }
    paEmail.classList.remove("invalid");
    if (v === (parentAcc.email || "").toLowerCase()) return toast("No changes to save.");
    const ok = await confirmAction({
        title: "Change " + parentAcc.full_name + "'s email?",
        html: "The email on this parent account will change from <strong>" + escapeHtml(parentAcc.email || "(none)") + "</strong> to <strong>" + escapeHtml(v) + "</strong>.<br><br>" + AUDIT_NOTE,
        yes: "Change email", no: "Go Back", ask: false
    });
    if (!ok) return;
    const btn = $("paEmailSave"); btn.disabled = true;
    try {
        const { error } = await db.rpc("admin_update_parent_email", { p_token: cardToken(), p_id: parentAcc.id, p_email: v });
        if (error) throw error;
        paMessage(msg, "");
        toast("Email updated.");
        await loadParent(parentAcc.id);
        loadTable(currentTerm, currentPage);
    } catch (err) {
        paMessage(msg, friendlyError(err));
    } finally {
        btn.disabled = !parentAcc || paEmail.value.trim().toLowerCase() === (parentAcc.email || "").toLowerCase();
    }
});
paEmail.addEventListener("input", () => {
    paEmail.classList.remove("invalid"); paMessage($("paEmailMsg"), "");
    // Save stays off until the email actually differs from the saved one
    $("paEmailSave").disabled = !parentAcc || paEmail.value.trim().toLowerCase() === (parentAcc.email || "").toLowerCase();
});

// ---- unlink ----
$("paUnlink").addEventListener("click", async () => {
    if (!parentAcc || !parentAcc.student) return;
    const parentName = parentAcc.full_name, stName = parentAcc.student.full_name;
    const ok = await confirmAction({
        title: "Unlink " + parentName + " from " + stName + "?",
        html: "The parent will lose access to this student's wallet, and the student's Pay Later will be turned off.<br><br>" + AUDIT_NOTE,
        yes: "Unlink", danger: true
    });
    if (!ok) return;
    const btn = $("paUnlink"); btn.disabled = true;
    try {
        const { error } = await db.rpc("admin_unlink_parent", { p_token: cardToken(), p_parent_id: parentAcc.id });
        if (error) throw error;
        toast(parentName + " was unlinked from " + stName + ".");
        await loadParent(parentAcc.id, false);
        loadTable(currentTerm, currentPage);
    } catch (err) {
        paMessage($("paMsg"), friendlyError(err));
    } finally {
        btn.disabled = false;
    }
});

// ---- link: search students, pick one ----
let paStudents = [];
const runPaSearch = debounce(async () => {
    const term = cleanTerm(paSearch.value);
    const seq = ++paSeq;
    if (!term) { paStudents = []; paResults.innerHTML = ""; return; }
    try {
        const { data, error } = await db.rpc("admin_search_students_for_link", { p_token: cardToken(), p_term: term });
        if (error) throw error;
        if (seq !== paSeq) return;
        paStudents = data || [];
        paResults.innerHTML = "";
        if (!paStudents.length) {
            const li = document.createElement("li"); li.className = "pa-none"; li.textContent = "No students match \"" + term + "\"."; paResults.appendChild(li); return;
        }
        paStudents.forEach((s, i) => {
            const li = document.createElement("li");
            li.innerHTML = '<button type="button" data-i="' + i + '"' + (s.linked ? " disabled" : "") + ">" +
                '<span class="sg-avatar">' + escapeHtml(initials(s.full_name)) + "</span>" +
                '<span class="pa-r-t"><b>' + highlight(displayName(s), term) + "</b><small>" + highlight(s.student_id || "-", term) +
                (s.linked ? " \u2022 already linked to " + escapeHtml(s.parent_name || "a parent") : "") + "</small></span></button>";
            paResults.appendChild(li);
        });
    } catch (err) {
        if (seq === paSeq) paMessage($("paMsg"), friendlyError(err));
    }
}, 220);
paSearch.addEventListener("input", runPaSearch);

paResults.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b || b.disabled || !parentAcc) return;
    const s = paStudents[Number(b.dataset.i)];
    if (!s) return;
    const ok = await confirmAction({
        title: "Link " + parentAcc.full_name + " to " + displayName(s) + "?",
        html: "This parent will be able to see the student's wallet and transactions, top up their balance, and activate Pay Later for them.<br><br>" + AUDIT_NOTE,
        yes: "Link", ask: true
    });
    if (!ok) return;
    try {
        const { error } = await db.rpc("admin_link_parent", { p_token: cardToken(), p_parent_id: parentAcc.id, p_student_id: s.id });
        if (error) throw error;
        toast(parentAcc.full_name + " was linked to " + displayName(s) + ".");
        paSearch.value = ""; paResults.innerHTML = "";
        await loadParent(parentAcc.id, false);
        loadTable(currentTerm, currentPage);
    } catch (err) {
        paMessage($("paMsg"), friendlyError(err));
    }
});

// ============================================================
// 11. START
// ============================================================
(async function start() {
    if (!configured) {
        showBanner("Supabase isn't connected yet. Add your project URL and anon key at the top of adminaccountmanagement.js.");
        renderTable([], "Students");
        emptyEl.textContent = "Connect Supabase to see students.";
    } else if (!(await requireAdmin())) {
        window.location.replace(LOGIN_PAGE); // not signed in as an admin
        return;
    } else {
        loadTable("");
    }
    loadProfile();
})();
// ============================================================
// 1. SUPABASE SETUP (same project + card-token session as Account Management)
// ============================================================
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";
const LOGIN_PAGE = "../../LOGIN/login.html";

function cardToken() {
    try { return (JSON.parse(sessionStorage.getItem("tapmate_session")) || {}).token || ""; }
    catch (_) { return ""; }
}
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { "x-card-token": cardToken() } }
});

async function requireAdmin() {
    if (!cardToken()) return false;
    try {
        const { data, error } = await db.rpc("card_session", { p_token: cardToken() });
        return !error && !!data && data.role === "admin";
    } catch (_) { return false; }
}

// ============================================================
// 2. SETTINGS + HELPERS
// ============================================================
const PAGE_SIZE = 5;
const PAGE_BUTTONS = 5;
const DEBOUNCE_MS = 220;
const NOT_LINKED_MSG = "This student is not eligible for a pay later because this student isn't currently linked to a parent.";
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

const $ = (id) => document.getElementById(id);
const appEl = $("app"), collapseBtn = $("collapseBtn"), menuBtn = $("menuBtn"), scrim = $("scrim");
const searchInput = $("searchInput"), clearSearch = $("clearSearch");
const rowsEl = $("rows"), emptyEl = $("emptyState"), pagerEl = $("pager");
const resultsTitle = $("resultsTitle"), resultsCount = $("resultsCount");
const bannerEl = $("banner"), toastEl = $("toast"), filterPills = $("filterPills");

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function highlight(text, term) {
    const safe = escapeHtml(text);
    if (!term) return safe;
    return safe.replace(new RegExp(escapeRegExp(escapeHtml(term)), "ig"), (m) => "<mark>" + m + "</mark>");
}
function initials(name) {
    const p = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!p.length) return "?";
    return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function displayName(s) { return (s.full_name || "") + (s.suffix ? " " + s.suffix : ""); }
function cleanTerm(q) { return q.replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim(); }
function friendlyError(err) { return (err && err.message) || "Something went wrong. Please try again."; }

let toastTimer, toastHide;
function toast(msg, isError = false) {
    clearTimeout(toastTimer); clearTimeout(toastHide);
    toastEl.textContent = msg;
    toastEl.className = "toast" + (isError ? " err" : "");
    toastEl.hidden = false;
    if (toastEl.showPopover) {
        try { toastEl.hidePopover(); } catch (_) { }
        toastEl.showPopover();
    }
    toastTimer = setTimeout(() => {
        toastEl.classList.add("out");
        toastHide = setTimeout(() => {
            toastEl.hidden = true;
            if (toastEl.hidePopover) { try { toastEl.hidePopover(); } catch (_) { } }
        }, 300);
    }, isError ? 5500 : 3200);
}
function showBanner(msg) { bannerEl.textContent = msg; bannerEl.hidden = !msg; }

// ============================================================
// 3. SIDEBAR (same behaviour as Account Management)
// ============================================================
const COLLAPSE_KEY = "tapmate.admin.sidebarCollapsed";
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

function setCollapsed(c) {
    appEl.classList.toggle("collapsed", c);
    collapseBtn.setAttribute("aria-expanded", String(!c));
    collapseBtn.setAttribute("aria-label", c ? "Expand sidebar" : "Collapse sidebar");
    try { localStorage.setItem(COLLAPSE_KEY, c ? "1" : "0"); } catch (_) { }
}
function setDrawer(open) { appEl.classList.toggle("drawer-open", open); scrim.hidden = !open; }

collapseBtn.addEventListener("click", () => {
    if (isMobile()) return setDrawer(false);
    setCollapsed(!appEl.classList.contains("collapsed"));
});
menuBtn.addEventListener("click", () => setDrawer(true));
scrim.addEventListener("click", () => setDrawer(false));
document.querySelector(".nav-btn.active").addEventListener("click", (e) => {
    e.preventDefault();
    if (isMobile()) setDrawer(false);
});
try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch (_) { }

$("logoutBtn").addEventListener("click", () => {
    try { sessionStorage.removeItem("tapmate_session"); } catch (_) { }
    window.location.replace(LOGIN_PAGE);
});

async function loadProfile() {
    try {
        const { data, error } = await db.rpc("admin_get_own_profile", { p_token: cardToken() });
        if (error || !data) return;
        const name = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(" ") || "Admin";
        $("pfName").textContent = name;
        const av = $("pfAvatar");
        av.style.backgroundImage = data.avatar ? 'url("' + data.avatar + '")' : "";
        av.textContent = data.avatar ? "" : initials(name);
    } catch (_) { }
}

// ============================================================
// 4. CONFIRM PROMPT
// ============================================================
const confirmDialog = $("confirmDialog");
function confirmAction({ title, html, yes = "Continue", danger = false }) {
    return new Promise((resolve) => {
        $("cfTitle").textContent = title;
        $("cfText").innerHTML = html;
        $("cfYes").textContent = yes;
        $("cfYes").classList.toggle("danger-fill", danger);
        confirmDialog.returnValue = "";
        const done = () => { confirmDialog.removeEventListener("close", done); resolve(confirmDialog.returnValue === "yes"); };
        confirmDialog.addEventListener("close", done);
        confirmDialog.showModal();
        $("cfNo").focus();
    });
}
$("cfYes").addEventListener("click", () => confirmDialog.close("yes"));
$("cfNo").addEventListener("click", () => confirmDialog.close("no"));

// ============================================================
// 5. DATA
// ============================================================
let filter = "all";      // all | eligible | unlinked
let currentTerm = "";
let currentPage = 1;
let currentRows = [];
let tableSeq = 0;

async function fetchStudents(term, page) {
    const { data, error } = await db.rpc("admin_pay_later_list", {
        p_token: cardToken(),
        p_search: cleanTerm(term),
        p_filter: filter,
        p_limit: PAGE_SIZE,
        p_offset: (page - 1) * PAGE_SIZE
    });
    if (error) throw error;
    const rows = data || [];
    return { rows, count: rows.length ? Number(rows[0].total_count) : 0 };
}

async function loadTable(term, page = 1) {
    currentTerm = term;
    currentPage = page;
    const seq = ++tableSeq;
    try {
        let res = await fetchStudents(term, page);
        if (!res.rows.length && page > 1) {
            currentPage = Math.max(1, Math.ceil(res.count / PAGE_SIZE));
            res = await fetchStudents(term, currentPage);
        }
        if (seq !== tableSeq) return;
        showBanner("");
        renderTable(res.rows, res.count, term);
    } catch (err) {
        if (seq === tableSeq) showBanner("Could not load students: " + friendlyError(err));
    }
}

// ============================================================
// 6. TABLE
// ============================================================
const TITLES = { all: "All students", eligible: "Linked to a parent", active: "Using Pay Later", unpaid: "Students with an unpaid balance", unlinked: "Not linked to a parent" };
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "\u2013";
function paymentCell(s) {
    if (!s.parent_linked) return "\u2013";
    const owed = Number(s.outstanding || 0);
    if (owed > 0) {
        return '<div class="parent-cell"><span class="badge ' + (s.overdue ? "warn" : "none") + '">' + (s.overdue ? "Overdue" : "Unpaid") + "</span>" +
            (s.due_at ? "<small>Due " + escapeHtml(fmtDate(s.due_at)) + "</small>" : "") + "</div>";
    }
    return Number(s.used_count || 0) > 0 ? '<span class="badge ok">Settled</span>' : "\u2013";
}

function renderTable(list, total, term) {
    currentRows = list;
    resultsTitle.textContent = term ? "Results for \"" + term + "\"" : TITLES[filter];
    resultsCount.textContent = total + (total === 1 ? " student" : " students");
    rowsEl.innerHTML = "";
    renderPager(total);

    if (!list.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = term ? "No students match your search." : "No students in this list yet.";
        return;
    }
    emptyEl.hidden = true;

    const t = cleanTerm(term);
    list.forEach((s) => {
        const tr = document.createElement("tr");
        tr.dataset.id = s.id;

        const parentCell = s.parent_linked
            ? '<div class="parent-cell"><span class="badge ok">Linked</span><small>' + escapeHtml(s.parent_name || "Parent") + "</small></div>"
            : '<div class="parent-cell"><span class="badge none">Not linked</span></div>';

        const payCell = s.parent_linked
            ? (s.pay_later_enabled ? '<span class="badge ok">Active</span>' : '<span class="badge none">Off</span>')
            : '<span class="badge warn">Not eligible</span><p class="not-eligible">' + escapeHtml(NOT_LINKED_MSG) + "</p>";

        const lim = Number(s.pay_later_limit || 0);
        const outstanding = s.parent_linked
            ? "<b>" + peso.format(Number(s.outstanding || 0)) + "</b>" + (s.pay_later_enabled && lim > 0 ? '<span class="sub-t">of ' + peso.format(lim) + " limit</span>" : "")
            : "\u2013";

        let actions = '<button class="btn ghost small" data-act="view" type="button">View ledger</button>';
        if (s.parent_linked && s.pay_later_enabled) {   // only the parent can switch it on
            actions += '<button class="btn ghost small" data-act="toggle" type="button">Disable</button>';
        }

        tr.innerHTML =
            '<td class="mono">' + highlight(s.student_id || "-", t) + "</td>" +
            "<td>" + highlight(displayName(s), t) + "</td>" +
            "<td>" + parentCell + "</td>" +
            "<td>" + payCell + "</td>" +
            '<td class="num">' + outstanding + "</td>" +
            "<td>" + paymentCell(s) + "</td>" +
            '<td class="right"><span class="row-actions">' + actions + "</span></td>";
        rowsEl.appendChild(tr);
    });
}

function renderPager(total) {
    const pages = Math.ceil(total / PAGE_SIZE);
    if (pages <= 1) { pagerEl.hidden = true; pagerEl.innerHTML = ""; return; }
    const from = (currentPage - 1) * PAGE_SIZE + 1;
    const to = Math.min(total, currentPage * PAGE_SIZE);
    let html = '<span class="info">Showing ' + from + "\u2013" + to + " of " + total + "</span>" +
        '<span class="pages"><button type="button" data-page="' + (currentPage - 1) + '"' + (currentPage === 1 ? " disabled" : "") + ' aria-label="Previous page">&lsaquo;</button>';
    const start = Math.max(1, Math.min(currentPage - Math.floor(PAGE_BUTTONS / 2), pages - PAGE_BUTTONS + 1));
    const end = Math.min(pages, start + PAGE_BUTTONS - 1);
    const num = (p) => '<button type="button" data-page="' + p + '"' + (p === currentPage ? ' class="on" aria-current="page"' : "") + ' aria-label="Page ' + p + '">' + p + "</button>";
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

// ---------- search ----------
const runSearch = debounce(() => {
    const term = searchInput.value.trim();
    clearSearch.hidden = !term;
    loadTable(term, 1);
}, DEBOUNCE_MS);
searchInput.addEventListener("input", runSearch);
searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) { searchInput.value = ""; runSearch(); }
});
clearSearch.addEventListener("click", () => { searchInput.value = ""; clearSearch.hidden = true; loadTable("", 1); searchInput.focus(); });

// ---------- filter pills (sliding highlight) ----------
const pillSlider = $("pillSlider");
function moveSlider() {
    const b = filterPills.querySelector(".pill.on");
    if (!b || !b.offsetWidth) return;
    pillSlider.style.width = b.offsetWidth + "px";
    pillSlider.style.transform = "translateX(" + b.offsetLeft + "px)";
}
filterPills.addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b || b.dataset.filter === filter) return;
    filter = b.dataset.filter;
    filterPills.querySelectorAll(".pill").forEach((p) => {
        const on = p === b;
        p.classList.toggle("on", on);
        p.setAttribute("aria-selected", String(on));
    });
    moveSlider();
    loadTable(searchInput.value.trim(), 1);
});
moveSlider();
requestAnimationFrame(() => { moveSlider(); pillSlider.classList.add("ready"); });
window.addEventListener("resize", moveSlider);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSlider);

// ---------- row actions ----------
rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const s = currentRows.find((r) => String(r.id) === String(btn.closest("tr").dataset.id));
    if (!s) return;
    if (btn.dataset.act === "view") openLedger(s);
    else if (btn.dataset.act === "toggle") togglePayLater(s, btn);
});

async function togglePayLater(s, btn) {
    const next = !s.pay_later_enabled;
    const name = displayName(s);
    const ok = await confirmAction({
        title: (next ? "Enable" : "Disable") + " pay later for " + name + "?",
        html: next
            ? "This student will be able to buy now and settle later."
            : "This student will no longer be able to buy now and settle later. Existing balances stay on the ledger.",
        yes: next ? "Enable" : "Disable",
        danger: !next
    });
    if (!ok) return;
    btn.disabled = true;
    try {
        const { error } = await db.rpc("admin_set_pay_later", { p_token: cardToken(), p_id: s.id, p_enabled: next });
        if (error) throw error;
        toast("Pay later " + (next ? "enabled" : "disabled") + " for " + name + ".");
        await loadTable(currentTerm, currentPage);
    } catch (err) {
        toast(friendlyError(err), true);
        btn.disabled = false;
    }
}

// ============================================================
// 7. LEDGER DIALOG
// ============================================================
const ledgerDialog = $("ledgerDialog");
const ldRows = $("ldRows");
let ledgerSeq = 0;

async function openLedger(s) {
    $("ldAvatar").textContent = initials(s.full_name);
    $("ldName").textContent = displayName(s);
    const badge = $("ldBadge");
    badge.textContent = s.parent_linked ? (s.pay_later_enabled ? "Pay later active" : "Pay later off") : "Not eligible";
    badge.className = "badge " + (s.parent_linked ? (s.pay_later_enabled ? "ok" : "none") : "warn");
    $("ldMeta").textContent = ["ID: " + (s.student_id || "-"), s.parent_linked ? "Parent: " + (s.parent_name || "linked") + (s.parent_contact ? " (" + s.parent_contact + ")" : "") : "No parent linked"].join("  \u2022  ");
    const owed = Number(s.outstanding || 0), lim = Number(s.pay_later_limit || 0);
    $("ldOutstanding").textContent = s.parent_linked ? peso.format(owed) : "\u2013";

    const notice = $("ldNotice"), body = $("ldBody"), usage = $("ldUsage");
    ldRows.innerHTML = "";
    $("ldEmpty").hidden = true;

    if (!s.parent_linked) {
        notice.textContent = NOT_LINKED_MSG;
        notice.hidden = false; body.hidden = true; usage.hidden = true;
        ledgerDialog.showModal();
        return;
    }

    // current usage
    usage.hidden = false;
    const pct = lim > 0 ? Math.min(100, owed / lim * 100) : 0;
    $("ldFill").style.width = pct + "%";
    $("ldBar").className = "ld-bar" + (pct >= 100 ? " full" : pct >= 80 ? " warn" : "");
    $("ldBar").setAttribute("aria-valuenow", Math.round(pct));
    $("ldBarText").textContent = !s.pay_later_enabled && !owed ? "Pay Later is off for this student."
        : lim > 0 ? peso.format(owed) + " used of " + peso.format(lim) + " limit"
            : peso.format(owed) + " used (no limit set yet)";
    $("ldLimit").textContent = lim > 0 ? peso.format(lim) : "Not set";
    $("ldAvail").textContent = s.pay_later_enabled ? peso.format(Math.max(lim - owed, 0)) : "\u2013";
    $("ldUses").textContent = Number(s.used_count || 0) + " of " + Number(s.max_uses || 0);
    $("ldDue").textContent = owed > 0 ? fmtDate(s.due_at) : "Nothing due";

    if (s.overdue) {
        notice.textContent = "Payment is overdue. " + peso.format(owed) + " was due " + fmtDate(s.due_at) + ". This student can't use Pay Later until it is settled.";
        notice.hidden = false;
    } else notice.hidden = true;
    body.hidden = false;
    ledgerDialog.showModal();

    const seq = ++ledgerSeq;
    try {
        const { data, error } = await db.rpc("admin_pay_later_entries", { p_token: cardToken(), p_id: s.id });
        if (error) throw error;
        if (seq !== ledgerSeq) return;
        const list = data || [];
        $("ldEmpty").hidden = list.length > 0;
        list.forEach((r) => {
            const charge = r.kind === "charge";
            let status = "\u2013";
            if (charge) {
                const paid = Number(r.paid_amount || 0), amt = Number(r.amount);
                status = r.status === "paid" ? '<span class="badge ok">Paid</span>'
                    : r.status === "partial" ? '<span class="badge warn">Partly paid</span><span class="paid-note">' + peso.format(paid) + " of " + peso.format(amt) + "</span>"
                        : '<span class="badge none">Unpaid</span>';
            }
            const tr = document.createElement("tr");
            tr.innerHTML =
                '<td class="muted">' + escapeHtml(fmtDate(r.created_at)) + "</td>" +
                "<td>" + (charge ? "Purchase (Pay Later)" : "Payment") + "</td>" +
                '<td class="muted">' + escapeHtml(r.note || "") + "</td>" +
                '<td class="right num ' + (charge ? "amt-charge" : "amt-payment") + '">' + (charge ? "" : "\u2212") + peso.format(Number(r.amount)) + "</td>" +
                "<td>" + status + "</td>";
            ldRows.appendChild(tr);
        });
    } catch (err) {
        toast(friendlyError(err), true);
    }
}
$("ldClose").addEventListener("click", () => ledgerDialog.close());
$("ldDone").addEventListener("click", () => ledgerDialog.close());

// ============================================================
// 8. START
// ============================================================
(async function start() {
    if (!(await requireAdmin())) { window.location.replace(LOGIN_PAGE); return; }
    loadTable("");
    loadProfile();
})();
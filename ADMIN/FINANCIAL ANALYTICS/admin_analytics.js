// ============================================================
// TapMate Admin | Financial Analytics
// Read-only: revenue, best sellers, payment methods, refunds,
// student transactions (with the cashier who confirmed them) and
// refund decisions (with the cashier who approved / rejected them).
// Backend: admin_analytics.sql  (RPCs: admin_analytics_summary,
// admin_analytics_transactions, admin_analytics_refunds)
// ============================================================

// ============================================================
// 1. SUPABASE SETUP (same project as the other admin pages)
//    Never put the service_role key in front-end code.
// ============================================================
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

const LOGIN_PAGE = "../../LOGIN/login.html"; // same folder depth as the other admin pages

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
    } catch (_) {
        return false;
    }
}

// ============================================================
// 2. SETTINGS
// ============================================================
const PAGE_SIZE = 5;             // rows per page
const PAGE_BUTTONS = 5;          // page numbers shown at once
const DEBOUNCE_MS = 220;
const EXPORT_CHUNK = 1000;       // rows fetched per request when exporting
const EXPORT_MAX_PAGES = 100;    // safety stop (100,000 rows)

const RANGE_LABEL = { today: "Today", week: "This week", month: "This month", all: "All time" };
const METHOD_LABEL = { cash: "Cash", wallet: "TapMate wallet", gcash: "GCash", pay_later: "Pay later", paylater: "Pay later", rfid: "RFID wallet" };
const STATUS_LABEL = { pending: "Pending", approved: "Approved", rejected: "Rejected" };
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

// ============================================================
// 3. ELEMENTS
// ============================================================
const $ = (id) => document.getElementById(id);
const appEl = $("app"), collapseBtn = $("collapseBtn"), menuBtn = $("menuBtn"), scrim = $("scrim");
const bannerEl = $("banner"), toastEl = $("toast");

// ============================================================
// 4. HELPERS
// ============================================================
function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function highlight(text, term) {
    const safe = escapeHtml(text);
    if (!term) return safe;
    return safe.replace(new RegExp(escapeRegExp(escapeHtml(term)), "ig"), (m) => "<mark>" + m + "</mark>");
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const cap = (s) => String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1);
const num = (n) => Number(n) || 0;
const fmtWhen = (iso) => iso
    ? new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
const methodLabel = (m) => METHOD_LABEL[String(m || "").toLowerCase()] || cap(String(m || "unknown").replace(/_/g, " "));

// "Rice meal x2, Juice"
function itemsText(items) {
    if (!Array.isArray(items) || !items.length) return "";
    return items.map((i) => {
        const name = i.name || i.product_name || "Item";
        const q = num(i.qty ?? i.quantity ?? 1);
        return q > 1 ? name + " \u00d7" + q : name;
    }).join(", ");
}

let toastTimer, toastHide;
function toast(msg, isError = false) {
    clearTimeout(toastTimer); clearTimeout(toastHide);
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
function showBanner(msg) { bannerEl.textContent = msg; bannerEl.hidden = !msg; }

function friendlyError(err) {
    const msg = (err.message || "") + " " + (err.details || "");
    if (err.code === "42501" || /row-level security|permission denied|admins only/i.test(msg)) return "You don't have permission to do that. Please sign in again.";
    if (err.code === "PGRST202" || /could not find the function|admin_analytics/i.test(msg)) return "Financial Analytics is not set up yet. Run admin_analytics.sql in Supabase.";
    if (/relation .* does not exist|column .* does not exist/i.test(msg)) return "Financial Analytics could not read your sales/refund tables. Check the column mapping at the top of admin_analytics.sql.";
    return err.message || "Something went wrong. Please try again.";
}

// ============================================================
// 5. SIDEBAR (identical behaviour to the other admin pages)
// ============================================================
const COLLAPSE_KEY = "tapmate.admin.sidebarCollapsed";
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

function setCollapsed(collapsed) {
    appEl.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (_) { /* ignore */ }
    setTimeout(moveSliders, 320);
}
function setDrawer(open) { appEl.classList.toggle("drawer-open", open); scrim.hidden = !open; }

collapseBtn.addEventListener("click", () => {
    if (isMobile()) return setDrawer(false);
    setCollapsed(!appEl.classList.contains("collapsed"));
});
menuBtn.addEventListener("click", () => setDrawer(true));
document.querySelector(".nav-btn.active").addEventListener("click", (e) => {
    e.preventDefault();
    if (isMobile()) setDrawer(false);
});
scrim.addEventListener("click", () => setDrawer(false));
try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch (_) { /* ignore */ }

// Profile dialog + PIN management live in adminprofile.js (shared by all admin pages)
$("logoutBtn").addEventListener("click", () => {
    try { sessionStorage.removeItem("tapmate_session"); } catch (_) { /* ignore */ }
    window.location.replace(LOGIN_PAGE);
});

// ============================================================
// 6. SLIDING PILLS (same component as the category pills on Stock & Inventory)
// ============================================================
const sliders = [];
function makePills(root, onPick) {
    const slider = root.querySelector(".pill-slider");
    const move = () => {
        const b = root.querySelector(".pill.on");
        if (!b || !b.offsetWidth) { slider.style.width = "0px"; return; }
        slider.style.width = b.offsetWidth + "px";
        slider.style.transform = "translateX(" + b.offsetLeft + "px)";
    };
    root.addEventListener("click", (e) => {
        const b = e.target.closest(".pill");
        if (!b || b.classList.contains("on")) return;
        root.querySelectorAll(".pill").forEach((p) => {
            const on = p === b;
            p.classList.toggle("on", on);
            p.setAttribute("aria-selected", String(on));
        });
        move();
        onPick(b.dataset.v);
    });
    requestAnimationFrame(() => { move(); slider.classList.add("ready"); });
    sliders.push(move);
    return move;
}
function moveSliders() { sliders.forEach((m) => m()); }
window.addEventListener("resize", moveSliders);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSliders);

// ============================================================
// 6b. SWIPEABLE PANEL (Refunds & disputes <-> Top-ups)
//     Drag / swipe / arrow keys / buttons / dots. The track follows the finger,
//     then eases to the nearest slide.
// ============================================================
(function initCarousel() {
    const root = $("car"), vp = $("carViewport"), track = $("carTrack");
    const slides = [...track.children], dots = [...$("carDots").children];
    const prev = $("carPrev"), next = $("carNext"), title = $("carTitle");
    let idx = 0, startX = 0, startY = 0, dx = 0, dragging = false, locked = null, w = 1;

    function setH() {   // viewport height follows the active slide
        vp.style.height = slides[idx].offsetHeight + "px";
    }
    function go(i, animate = true) {
        idx = Math.max(0, Math.min(slides.length - 1, i));
        track.style.transition = animate ? "" : "none";
        track.style.transform = "translateX(" + (-idx * 100) + "%)";
        slides.forEach((sl, n) => { sl.setAttribute("aria-hidden", String(n !== idx)); sl.toggleAttribute("inert", n !== idx); });
        dots.forEach((d, n) => { d.classList.toggle("on", n === idx); d.setAttribute("aria-selected", String(n === idx)); });
        prev.disabled = idx === 0; next.disabled = idx === slides.length - 1;
        title.classList.add("swap");
        setTimeout(() => { title.textContent = slides[idx].dataset.title; title.classList.remove("swap"); }, animate ? 140 : 0);
        setH();
    }
    function down(e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        if (e.target.closest("button")) return;
        dragging = true; locked = null; dx = 0; startX = e.clientX; startY = e.clientY; w = vp.clientWidth || 1;
    }
    function move(e) {
        if (!dragging) return;
        const mx = e.clientX - startX, my = e.clientY - startY;
        if (locked === null && (Math.abs(mx) > 6 || Math.abs(my) > 6)) {
            locked = Math.abs(mx) > Math.abs(my) ? "x" : "y";
            if (locked === "x") { track.classList.add("dragging"); try { vp.setPointerCapture(e.pointerId); } catch (_) { } }
        }
        if (locked !== "x") return;
        dx = mx;
        // rubber-band at the ends
        const atEdge = (idx === 0 && dx > 0) || (idx === slides.length - 1 && dx < 0);
        const eff = atEdge ? dx * 0.3 : dx;
        track.style.transition = "none";
        track.style.transform = "translateX(calc(" + (-idx * 100) + "% + " + eff + "px))";
    }
    function up() {
        if (!dragging) return;
        dragging = false;
        track.classList.remove("dragging");
        if (locked === "x") {
            const thr = Math.min(80, w * 0.18);
            if (dx < -thr) go(idx + 1); else if (dx > thr) go(idx - 1); else go(idx);
        }
        locked = null;
    }
    vp.addEventListener("pointerdown", down);
    vp.addEventListener("pointermove", move);
    vp.addEventListener("pointerup", up);
    vp.addEventListener("pointercancel", up);
    vp.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
    });
    vp.addEventListener("dragstart", (e) => e.preventDefault());
    prev.addEventListener("click", () => go(idx - 1));
    next.addEventListener("click", () => go(idx + 1));
    dots.forEach((d) => d.addEventListener("click", () => go(Number(d.dataset.i))));
    window.addEventListener("resize", setH);
    if (window.ResizeObserver) slides.forEach((sl) => new ResizeObserver(setH).observe(sl));
    go(0, false);
})();

// ============================================================
// 7. STATE
// ============================================================
let range = "month";        // today | week | month | all
let sumSeq = 0;

// the period pills drive the summary AND both lists
makePills($("rangePills"), (v) => { range = v; loadSummary(); txTable.load(1); rfTable.load(1); });

// ============================================================
// 8. SUMMARY (revenue cards, best sellers, payment methods, refunds)
// ============================================================
async function loadSummary() {
    const seq = ++sumSeq;
    try {
        const { data, error } = await db.rpc("admin_analytics_summary", { p_token: cardToken(), p_range: range });
        if (error) throw error;
        if (seq !== sumSeq) return;
        showBanner("");
        renderSummary(data || {});
    } catch (err) {
        if (seq !== sumSeq) return;
        showBanner("Could not load analytics: " + friendlyError(err));
    }
}

function periodCard(valId, subId, p) {
    p = p || {};
    $(valId).textContent = peso.format(num(p.revenue));
    const sales = num(p.count) + (num(p.count) === 1 ? " sale" : " sales");
    const refunded = num(p.refunded) > 0 ? " \u00b7 " + peso.format(num(p.refunded)) + " refunded" : "";
    $(subId).textContent = sales + refunded;
}

// Rows with a proportional bar. rows = [{ name, right, value }]
function barList(el, rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    el.innerHTML = rows.map((r) =>
        '<li><div class="bar-top"><span class="bar-name" title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) +
        '</span><span class="bar-val">' + escapeHtml(r.right) + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill" data-w="' + Math.round((r.value / max) * 100) + '"></div></div></li>'
    ).join("");
    // next frame so the bars animate from 0
    requestAnimationFrame(() => el.querySelectorAll(".bar-fill").forEach((b) => { b.style.width = b.dataset.w + "%"; }));
}

function renderSummary(s) {
    periodCard("kToday", "kTodaySub", s.today);
    periodCard("kWeek", "kWeekSub", s.week);
    periodCard("kMonth", "kMonthSub", s.month);

    const r = s.range || {};
    $("kAvg").textContent = peso.format(num(r.avg));
    $("kAvgSub").textContent = RANGE_LABEL[range] + " \u00b7 " + num(r.count) + (num(r.count) === 1 ? " sale" : " sales");

    // best sellers
    const top = Array.isArray(s.top_items) ? s.top_items : [];
    $("topCount").textContent = RANGE_LABEL[range];
    $("topHero").hidden = !top.length;
    $("topEmpty").hidden = !!top.length;
    if (top.length) {
        $("topName").textContent = top[0].name;
        $("topQty").textContent = num(top[0].qty) + " sold";
    }
    barList($("topList"), top.map((t) => ({ name: t.name, right: num(t.qty) + " sold", value: num(t.qty) })));

    // payment methods
    const methods = Array.isArray(s.methods) ? s.methods : [];
    const totalAmt = methods.reduce((a, m) => a + num(m.amount), 0);
    $("methodCount").textContent = RANGE_LABEL[range];
    $("methodEmpty").hidden = !!methods.length;
    barList($("methodList"), methods.map((m) => ({
        name: methodLabel(m.method),
        right: peso.format(num(m.amount)) + " \u00b7 " + num(m.count) + " \u00b7 " + (totalAmt ? Math.round(num(m.amount) / totalAmt * 100) : 0) + "%",
        value: num(m.amount)
    })));
    txTable.setMethods(methods.map((m) => m.method));

    // refunds & disputes
    const rf = s.refunds || {};
    $("carCount").textContent = RANGE_LABEL[range];
    $("rfTotal").textContent = num(rf.count);
    $("rfPending").textContent = num(rf.pending);
    $("rfApproved").textContent = num(rf.approved);
    $("rfRejected").textContent = num(rf.rejected);
    $("rfAmount").textContent = peso.format(num(rf.amount));
    const rfTop = Array.isArray(rf.top_items) ? rf.top_items : [];
    $("rfItemEmpty").hidden = !!rfTop.length;
    barList($("rfItemList"), rfTop.map((t) => ({
        name: t.name,
        right: num(t.qty) + (num(t.qty) === 1 ? " refund" : " refunds"),
        value: num(t.qty)
    })));

    // top-ups
    const tu = s.topups || {};
    $("tuTotal").textContent = num(tu.count);
    $("tuPending").textContent = num(tu.pending);
    $("tuApproved").textContent = num(tu.approved);
    $("tuRejected").textContent = num(tu.rejected);
    $("tuAmount").textContent = peso.format(num(tu.approved_amount));
    $("tuAvg").textContent = peso.format(num(tu.avg));
    $("tuWallet").textContent = peso.format(num(tu.wallet_total));
    $("tuWalletSub").textContent = num(tu.wallet_accounts) + (num(tu.wallet_accounts) === 1 ? " student wallet" : " student wallets");
    $("tuEmpty").hidden = num(tu.count) > 0;
    barList($("tuBarList"), num(tu.count) ? [
        { name: "Approved", right: num(tu.approved) + " \u00b7 " + peso.format(num(tu.approved_amount)), value: num(tu.approved) },
        { name: "Rejected", right: num(tu.rejected) + " \u00b7 " + peso.format(num(tu.rejected_amount)), value: num(tu.rejected) },
        { name: "Pending", right: num(tu.pending) + " \u00b7 " + peso.format(num(tu.pending_amount)), value: num(tu.pending) }
    ] : []);
}

// ============================================================
// 9. RECORD LISTS (student transactions + refunds): same component, used twice
//    Each list has its own search, filter, pager and Export CSV.
//    Both follow the period pills (Today / This month / This week / All time).
// ============================================================
const HEAD_TX = "<tr><th>Date &amp; time</th><th>Student</th><th>Items</th><th>Payment</th><th class=\"right\">Amount</th><th>Confirmed by (cashier)</th></tr>";
const HEAD_RF = "<tr><th>Requested</th><th>Student</th><th>Items</th><th class=\"right\">Amount</th><th>Status</th><th>Decided by (cashier)</th></tr>";

// Quote every field; neutralise spreadsheet formulas typed into free text (e.g. a refund reason)
function csvCell(v) {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}
const csvWhen = (iso) => iso ? new Date(iso).toLocaleString("en-PH", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";

function makeTable(kind) {
    const p = kind;                                   // element-id prefix: "tx" or "rf"
    const el = {};
    ["Search", "Clear", "Filter", "Count", "Export", "Head", "Rows", "Empty", "Pager"].forEach((k) => { el[k] = $(p + k); });
    const exportLbl = el.Export.querySelector("span");
    const isTx = kind === "tx";
    let term = "", filter = "", page = 1, total = 0, seq = 0, methods = [];

    el.Head.innerHTML = isTx ? HEAD_TX : HEAD_RF;

    // ---- filter dropdown ----
    function fillFilter() {
        if (isTx) {
            el.Filter.innerHTML = '<option value="">All payment methods</option>' +
                methods.map((m) => '<option value="' + escapeHtml(m) + '">' + escapeHtml(methodLabel(m)) + "</option>").join("");
        } else {
            el.Filter.innerHTML = '<option value="">All statuses</option>' +
                Object.keys(STATUS_LABEL).map((k) => '<option value="' + k + '">' + STATUS_LABEL[k] + "</option>").join("");
        }
        el.Filter.value = filter;
        if (el.Filter.value !== filter) el.Filter.value = "";
    }
    function setMethods(list) {
        methods = [...new Set([...(list || []), ...methods].filter(Boolean))];
        fillFilter();
    }

    // ---- data ----
    function fetchPage(pg, size) {
        const common = { p_token: cardToken(), p_range: range, p_search: term, p_limit: size, p_offset: (pg - 1) * size };
        return isTx
            ? db.rpc("admin_analytics_transactions", { ...common, p_method: filter })
            : db.rpc("admin_analytics_refunds", { ...common, p_status: filter });
    }

    async function load(pg = page) {
        const mine = ++seq;
        page = pg;
        try {
            const { data, error } = await fetchPage(pg, PAGE_SIZE);
            if (error) throw error;
            if (mine !== seq) return;
            const rows = (data && data.rows) || [];
            total = num(data && data.total);
            if (!rows.length && total > 0 && pg > 1) return load(1);   // landed past the last page
            render(rows);
        } catch (err) {
            if (mine !== seq) return;
            el.Rows.innerHTML = "";
            el.Pager.hidden = true;
            total = 0;
            el.Count.textContent = "";
            el.Empty.textContent = friendlyError(err);
            el.Empty.hidden = false;
            syncExport();
        }
    }

    // ---- render ----
    function studentCell(r) {
        const nm = r.student_name ? highlight(r.student_name, term) : '<span class="dash">Unknown student</span>';
        return '<span class="who">' + nm + "</span>" +
            (r.student_no ? '<span class="sub">' + highlight(r.student_no, term) + "</span>" : "");
    }
    function personCell(name, when) {
        if (!name) return '<span class="dash">&mdash;</span>';
        return '<span class="who">' + highlight(name, term) + "</span>" + (when ? '<span class="sub">' + escapeHtml(fmtWhen(when)) + "</span>" : "");
    }

    function render(list) {
        el.Count.textContent = total ? total + (total === 1 ? " record" : " records") : "";
        el.Rows.innerHTML = "";
        if (!list.length) {
            el.Empty.textContent = (term || filter)
                ? "No " + (isTx ? "transactions" : "refunds") + " match your search."
                : (isTx ? "No transactions in this period yet." : "No refund requests in this period.");
            el.Empty.hidden = false;
            el.Pager.hidden = true;
            syncExport();
            return;
        }
        el.Empty.hidden = true;
        el.Rows.innerHTML = list.map((r) => {
            const items = itemsText(r.items);
            const itemTd = '<td class="cell-items" title="' + escapeHtml(items) + '">' + (items ? highlight(items, term) : '<span class="dash">&mdash;</span>') + "</td>";
            if (isTx) {
                return "<tr><td>" + escapeHtml(fmtWhen(r.created_at)) + "</td><td>" + studentCell(r) + "</td>" + itemTd +
                    '<td><span class="badge method">' + escapeHtml(methodLabel(r.method)) + "</span></td>" +
                    '<td class="right mono">' + peso.format(num(r.amount)) + "</td>" +
                    "<td>" + personCell(r.cashier_name) + "</td></tr>";
            }
            const st = String(r.status || "pending").toLowerCase();
            return "<tr><td>" + escapeHtml(fmtWhen(r.created_at)) + "</td><td>" + studentCell(r) + "</td>" + itemTd +
                '<td class="right mono">' + peso.format(num(r.amount)) + "</td>" +
                '<td><span class="badge rf-' + escapeHtml(st) + '">' + escapeHtml(STATUS_LABEL[st] || cap(st)) + "</span></td>" +
                "<td>" + (st === "pending" ? '<span class="dash">Awaiting decision</span>' : personCell(r.decided_by_name, r.decided_at)) + "</td></tr>";
        }).join("");
        renderPager();
        syncExport();
    }

    function renderPager() {
        const pages = Math.ceil(total / PAGE_SIZE);
        if (pages <= 1) { el.Pager.hidden = true; el.Pager.innerHTML = ""; return; }
        const from = (page - 1) * PAGE_SIZE + 1;
        const to = Math.min(total, page * PAGE_SIZE);
        let html = '<span class="info">Showing ' + from + "\u2013" + to + " of " + total + "</span>" +
            '<span class="pages">' +
            '<button type="button" data-page="' + (page - 1) + '"' + (page === 1 ? " disabled" : "") + ' aria-label="Previous page">&lsaquo;</button>';
        const start = Math.max(1, Math.min(page - Math.floor(PAGE_BUTTONS / 2), pages - PAGE_BUTTONS + 1));
        const end = Math.min(pages, start + PAGE_BUTTONS - 1);
        const numBtn = (n) => '<button type="button" data-page="' + n + '"' +
            (n === page ? ' class="on" aria-current="page"' : "") + ' aria-label="Page ' + n + '">' + n + "</button>";
        const gap = '<button type="button" disabled aria-hidden="true">&hellip;</button>';
        if (start > 1) html += numBtn(1) + (start > 2 ? gap : "");
        for (let n = start; n <= end; n++) html += numBtn(n);
        if (end < pages) html += (end < pages - 1 ? gap : "") + numBtn(pages);
        html += '<button type="button" data-page="' + (page + 1) + '"' + (page === pages ? " disabled" : "") + ' aria-label="Next page">&rsaquo;</button></span>';
        el.Pager.innerHTML = html;
        el.Pager.hidden = false;
    }

    // ---- events ----
    el.Pager.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-page]");
        if (!b || b.disabled) return;
        load(Number(b.dataset.page));
        $(p + "Title").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const runSearch = debounce(() => { term = el.Search.value.trim(); load(1); }, DEBOUNCE_MS);
    el.Search.addEventListener("input", () => { el.Clear.hidden = !el.Search.value; runSearch(); });
    el.Search.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && el.Search.value) { e.preventDefault(); el.Clear.click(); }
    });
    el.Clear.addEventListener("click", () => {
        el.Search.value = "";
        el.Clear.hidden = true;
        term = "";
        load(1);
        el.Search.focus();
    });
    el.Filter.addEventListener("change", () => { filter = el.Filter.value; load(1); });

    // ---- export CSV (this list, with its current period + search + filter) ----
    function syncExport() { el.Export.disabled = total === 0; }

    async function exportCsv() {
        if (el.Export.disabled) return;
        el.Export.disabled = true;
        exportLbl.textContent = "Exporting\u2026";
        try {
            const all = [];
            let pg = 1, count = Infinity;
            while (all.length < count && pg <= EXPORT_MAX_PAGES) {
                const { data, error } = await fetchPage(pg, EXPORT_CHUNK);
                if (error) throw error;
                const chunk = (data && data.rows) || [];
                count = num(data && data.total);
                all.push(...chunk);
                if (!chunk.length) break;
                pg++;
            }
            if (!all.length) { toast("Nothing to export for this selection."); return; }

            let header, lines;
            if (isTx) {
                header = ["Date & time", "Transaction ID", "Student", "Student ID", "Items", "Payment method", "Amount (PHP)", "Confirmed by (cashier)"];
                lines = all.map((r) => [csvWhen(r.created_at), r.id, r.student_name, r.student_no, itemsText(r.items), methodLabel(r.method), num(r.amount).toFixed(2), r.cashier_name]);
            } else {
                header = ["Requested", "Refund ID", "Student", "Student ID", "Items", "Amount (PHP)", "Status", "Decided by (cashier)", "Decided at"];
                lines = all.map((r) => [csvWhen(r.created_at), r.id, r.student_name, r.student_no, itemsText(r.items), num(r.amount).toFixed(2),
                STATUS_LABEL[String(r.status || "").toLowerCase()] || cap(r.status), r.decided_by_name, csvWhen(r.decided_at)]);
            }
            const csv = "\ufeff" + [header, ...lines].map((row) => row.map(csvCell).join(",")).join("\r\n");
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
            const a = document.createElement("a");
            const d = new Date();
            const stamp = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
            a.href = url;
            a.download = "tapmate-" + (isTx ? "transactions" : "refunds") + "-" + range + "-" + stamp + ".csv";
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast("Exported " + all.length + (all.length === 1 ? " row." : " rows."));
        } catch (err) {
            toast("Export failed: " + friendlyError(err), true);
        } finally {
            exportLbl.textContent = "Export CSV";
            syncExport();
        }
    }
    el.Export.addEventListener("click", exportCsv);

    fillFilter();
    syncExport();
    return { load, setMethods };
}

const txTable = makeTable("tx");
const rfTable = makeTable("rf");

// ============================================================
// 11. START
// ============================================================
(async function start() {
    if (!(await requireAdmin())) {
        window.location.replace(LOGIN_PAGE); // not signed in as an admin
        return;
    }
    loadSummary();
    txTable.load(1);
    rfTable.load(1);
})();
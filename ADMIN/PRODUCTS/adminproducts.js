// ============================================================
// 1. SUPABASE SETUP (same project as the account management page)
//    Never put the service_role key in front-end code.
// ============================================================
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

const PRODUCTS = "products";       // see tapmate_products.sql
const CATEGORIES = "categories";
const BUCKET = "product-images";   // public Storage bucket for product photos


const LOGIN_PAGE = "../../LOGIN/login.html"; // same folder depth as the account management page

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
const PAGE_SIZE = 5;             // products per page
const PAGE_BUTTONS = 5;          // page numbers shown at once: 1 2 3 4 5
const DEBOUNCE_MS = 180;
const IMAGE_MAX_PX = 800;          // photos are resized to fit this before upload
const IMAGE_MAX_INPUT_MB = 10;     // reject absurdly large originals
const MAX_ALLERGENS = 12;
const PRESET_ALLERGENS = ["Milk", "Eggs", "Fish", "Shellfish", "Peanuts", "Tree nuts", "Wheat (gluten)", "Soy", "Sesame"];
const KIND_LABEL = { food: "Food", beverage: "Beverage" };
const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const COLUMNS = "id, name, description, price, allergens, image_url, image_path, status, stock, category_id, category:categories(id, name, kind)";
const MAX_STOCK = 1000000;
const HIST_SIZE = 5;
const DEFAULT_THRESHOLD = 5;

// ============================================================
// 3. ELEMENTS
// ============================================================
const $ = (id) => document.getElementById(id);
const appEl = $("app"), collapseBtn = $("collapseBtn"), menuBtn = $("menuBtn"), scrim = $("scrim");
const searchInput = $("searchInput"), clearSearch = $("clearSearch");
const searchBox = $("searchBox"), suggestEl = $("suggestions");
const rowsEl = $("rows"), emptyEl = $("emptyState"), resultsTitle = $("resultsTitle"), resultsCount = $("resultsCount");
const bannerEl = $("banner"), toastEl = $("toast"), pagerEl = $("pager");
const catPills = $("catPills"), pillSlider = $("pillSlider");
const archiveViewBtn = $("archiveViewBtn"), addBtn = $("addBtn"), catBtn = $("catBtn");

const dialog = $("productDialog"), form = $("productForm"), dialogTitle = $("dialogTitle");
const fName = $("fName"), fCategory = $("fCategory"), fPrice = $("fPrice");
const fAllergenCustom = $("fAllergenCustom"), allergenPicks = $("allergenPicks"), catHint = $("catHint");
const imgPreview = $("imgPreview"), imgFile = $("imgFile"), imgPick = $("imgPick"), imgRemove = $("imgRemove");
const formError = $("formError"), saveBtn = $("saveBtn");
const fNoAllergens = $("fNoAllergens"), fStock = $("fStock"), stockField = $("stockField");
const statusFilterEl = $("statusFilter"), thrBtn = $("thrBtn"), thrNow = $("thrNow");
const tabEdit = $("tabEdit"), tabInv = $("tabInv"), editView = $("editView"), invView = $("invView");
const invQty = $("invQty"), invBadge = $("invBadge"), invRestocked = $("invRestocked"), invUpdated = $("invUpdated"), invForm = $("invForm"), invInput = $("invInput"), invSave = $("invSave"), invError = $("invError"), invMinus = $("invMinus"), invPlus = $("invPlus");
const histList = $("histList"), histEmpty = $("histEmpty"), histPager = $("histPager");
const thrDialog = $("thrDialog"), thrForm = $("thrForm"), thrInput = $("thrInput"), thrError = $("thrError"), thrSave = $("thrSave");

const catDialog = $("catDialog"), catList = $("catList"), catName = $("catName"), catKind = $("catKind");
const catError = $("catError"), catAddBtn = $("catAddBtn");

const confirmDialog = $("confirmDialog"), cfTitle = $("cfTitle"), cfText = $("cfText"), cfYes = $("cfYes"), cfNo = $("cfNo");

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
function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function cleanTerm(q) { return q.replace(/[,()%_*\\]/g, " ").replace(/\s+/g, " ").trim(); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function uid() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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
    if (err.code === "23505") {
        if (/categor/i.test(msg)) return "A category with that name already exists.";
        return "A product with that name already exists.";
    }
    if (err.code === "23503") return "That category is still used by products. Move or delete those products first.";
    if (err.code === "42501" || /row-level security|permission denied/i.test(msg)) return "You don't have permission to do that. Please sign in again.";
    if (/Stock can only be changed/i.test(msg)) return "Stock can only be changed with the Adjust stock button, so it is logged.";
    if (/column .*stock|stock_adjust|stock_movements|stock_settings/i.test(msg) && /exist|find|schema/i.test(msg)) return "Stock & Inventory is not set up yet. Run stockinventory.sql in Supabase.";
    if (/Bucket not found/i.test(msg)) return "The image bucket isn't set up yet. Run tapmate_products.sql in Supabase.";
    return err.message || "Something went wrong. Please try again.";
}

// ============================================================
// 5. SIDEBAR (identical behaviour to the account management page)
// ============================================================
const COLLAPSE_KEY = "tapmate.admin.sidebarCollapsed";
const isMobile = () => window.matchMedia("(max-width: 860px)").matches;

function setCollapsed(collapsed) {
    appEl.classList.toggle("collapsed", collapsed);
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (_) { /* ignore */ }
    setTimeout(moveSlider, 320);
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
// 6. STATE + CONFIRM PROMPT
// ============================================================
let categories = [];
let catFilter = "";        // category id, "" = every product
let archivedView = false;
let currentTerm = "";
let currentPage = 1;
let currentRows = [];
let tableSeq = 0;
let editing = null;
let threshold = DEFAULT_THRESHOLD;   // low-stock level (from stock_settings)
let statusFilter = "";               // "", ok, low, out

function confirmAction({ title, html, yes = "Continue", danger = false }) {
    return new Promise((resolve) => {
        cfTitle.textContent = title;
        cfText.innerHTML = html;
        cfYes.textContent = yes;
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

// Stock status is derived (never stored): 0 = Sold out, <= threshold = Low stock, otherwise Available.
function stockStatus(n) { n = Number(n) || 0; return n <= 0 ? "out" : n <= threshold ? "low" : "ok"; }
const STATUS_LABEL = { ok: "Available", low: "Low stock", out: "Sold out" };
function statusBadge(n) { const k = stockStatus(n); return '<span class="badge st-' + k + '">' + STATUS_LABEL[k] + "</span>"; }

// ============================================================
// 7. CATEGORIES (data, filter pills, select box)
// ============================================================
async function loadCategories() {
    const [cats, prods] = await Promise.all([
        db.from(CATEGORIES).select("id, name, kind")
            .order("kind", { ascending: true }).order("name", { ascending: true }),
        db.from(PRODUCTS).select("category_id, status").not("category_id", "is", null).limit(5000)
    ]);
    if (cats.error) throw cats.error;
    const tally = {};
    ((prods && prods.data) || []).forEach((p) => {
        const t = tally[p.category_id] || (tally[p.category_id] = { active: 0, archived: 0 });
        t[p.status === "archived" ? "archived" : "active"]++;
    });
    categories = (cats.data || []).map((c) => {
        const t = tally[c.id] || { active: 0, archived: 0 };
        return { id: c.id, name: c.name, kind: c.kind, active: t.active, archived: t.archived, count: t.active + t.archived };
    });
    if (catFilter && !categories.some((c) => c.id === catFilter)) catFilter = "";
    renderPills();
    fillCategorySelect(fCategory.value);
    renderCatList();
}

function renderPills() {
    catPills.querySelectorAll(".pill").forEach((p) => p.remove());
    catPills.hidden = !categories.length;
    categories.forEach((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pill" + (c.id === catFilter ? " on" : "");
        b.dataset.cat = c.id;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(c.id === catFilter));
        b.textContent = c.name;
        catPills.appendChild(b);
    });
    moveSlider();
}

catPills.addEventListener("click", (e) => {
    const b = e.target.closest(".pill");
    if (!b) return;
    // clicking the active category again clears the filter and shows every product
    setCategoryFilter(b.dataset.cat === catFilter ? "" : b.dataset.cat);
});

function setCategoryFilter(id, reload = true) {
    catFilter = id;
    catPills.querySelectorAll(".pill").forEach((p) => {
        const on = p.dataset.cat === id;
        p.classList.toggle("on", on);
        p.setAttribute("aria-selected", String(on));
    });
    moveSlider();
    if (reload) loadTable(searchInput.value.trim(), 1);
}

function moveSlider() {
    const b = catPills.querySelector(".pill.on");
    if (!b) { pillSlider.style.width = "0px"; return; }
    if (!b.offsetWidth) return;
    pillSlider.style.width = b.offsetWidth + "px";
    pillSlider.style.transform = "translateX(" + b.offsetLeft + "px)";
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
}
requestAnimationFrame(() => { moveSlider(); pillSlider.classList.add("ready"); });
window.addEventListener("resize", moveSlider);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSlider);

function fillCategorySelect(selected) {
    fCategory.innerHTML = '<option value="">Select a category</option>';
    ["food", "beverage"].forEach((kind) => {
        const list = categories.filter((c) => c.kind === kind);
        if (!list.length) return;
        const g = document.createElement("optgroup");
        g.label = KIND_LABEL[kind];
        list.forEach((c) => {
            const o = document.createElement("option");
            o.value = c.id; o.textContent = c.name;
            g.appendChild(o);
        });
        fCategory.appendChild(g);
    });
    if (selected && categories.some((c) => c.id === selected)) fCategory.value = selected;
    catHint.textContent = categories.length ? "" : "No categories yet. Create one under Categories first.";
}

// ============================================================
// 8. PRODUCT TABLE (search, filter, pagination)
// ============================================================
async function fetchProducts(term, page) {
    let q = db.from(PRODUCTS).select(COLUMNS, { count: "exact" });
    q = archivedView ? q.eq("status", "archived") : q.neq("status", "archived");
    if (catFilter) q = q.eq("category_id", catFilter);
    if (statusFilter === "out") q = q.eq("stock", 0);
    else if (statusFilter === "low") q = q.gt("stock", 0).lte("stock", threshold);
    else if (statusFilter === "ok") q = q.gt("stock", threshold);
    const t = cleanTerm(term);
    if (t) q = q.or(`name.ilike.%${t}%,description.ilike.%${t}%`).order("name", { ascending: true });
    else q = q.order("created_at", { ascending: false });
    const from = (page - 1) * PAGE_SIZE;
    const { data, error, count } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    return { rows: data || [], count: count ?? (data || []).length };
}

async function loadTable(term = "", page = 1) {
    const seq = ++tableSeq;
    currentTerm = term; currentPage = page;
    showBanner("");
    try {
        const { rows, count } = await fetchProducts(term, page);
        if (seq !== tableSeq) return;
        if (!rows.length && count > 0 && page > 1) return loadTable(term, Math.ceil(count / PAGE_SIZE));
        renderTable(rows, term, count);
    } catch (err) {
        if (seq === tableSeq) showBanner("Could not load products: " + (err.message || err));
    }
}

function tableTitle() {
    if (archivedView) return "Archived products";
    const c = categories.find((x) => x.id === catFilter);
    return c ? c.name : "All products";
}

function renderTable(list, term = "", total = list.length) {
    currentRows = list;
    resultsTitle.textContent = tableTitle();
    resultsCount.textContent = total + (total === 1 ? " product" : " products");
    rowsEl.innerHTML = "";
    renderPager(total);

    if (!list.length) {
        emptyEl.hidden = false;
        emptyEl.textContent = archivedView
            ? "No archived products" + (term ? " match your search." : " yet.")
            : term ? "No products found. Try another name, or add a new product."
                : statusFilter ? "No products match this stock level."
                    : catFilter ? "No products in this category yet."
                        : 'No products yet. Click "New product" to add the first one.';
        return;
    }
    emptyEl.hidden = true;

    const t = cleanTerm(term);
    list.forEach((p) => {
        const archived = p.status === "archived";
        const tr = document.createElement("tr");
        tr.dataset.id = p.id;
        const st = stockStatus(p.stock);
        tr.className = (archived ? "archived " : "") + (archived ? "" : st === "out" ? "row-out" : st === "low" ? "row-low" : "");
        const tags = Array.isArray(p.allergens) ? p.allergens : [];
        const tagHtml = tags.length
            ? '<div class="tags">' + tags.slice(0, 3).map((x) => '<span class="tag">' + escapeHtml(x) + "</span>").join("") +
            (tags.length > 3 ? '<span class="tag more">+' + (tags.length - 3) + "</span>" : "") + "</div>"
            : '<span class="dash">&mdash;</span>';
        const cat = p.category
            ? '<span class="badge ' + escapeHtml(p.category.kind) + '">' + escapeHtml(p.category.name) + "</span>"
            : '<span class="badge warn">Uncategorised</span>';
        tr.innerHTML =
            '<td><span class="thumb">' + (p.image_url ? '<img src="' + escapeHtml(p.image_url) + '" alt="" loading="lazy">' : "") + "</span></td>" +
            '<td><div class="p-name">' + highlight(p.name, t) + "</div>" +
            (p.description ? '<div class="p-desc" title="' + escapeHtml(p.description) + '">' + highlight(p.description, t) + "</div>" : "") + "</td>" +
            "<td>" + cat + "</td>" +
            '<td class="price">' + peso.format(Number(p.price || 0)) + "</td>" +
            "<td>" + tagHtml + "</td>" +
            '<td class="right"><span class="stock-num st-' + st + '">' + Number(p.stock || 0) + "</span></td>" +
            "<td>" + statusBadge(p.stock) + "</td>" +
            '<td class="right"><span class="row-actions">' +
            (archived
                ? '<button class="btn ghost small" data-act="unarchive" type="button">Unarchive</button>'
                : '<button class="btn ghost small icon-only inv-btn" data-act="inventory" type="button" title="Inventory" aria-label="Open inventory">' + INVENTORY_ICON + "</button>" +
                '<button class="btn ghost small" data-act="edit" type="button">Edit</button>' +
                '<button class="btn ghost small icon-only" data-act="archive" type="button" title="Archive product" aria-label="Archive product">' + ARCHIVE_ICON + "</button>") +
            "</span></td>";
        const img = tr.querySelector("img");
        if (img) img.addEventListener("error", () => img.remove());
        rowsEl.appendChild(tr);
    });
}

const INVENTORY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';
const ARCHIVE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/></svg>';

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

// search
const runSearch = debounce(() => loadTable(searchInput.value.trim(), 1), DEBOUNCE_MS);
searchInput.addEventListener("input", () => {
    clearSearch.hidden = !searchInput.value;
    runSearch();
    scheduleSuggest();
});
clearSearch.addEventListener("click", () => {
    searchInput.value = ""; clearSearch.hidden = true;
    closeSuggest();
    loadTable("", 1); searchInput.focus();
});

// ---- YouTube-style autocomplete under the search box ----
// Suggests matching product names as you type (best matches first). Arrow keys move,
// Enter or a click picks one, Esc closes. The table still filters live as before.
const SUGGEST_MAX = 6, SUGGEST_MS = 120;
let sgItems = [], sgActive = -1, sgSeq = 0, sgTerm = "", sgTimer = 0;

function closeSuggest() {
    clearTimeout(sgTimer); sgSeq++;
    sgItems = []; sgActive = -1;
    suggestEl.hidden = true; suggestEl.innerHTML = "";
    searchBox.classList.remove("open");
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
}
function setSuggestActive(i) {
    sgActive = i;
    suggestEl.querySelectorAll(".sg-item").forEach((el, k) => {
        const on = k === i;
        el.classList.toggle("active", on);
        el.setAttribute("aria-selected", String(on));
        if (on) el.scrollIntoView({ block: "nearest" });
    });
    if (i >= 0) searchInput.setAttribute("aria-activedescendant", "sg-" + i);
    else searchInput.removeAttribute("aria-activedescendant");
}
function renderSuggest() {
    if (!sgItems.length) {
        suggestEl.innerHTML = '<li class="sg-note" role="presentation">No products match &ldquo;' + escapeHtml(sgTerm) + "&rdquo;</li>";
    } else {
        suggestEl.innerHTML = sgItems.map((p, i) => {
            const avatar = p.image_url
                ? '<span class="sg-avatar has-img"><img src="' + escapeHtml(p.image_url) + '" alt="" loading="lazy"></span>'
                : '<span class="sg-avatar" aria-hidden="true">' + escapeHtml(initials(p.name)) + "</span>";
            const sub = (p.category ? p.category.name + " \u00B7 " : "") + peso.format(Number(p.price));
            return '<li class="sg-item" role="option" id="sg-' + i + '" data-i="' + i + '" aria-selected="false">' + avatar +
                '<span class="sg-body"><span class="sg-name">' + highlight(p.name, sgTerm) + '</span>' +
                '<span class="sg-id">' + escapeHtml(sub) + "</span></span></li>";
        }).join("");
    }
    sgActive = -1;
    suggestEl.hidden = false;
    searchBox.classList.add("open");
    searchInput.setAttribute("aria-expanded", "true");
}
async function fetchSuggestions(term) {
    let q = db.from(PRODUCTS).select("id, name, price, image_url, category:categories(name)").ilike("name", "%" + term + "%");
    q = archivedView ? q.eq("status", "archived") : q.neq("status", "archived");
    if (catFilter) q = q.eq("category_id", catFilter);
    const { data, error } = await q.order("name", { ascending: true }).limit(30);
    if (error) throw error;
    const t = term.toLowerCase();
    // names that start with the text first, then ones with a word that starts with it, then the rest
    const rank = (n) => { n = n.toLowerCase(); return n.startsWith(t) ? 0 : n.split(/\s+/).some((w) => w.startsWith(t)) ? 1 : 2; };
    return (data || []).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).slice(0, SUGGEST_MAX);
}
function scheduleSuggest() {
    clearTimeout(sgTimer);
    if (!cleanTerm(searchInput.value)) return closeSuggest();
    sgTimer = setTimeout(async () => {
        const term = cleanTerm(searchInput.value);
        if (!term) return closeSuggest();
        const seq = ++sgSeq;
        try {
            const rows = await fetchSuggestions(term);
            if (seq !== sgSeq || document.activeElement !== searchInput) return;
            sgItems = rows; sgTerm = term;
            renderSuggest();
        } catch (_) {
            if (seq === sgSeq) closeSuggest();
        }
    }, SUGGEST_MS);
}
function pickSuggest(i) {
    const p = sgItems[i];
    if (!p) return;
    searchInput.value = p.name;
    clearSearch.hidden = false;
    closeSuggest();
    loadTable(p.name, 1);
}
searchInput.addEventListener("keydown", (e) => {
    const open = !suggestEl.hidden && sgItems.length > 0;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) { if (cleanTerm(searchInput.value)) scheduleSuggest(); return; }
        e.preventDefault();
        const n = sgItems.length;
        setSuggestActive(e.key === "ArrowDown" ? (sgActive + 1) % n : (sgActive <= 0 ? n - 1 : sgActive - 1));
    } else if (e.key === "Enter") {
        if (open && sgActive >= 0) { e.preventDefault(); pickSuggest(sgActive); }
        else { closeSuggest(); loadTable(searchInput.value.trim(), 1); }
    } else if (e.key === "Escape") {
        if (!suggestEl.hidden) { e.preventDefault(); closeSuggest(); }
    }
});
searchInput.addEventListener("focus", scheduleSuggest);
searchBox.addEventListener("focusout", (e) => { if (!searchBox.contains(e.relatedTarget)) closeSuggest(); });
suggestEl.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input so the click lands
suggestEl.addEventListener("click", (e) => {
    const li = e.target.closest(".sg-item");
    if (li) pickSuggest(Number(li.dataset.i));
});
suggestEl.addEventListener("mousemove", (e) => {
    const li = e.target.closest(".sg-item");
    if (li && Number(li.dataset.i) !== sgActive) setSuggestActive(Number(li.dataset.i));
});

// archived view toggle
function setArchivedView(on, reload = true) {
    archivedView = on;
    archiveViewBtn.classList.toggle("on", on);
    archiveViewBtn.setAttribute("aria-pressed", String(on));
    $("archiveViewLbl").textContent = on ? "Back to products" : "Archived products";
    if (reload) loadTable(searchInput.value.trim(), 1);
}
archiveViewBtn.addEventListener("click", () => setArchivedView(!archivedView));
if (statusFilterEl) statusFilterEl.addEventListener("change", () => { statusFilter = statusFilterEl.value; loadTable(searchInput.value.trim(), 1); });

// row actions
rowsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const p = currentRows.find((x) => x.id === tr.dataset.id);
    if (!p) return;
    if (btn.dataset.act === "edit") openDialog(p);
    else if (btn.dataset.act === "inventory") openDialog(p, { tab: "inv" });
    else if (btn.dataset.act === "archive") setStatus(p, "archived");
    else if (btn.dataset.act === "unarchive") setStatus(p, "active");
});

async function setStatus(p, status) {
    const archiving = status === "archived";
    if (!archiving && !p.category_id) {
        toast("Choose a category to unarchive this product.");
        return openDialog(p, { unarchive: true });
    }
    const ok = await confirmAction({
        title: (archiving ? "Archive " : "Unarchive ") + p.name + "?",
        html: archiving
            ? "Archived products are hidden from the menu but kept on record. You can unarchive it anytime."
            : "This product will appear on the menu again.",
        yes: archiving ? "Archive" : "Unarchive",
        danger: archiving
    });
    if (!ok) return;
    const { error } = await db.from(PRODUCTS).update({ status }).eq("id", p.id);
    if (error) return toast(friendlyError(error), true);
    toast(archiving ? "Product archived" : "Product unarchived");
    await loadCategories().catch(() => { });
    loadTable(currentTerm, currentPage);
}

// ============================================================
// 9. PRODUCT DIALOG (name, category, price, description, allergens, image)
// ============================================================
let allergens = [];
let imageState = { url: null, path: null, blob: null, blobUrl: null, removed: false };

function normTag(s) { return s.replace(/\s+/g, " ").trim(); }
function hasTag(s) { return allergens.some((a) => a.toLowerCase() === s.toLowerCase()); }

// Shared allergen library: every custom tag used on ANY product (active or archived) is offered as a
// chip when creating or editing any product. It is read from the products themselves, so a tag stays
// available while at least one product uses it, and a typo disappears once the product is corrected.
let sharedTags = [];
const isPreset = (t) => PRESET_ALLERGENS.some((p) => p.toLowerCase() === t.toLowerCase());
function rememberTag(t) {
    if (!t || isPreset(t) || sharedTags.some((s) => s.toLowerCase() === t.toLowerCase())) return;
    sharedTags.push(t);
    sharedTags.sort((x, y) => x.localeCompare(y));
}
async function loadAllergenLibrary() {
    try {
        const { data, error } = await db.from(PRODUCTS).select("allergens").limit(5000);
        if (error) throw error;
        const found = [];
        (data || []).forEach((r) => (Array.isArray(r.allergens) ? r.allergens : []).forEach((t) => {
            t = normTag(String(t || ""));
            if (t && !isPreset(t) && !found.some((f) => f.toLowerCase() === t.toLowerCase())) found.push(t);
        }));
        // keep tags typed in the open dialog that are not saved yet
        allergens.forEach((t) => { if (!isPreset(t) && !found.some((f) => f.toLowerCase() === t.toLowerCase())) found.push(t); });
        sharedTags = found.sort((x, y) => x.localeCompare(y));
        if (dialog.open) renderAllergens();
    } catch (_) { /* the preset tags still work */ }
}

function renderAllergens() {
    allergenPicks.innerHTML = "";
    const chip = (name, custom) => {
        const on = hasTag(name);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip" + (on ? " on" : "");
        b.dataset.tag = name;
        if (custom) b.dataset.custom = "1";
        b.setAttribute("aria-pressed", String(on));
        b.textContent = name;
        allergenPicks.appendChild(b);
    };
    PRESET_ALLERGENS.forEach((name) => chip(name, false));
    const extra = sharedTags.slice();
    allergens.forEach((t) => { if (!isPreset(t) && !extra.some((s) => s.toLowerCase() === t.toLowerCase())) extra.push(t); });
    extra.sort((x, y) => x.localeCompare(y)).forEach((name) => chip(name, true));
}
allergenPicks.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b) return;
    const name = b.dataset.tag;
    if (hasTag(name)) allergens = allergens.filter((a) => a.toLowerCase() !== name.toLowerCase());
    else if (allergens.length >= MAX_ALLERGENS) return showFormError("You can add up to " + MAX_ALLERGENS + " allergen tags.");
    else { allergens.push(name); setNone(false); }
    showFormError("");
    renderAllergens();
});

function addCustomAllergen() {
    const v = normTag(fAllergenCustom.value);
    if (!v) return;
    if (!/^[A-Za-z][A-Za-z ()\/-]{0,23}$/.test(v)) return showFormError("Allergen tags can only contain letters, spaces, hyphens, slashes and brackets.");
    if (hasTag(v)) { fAllergenCustom.value = ""; return; }
    if (allergens.length >= MAX_ALLERGENS) return showFormError("You can add up to " + MAX_ALLERGENS + " allergen tags.");
    // reuse the preset's / shared tag's exact spelling if the admin typed one
    const known = PRESET_ALLERGENS.concat(sharedTags).find((p) => p.toLowerCase() === v.toLowerCase());
    const tag = known || cap(v);
    allergens.push(tag);
    rememberTag(tag);
    setNone(false);
    fAllergenCustom.value = "";
    showFormError("");
    renderAllergens();
}
$("allergenAdd").addEventListener("click", addCustomAllergen);

// "+ Add more": the custom-allergen box slides open only when asked for
const tagReveal = $("tagReveal"), allergenMore = $("allergenMore"), allergenMoreLbl = $("allergenMoreLbl");
function setTagAdd(open, animate = true, focus = false) {
    setReveal(tagReveal, open, animate);
    allergenMore.setAttribute("aria-expanded", String(open));
    allergenMore.querySelector(".am-plus").textContent = open ? "\u2212" : "+";
    allergenMoreLbl.textContent = open ? "Hide" : "Add more";
    if (open && focus) fAllergenCustom.focus();
}
allergenMore.addEventListener("click", () => setTagAdd(!tagReveal.classList.contains("open"), true, true));
fAllergenCustom.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addCustomAllergen(); }
});

let noAllergens = false;
function setNone(v) {
    noAllergens = v;
    fNoAllergens.checked = v;
    allergenPicks.classList.toggle("dim", v);
}
fNoAllergens.addEventListener("change", () => {
    if (fNoAllergens.checked) allergens = [];
    setNone(fNoAllergens.checked);
    showFormError("");
    renderAllergens();
});

function showFormError(msg) { formError.textContent = msg; formError.hidden = !msg; }

// ---- image ----
function setPreview(url) {
    imgPreview.innerHTML = "";
    imgPreview.classList.toggle("has", !!url);
    if (url) {
        const im = document.createElement("img");
        im.alt = ""; im.src = url;
        im.addEventListener("error", () => { im.remove(); imgPreview.classList.remove("has"); });
        imgPreview.appendChild(im);
    }
    imgRemove.hidden = !url;
    imgPick.textContent = url ? "Change image" : "Upload image";
}

function resetImageState(p) {
    if (imageState.blobUrl) URL.revokeObjectURL(imageState.blobUrl);
    imageState = { url: p ? p.image_url : null, path: p ? p.image_path : null, blob: null, blobUrl: null, removed: false };
    imgFile.value = "";
    setPreview(imageState.url);
}

function resizeToBlob(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, IMAGE_MAX_PX / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const ctx = c.getContext("2d");
            ctx.fillStyle = "#fff";            // flatten transparency so JPEG doesn't turn black
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(url);
            c.toBlob((b) => b ? resolve(b) : reject(new Error("Could not process that image.")), "image/jpeg", 0.85);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a readable image.")); };
        img.src = url;
    });
}

imgPick.addEventListener("click", () => imgFile.click());
imgFile.addEventListener("change", async () => {
    const f = imgFile.files && imgFile.files[0];
    if (!f) return;
    showFormError("");
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { imgFile.value = ""; return showFormError("Please choose a PNG, JPG or WebP image."); }
    if (f.size > IMAGE_MAX_INPUT_MB * 1024 * 1024) { imgFile.value = ""; return showFormError("That image is too large (max " + IMAGE_MAX_INPUT_MB + " MB)."); }
    try {
        const blob = await resizeToBlob(f);
        if (imageState.blobUrl) URL.revokeObjectURL(imageState.blobUrl);
        imageState.blob = blob;
        imageState.blobUrl = URL.createObjectURL(blob);
        imageState.removed = false;
        setPreview(imageState.blobUrl);
    } catch (err) {
        imgFile.value = "";
        showFormError(err.message);
    }
});
imgRemove.addEventListener("click", () => {
    if (imageState.blobUrl) URL.revokeObjectURL(imageState.blobUrl);
    imageState.blob = null; imageState.blobUrl = null;
    imageState.removed = true;
    imgFile.value = "";
    setPreview(null);
});

// ---- reveal category / price / allergens only once a name is typed ----
function setReveal(el, open, animate = true) {
    if (el.classList.contains("open") === open) return;
    if (!animate) el.classList.add("no-anim");
    el.classList.toggle("open", open);
    if (!animate) { void el.offsetWidth; el.classList.remove("no-anim"); }
}
const detailsWrap = $("detailsWrap");
function syncDetails(animate = true) { setReveal(detailsWrap, !!fName.value.trim(), animate); }
fName.addEventListener("input", () => syncDetails());

// ---- open / close ----
let unarchiveOnSave = false;
function openDialog(p = null, opts = {}) {
    editing = p;
    unarchiveOnSave = !!opts.unarchive;
    dialogTitle.textContent = unarchiveOnSave ? "Unarchive product" : p ? "Edit product" : "New product";
    saveBtn.textContent = unarchiveOnSave ? "Save and unarchive" : p ? "Save changes" : "Create product";
    showFormError("");
    form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    fName.value = p ? p.name : "";
    fPrice.value = p ? Number(p.price).toFixed(2) : "";
    allergens = p && Array.isArray(p.allergens) ? p.allergens.slice() : [];
    fAllergenCustom.value = "";
    setNone(!!p && allergens.length === 0); // an existing product with no tags was saved as "no known allergens"
    fStock.value = "";
    stockField.hidden = !!p;
    tabInv.disabled = !p; tabInv.title = p ? "" : "Save the product first, then manage its stock here";
    if (resizeAnim) resizeAnim.cancel();
    setTab("edit", false);
    fillCategorySelect(p ? p.category_id : (catFilter || ""));
    renderAllergens();
    resetImageState(p);
    syncDetails(false);   // existing product: show its fields at once; new product: they slide down after typing a name
    setTagAdd(false, false);
    dialog.showModal();
    if (p && opts.tab === "inv") setTab("inv", false); // inventory button: open straight on the Inventory tab (no animation on open)
    else fName.focus();
}
function closeDialog() { if (dialog.open) dialog.close(); }
dialog.addEventListener("close", () => { if (imageState.blobUrl) { URL.revokeObjectURL(imageState.blobUrl); imageState.blobUrl = null; } });
addBtn.addEventListener("click", () => {
    if (!categories.length) {
        toast("Create a category first, then add products to it.", true);
        return openCategories();
    }
    openDialog(null);
});
$("dlgClose").addEventListener("click", closeDialog);
$("cancelBtn").addEventListener("click", closeDialog);

// ---- save ----
function validate() {
    form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    const name = fName.value.replace(/\s+/g, " ").trim();
    if (!name) { fName.classList.add("invalid"); fName.focus(); return "Please enter a product name."; }
    if (!fCategory.value) { fCategory.classList.add("invalid"); fCategory.focus(); return "Please choose a category."; }
    const price = Number(fPrice.value);
    if (fPrice.value === "" || !isFinite(price) || price < 0 || price > 99999.99) {
        fPrice.classList.add("invalid"); fPrice.focus(); return "Please enter a valid price (0 to 99,999.99).";
    }
    if (price === 0) { fPrice.classList.add("invalid"); fPrice.focus(); return "A product's price must be greater than \u20B10."; }
    if (!editing && fStock.value !== "" && !(Number.isInteger(Number(fStock.value)) && Number(fStock.value) >= 0 && Number(fStock.value) <= MAX_STOCK)) {
        fStock.classList.add("invalid"); fStock.focus(); return "Opening stock must be a whole number (0 or more).";
    }
    if (!allergens.length && !noAllergens) {
        allergenPicks.scrollIntoView({ block: "center", behavior: "smooth" });
        return "Select at least one allergen tag, or tick \u201CNo known allergens\u201D.";
    }
    return "";
}

form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bad = validate();
    if (bad) return showFormError(bad);
    showFormError("");

    if (editing) {
        const changes = describeChanges();
        if (!changes.length && !imageState.blob && !imageState.removed && !unarchiveOnSave) return showFormError("Nothing has changed.");
        if (imageState.blob) changes.push("Product image: new photo");
        else if (imageState.removed) changes.push("Product image: removed");
        const ok = await confirmAction({
            title: "Save changes to " + editing.name + "?",
            html: changes.length ? "<ul class=\"cf-list\">" + changes.map((c) => "<li>" + c + "</li>").join("") + "</ul>" : "The product will be saved.",
            yes: "Save changes"
        });
        if (!ok) return;
    }

    saveBtn.disabled = true;
    const label = saveBtn.textContent;
    saveBtn.textContent = "Saving...";
    let uploadedPath = null;
    try {
        let image_url = editing ? editing.image_url : null;
        let image_path = editing ? editing.image_path : null;
        const oldPath = image_path;

        if (imageState.blob) {
            uploadedPath = "products/" + uid() + ".jpg";
            const up = await db.storage.from(BUCKET).upload(uploadedPath, imageState.blob, { contentType: "image/jpeg", cacheControl: "31536000", upsert: false });
            if (up.error) throw up.error;
            image_path = uploadedPath;
            image_url = db.storage.from(BUCKET).getPublicUrl(uploadedPath).data.publicUrl;
        } else if (imageState.removed) {
            image_url = null; image_path = null;
        }

        const payload = {
            name: fName.value.replace(/\s+/g, " ").trim(),
            category_id: fCategory.value,
            price: Math.round(Number(fPrice.value) * 100) / 100,
            allergens: allergens.slice(),
            image_url, image_path
        };
        if (unarchiveOnSave) payload.status = "active";
        const query = editing
            ? db.from(PRODUCTS).update(payload).eq("id", editing.id)
            : db.from(PRODUCTS).insert(payload);
        const { data, error } = await query.select(COLUMNS).single();
        if (error) throw error;

        // new product with opening stock: record it through the logged stock function
        let stockWarn = "";
        if (!editing && Number(fStock.value) > 0) {
            const r = await db.rpc("stock_adjust", { p_product_id: data.id, p_action: "add", p_qty: Math.floor(Number(fStock.value)), p_reason: "Initial stock" });
            if (r.error || !r.data || !r.data.ok) stockWarn = " (opening stock was not saved: " + stockMsg(r) + ")";
        }

        // the row is saved: drop the replaced / removed photo
        if (oldPath && oldPath !== image_path) db.storage.from(BUCKET).remove([oldPath]).catch(() => { });

        closeDialog();
        toast((unarchiveOnSave ? "Product unarchived" : editing ? "Product updated" : "Product created") + stockWarn, !!stockWarn);
        unarchiveOnSave = false;
        searchInput.value = ""; clearSearch.hidden = true; closeSuggest();
        if (archivedView) setArchivedView(false, false);
        if (catFilter && data.category_id !== catFilter) setCategoryFilter(data.category_id, false);
        await loadCategories().catch(() => { });
        loadAllergenLibrary();
        await loadTable("");
        const tr = rowsEl.querySelector('tr[data-id="' + data.id + '"]');
        if (tr) { tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash"); }
    } catch (err) {
        // the row wasn't saved, so don't leave an orphan photo behind
        if (uploadedPath) db.storage.from(BUCKET).remove([uploadedPath]).catch(() => { });
        showFormError(friendlyError(err));
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = label;
    }
});

// ============================================================
// STOCK & INVENTORY (inside the product dialog): the quantity, who updated it and when,
// and the recent history. Plain database logic only (see stockinventory.sql). No AI.
// ============================================================
const STOCK_REASON = {
    admin: "Only an admin can change stock.",
    invalid: "Enter a whole number from 0 to " + MAX_STOCK.toLocaleString() + ".",
    negative: "Stock can't go below 0.",
    too_large: "That is more than the system allows (" + MAX_STOCK.toLocaleString() + ").",
    no_change: "That is the same as the current stock.",
    not_found: "That product no longer exists."
};
function stockMsg(r) {
    if (r.error) return friendlyError(r.error);
    return STOCK_REASON[r.data && r.data.reason] || "That didn't work. Please try again.";
}
const signed = (n) => (n > 0 ? "+" : "") + n;
const fmtWhen = (iso) => new Date(iso).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const MOVE_COLS = "id, action, previous_stock, change, new_stock, reason, actor_name, actor_role, created_at";
function whoLabel(m) { return m.actor_name ? m.actor_name + (m.actor_role ? " (" + cap(m.actor_role) + ")" : "") : (m.actor_role ? cap(m.actor_role) : "System"); }
function moveLabel(m) { return m.action === "sale" ? "Sale" : m.change > 0 ? "Restocked" : "Reduced"; }

// ---- what changed in the product form (shown in the confirmation) ----
function describeChanges() {
    const e = editing, out = [];
    const name = fName.value.replace(/\s+/g, " ").trim();
    if (name !== e.name) out.push("Name: <b>" + escapeHtml(e.name) + "</b> &rarr; <b>" + escapeHtml(name) + "</b>");
    if (fCategory.value !== e.category_id) {
        const nw = categories.find((c) => c.id === fCategory.value);
        out.push("Category: <b>" + escapeHtml(e.category ? e.category.name : "none") + "</b> &rarr; <b>" + escapeHtml(nw ? nw.name : "none") + "</b>");
    }
    const price = Math.round(Number(fPrice.value) * 100) / 100;
    if (price !== Number(e.price)) out.push("Price: <b>" + peso.format(Number(e.price)) + "</b> &rarr; <b>" + peso.format(price) + "</b>");
    const key = (a) => a.map((x) => x.toLowerCase()).sort().join("|");
    const oldTags = Array.isArray(e.allergens) ? e.allergens : [];
    if (key(oldTags) !== key(allergens)) out.push("Allergens: <b>" + escapeHtml(oldTags.join(", ") || "none") + "</b> &rarr; <b>" + escapeHtml(allergens.join(", ") || "none") + "</b>");
    if (unarchiveOnSave) out.push("Status: archived &rarr; <b>active</b>");
    return out;
}

// ---- low-stock level ----
async function loadThreshold() {
    try {
        const { data, error } = await db.from("stock_settings").select("low_stock_threshold").limit(1).maybeSingle();
        if (!error && data) threshold = data.low_stock_threshold;
    } catch (_) { /* keep the default */ }
    if (thrNow) thrNow.textContent = threshold;
}
if (thrBtn) thrBtn.addEventListener("click", () => {
    thrInput.value = threshold; thrError.hidden = true;
    thrDialog.showModal(); thrInput.focus(); thrInput.select();
});
$("thrClose").addEventListener("click", () => thrDialog.close());
$("thrCancel").addEventListener("click", () => thrDialog.close());
thrForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = Number(thrInput.value);
    if (thrInput.value === "" || !Number.isInteger(v) || v < 0 || v > 100000) {
        thrError.textContent = "Enter a whole number from 0 to 100,000."; thrError.hidden = false; return;
    }
    if (v === threshold) return thrDialog.close();
    const ok = await confirmAction({
        title: "Change the low-stock level?",
        html: "Products will show <b>Low stock</b> at <b>" + v + "</b> or fewer (currently " + threshold + "). No stock quantities change.",
        yes: "Save level"
    });
    if (!ok) return;
    thrSave.disabled = true;
    try {
        const r = await db.rpc("stock_set_threshold", { p_value: v });
        if (r.error || !r.data || !r.data.ok) { thrError.textContent = stockMsg(r); thrError.hidden = false; return; }
        threshold = v; if (thrNow) thrNow.textContent = v;
        thrDialog.close();
        toast("Low-stock level saved");
        loadTable(currentTerm, currentPage);
    } finally { thrSave.disabled = false; }
});

// ---- tabs: pill with a sliding highlight ----
const pillTabs = $("pillTabs");
const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let resizeAnim = null;
function setTab(which, animate = true) {
    const inv = which === "inv";
    if (pillTabs.dataset.tab === (inv ? "inv" : "edit") && dialog.classList.contains("inv-mode") === inv) return; // already on that tab
    // 1) remember the dialog's current size, 2) switch the tab, 3) glide from the old size to the new one
    const from = dialog.open ? dialog.getBoundingClientRect() : null;
    editView.hidden = inv; invView.hidden = !inv;
    dialog.classList.toggle("inv-mode", inv);
    pillTabs.dataset.tab = inv ? "inv" : "edit";   // the pill highlight slides with CSS (percent-based, so it follows the resize)
    tabEdit.classList.toggle("on", !inv); tabInv.classList.toggle("on", inv);
    tabEdit.setAttribute("aria-selected", String(!inv)); tabInv.setAttribute("aria-selected", String(inv));
    const pane = inv ? invView : editView;
    pane.classList.remove("pane-in-r", "pane-in-l"); void pane.offsetWidth;
    if (animate && from && from.width && dialog.animate && !reduceMotion()) {
        pane.classList.add(inv ? "pane-in-r" : "pane-in-l");       // new panel slides in from the side it belongs to
        const to = dialog.getBoundingClientRect();
        if (resizeAnim) resizeAnim.cancel();
        resizeAnim = dialog.animate(
            [{ width: from.width + "px", height: from.height + "px" }, { width: to.width + "px", height: to.height + "px" }],
            { duration: 420, easing: "cubic-bezier(.4, 0, .2, 1)" });
        resizeAnim.onfinish = resizeAnim.oncancel = () => { resizeAnim = null; };
    }
    if (inv) loadInventory();
}
tabEdit.addEventListener("click", () => setTab("edit"));
tabInv.addEventListener("click", () => { if (!tabInv.disabled) setTab("inv"); });

// ---- inventory panel ----
let invStock = 0, invSeq = 0, histPage = 1;

function showInvError(msg) { invError.textContent = msg; invError.hidden = !msg; }
function invInputValue() {
    if (invInput.value === "") return null;
    const n = Number(invInput.value);
    return Number.isInteger(n) && n >= 0 && n <= MAX_STOCK ? n : NaN;
}
function syncInvSave() {
    const v = invInputValue();
    invSave.disabled = v === null || Number.isNaN(v) || v === invStock;
    showInvError(Number.isNaN(v) ? STOCK_REASON.invalid : "");
}
function paintStock(n) {
    invStock = n;
    invQty.textContent = n;
    invBadge.className = "badge st-" + stockStatus(n);
    invBadge.textContent = STATUS_LABEL[stockStatus(n)];
}
function paintWho(el, m) {
    el.innerHTML = m ? escapeHtml(fmtWhen(m.created_at)) + "<small>by " + escapeHtml(whoLabel(m)) + "</small>" : "&mdash;";
}
async function loadInventory() {
    if (!editing) return;
    const seq = ++invSeq, id = editing.id;
    paintStock(Number(editing.stock || 0));
    invInput.value = invStock; syncInvSave();
    histList.innerHTML = ""; histEmpty.hidden = true; histPager.hidden = true;
    paintWho(invRestocked, null); paintWho(invUpdated, null);
    try {
        const base = () => db.from("stock_movements").select(MOVE_COLS).eq("product_id", id).order("created_at", { ascending: false });
        const [cur, last, rest] = await Promise.all([
            db.from(PRODUCTS).select("stock").eq("id", id).single(),
            base().limit(1),
            base().gt("change", 0).neq("action", "sale").limit(1)
        ]);
        if (seq !== invSeq) return;
        if (cur.data) { editing.stock = Number(cur.data.stock || 0); paintStock(editing.stock); invInput.value = invStock; syncInvSave(); }
        paintWho(invUpdated, last.data && last.data[0]);
        paintWho(invRestocked, rest.data && rest.data[0]);
    } catch (_) { /* the numbers shown are the loaded ones */ }
    loadHistory(1);
}
async function loadHistory(page) {
    if (!editing) return;
    const seq = invSeq, id = editing.id;
    const from = (page - 1) * HIST_SIZE;
    const { data, error, count } = await db.from("stock_movements").select(MOVE_COLS, { count: "exact" })
        .eq("product_id", id).order("created_at", { ascending: false }).range(from, from + HIST_SIZE - 1);
    if (seq !== invSeq) return;
    if (error) { histEmpty.hidden = false; histEmpty.textContent = "Could not load history: " + friendlyError(error); return; }
    const total = count ?? (data || []).length;
    const pages = Math.max(1, Math.ceil(total / HIST_SIZE));
    if (page > pages) return loadHistory(pages);
    histPage = page;
    histList.innerHTML = "";
    (data || []).forEach((m) => {
        const li = document.createElement("li");
        li.innerHTML = '<b class="chg ' + (m.change < 0 ? "neg" : "pos") + '">' + signed(m.change) + "</b>" +
            '<span class="h-main"><span>' + escapeHtml(moveLabel(m)) + " &middot; now " + m.new_stock + "</span>" +
            "<small>" + escapeHtml(fmtWhen(m.created_at)) + " &middot; " + escapeHtml(whoLabel(m)) + "</small></span>";
        histList.appendChild(li);
    });
    histEmpty.hidden = total > 0;
    if (!total) histEmpty.textContent = "No stock changes recorded yet.";
    renderHistPager(pages);
}
// 1 2 3 4 5 ... with arrows; long lists collapse to 1 ... 4 5 6 ... 12
function renderHistPager(pages) {
    if (pages <= 1) { histPager.hidden = true; histPager.innerHTML = ""; return; }
    const nums = [];
    for (let p = 1; p <= pages; p++) if (pages <= 7 || p === 1 || p === pages || Math.abs(p - histPage) <= 1) nums.push(p);
    let h = '<button type="button" data-hp="' + (histPage - 1) + '"' + (histPage === 1 ? " disabled" : "") + ' aria-label="Newer">&lsaquo;</button>', prev = 0;
    nums.forEach((p) => {
        if (p - prev > 1) h += '<span class="gap" aria-hidden="true">&hellip;</span>';
        h += '<button type="button" data-hp="' + p + '"' + (p === histPage ? ' class="on" aria-current="page"' : "") + ">" + p + "</button>";
        prev = p;
    });
    h += '<button type="button" data-hp="' + (histPage + 1) + '"' + (histPage === pages ? " disabled" : "") + ' aria-label="Older">&rsaquo;</button>';
    histPager.innerHTML = h; histPager.hidden = false;
}
histPager.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-hp]");
    if (b && !b.disabled) loadHistory(Number(b.dataset.hp));
});

invMinus.addEventListener("click", () => { const v = invInputValue(); invInput.value = Math.max(0, (Number.isNaN(v) || v === null ? invStock : v) - 1); syncInvSave(); });
invPlus.addEventListener("click", () => { const v = invInputValue(); invInput.value = Math.min(MAX_STOCK, (Number.isNaN(v) || v === null ? invStock : v) + 1); syncInvSave(); });
invInput.addEventListener("input", syncInvSave);

invForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = invInputValue();
    if (v === null || Number.isNaN(v)) return showInvError(STOCK_REASON.invalid);
    if (v === invStock) return;
    invSave.disabled = true;
    try {
        const r = await db.rpc("stock_adjust", { p_product_id: editing.id, p_action: "adjust", p_qty: v, p_reason: null });
        if (r.error || !r.data || !r.data.ok) return showInvError(stockMsg(r));
        showInvError("");
        editing.stock = r.data.new;
        toast(editing.name + ": stock " + r.data.previous + " \u2192 " + r.data.new);
        loadInventory();
        const id = editing.id;
        loadTable(currentTerm, currentPage).then(() => {
            const tr = rowsEl.querySelector('tr[data-id="' + id + '"]');
            if (tr) { tr.classList.remove("flash"); void tr.offsetWidth; tr.classList.add("flash"); }
        });
    } finally { syncInvSave(); }
});

// ============================================================
// 10. CATEGORY MANAGER
// ============================================================
let editingCat = null;

function showCatError(msg) { catError.textContent = msg; catError.hidden = !msg; }

function renderCatList() {
    catList.innerHTML = "";
    if (!categories.length) {
        catList.innerHTML = '<li class="cat-empty">No categories yet. Add your first one above.</li>';
        return;
    }
    categories.forEach((c) => {
        const li = document.createElement("li");
        li.className = "cat-row";
        li.dataset.id = c.id;
        if (editingCat === c.id) {
            li.innerHTML =
                '<input type="text" maxlength="40" value="' + escapeHtml(c.name) + '" aria-label="Category name" data-f="name">' +
                '<select class="select" aria-label="Category type" data-f="kind">' +
                '<option value="food"' + (c.kind === "food" ? " selected" : "") + ">Food</option>" +
                '<option value="beverage"' + (c.kind === "beverage" ? " selected" : "") + ">Beverage</option></select>" +
                '<button type="button" class="btn primary small" data-cact="save">Save</button>' +
                '<button type="button" class="btn ghost small" data-cact="cancel">Cancel</button>';
        } else {
            li.innerHTML =
                '<span class="c-name">' + escapeHtml(c.name) + "</span>" +
                '<span class="badge ' + c.kind + '">' + KIND_LABEL[c.kind] + "</span>" +
                '<span class="c-count">' + c.count + (c.count === 1 ? " product" : " products") + "</span>" +
                '<button type="button" class="btn ghost small" data-cact="edit">Rename</button>' +
                '<button type="button" class="btn ghost small icon-only" data-cact="delete" title="Delete category" aria-label="Delete category">' +
                '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg></button>';
        }
        catList.appendChild(li);
    });
    const inp = catList.querySelector("input[data-f=name]");
    if (inp) { inp.focus(); inp.select(); }
}

function openCategories() {
    editingCat = null;
    showCatError("");
    catName.value = "";
    renderCatList();
    if (!catDialog.open) catDialog.showModal();
}
catBtn.addEventListener("click", openCategories);
$("catClose").addEventListener("click", () => catDialog.close());
catDialog.addEventListener("close", () => { editingCat = null; });

function validCatName(v) {
    if (!v) return "Please enter a category name.";
    if (!/^[A-Za-z0-9][A-Za-z0-9 &'()\/-]{0,39}$/.test(v)) return "Category names can only contain letters, numbers, spaces and & ' ( ) / -";
    return "";
}

$("catAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = catName.value.replace(/\s+/g, " ").trim();
    const bad = validCatName(name);
    if (bad) return showCatError(bad);
    showCatError("");
    catAddBtn.disabled = true;
    try {
        const { error } = await db.from(CATEGORIES).insert({ name, kind: catKind.value });
        if (error) throw error;
        catName.value = "";
        toast("Category added");
        await loadCategories();
        catName.focus();
    } catch (err) {
        showCatError(friendlyError(err));
    } finally {
        catAddBtn.disabled = false;
    }
});

catList.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-cact]");
    if (!b) return;
    const id = b.closest("li").dataset.id;
    const c = categories.find((x) => x.id === id);
    if (!c) return;
    showCatError("");

    if (b.dataset.cact === "edit") { editingCat = id; return renderCatList(); }
    if (b.dataset.cact === "cancel") { editingCat = null; return renderCatList(); }

    if (b.dataset.cact === "save") {
        const li = b.closest("li");
        const name = li.querySelector("[data-f=name]").value.replace(/\s+/g, " ").trim();
        const kind = li.querySelector("[data-f=kind]").value;
        const bad = validCatName(name);
        if (bad) return showCatError(bad);
        b.disabled = true;
        const { error } = await db.from(CATEGORIES).update({ name, kind }).eq("id", id);
        if (error) { b.disabled = false; return showCatError(friendlyError(error)); }
        editingCat = null;
        toast("Category updated");
        await loadCategories();
        loadTable(currentTerm, currentPage);
        return;
    }

    if (b.dataset.cact === "delete") {
        const note = c.count > 0
            ? "<b>" + c.count + (c.count === 1 ? " product is" : " products are") + " assigned to it</b> (" + c.active + " active, " + c.archived + " archived). " +
            "They will be kept, but their category will be cleared and show as &ldquo;Select a category&rdquo; until you assign a new one."
            : "This category has no products.";
        const ok = await confirmAction({
            title: "Delete " + c.name + "?",
            html: note + "<br><br>The category itself will be permanently removed.",
            yes: "Delete", danger: true
        });
        if (!ok) return;
        const { error } = await db.from(CATEGORIES).delete().eq("id", id);
        if (error) return showCatError(friendlyError(error));
        toast("Category deleted");
        await loadCategories();
        loadTable(currentTerm, currentPage);
    }
});

// ============================================================
// 11. START
// ============================================================
(async function start() {
    if (!(await requireAdmin())) {
        window.location.replace(LOGIN_PAGE); // not signed in as an admin
        return;
    }
    loadAllergenLibrary();
    await loadThreshold();
    try {
        await loadCategories();
    } catch (err) {
        showBanner("Could not load categories: " + (err.message || err) + " (Have you run tapmate_products.sql?)");
    }
    loadTable("");
})();
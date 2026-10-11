// Order tally + PIN entry on the phone.
//   1. The student can REMOVE items here while the camera scans.
//   2. When they tap their RFID card at the kiosk again, the kiosk switches this page to PIN entry (phase = "pin").
//   3. The PIN goes to the kiosk through Supabase; the kiosk checks it, pays, and sends the result back.
// Needs order_tally_PIN_phase.sql, order_tally_PINv2.sql and order_tally_PINv3.sql (run once each, in that order) next to the
// existing kiosk_phone_* functions (plus order_tally_PINv4.sql, which stops a cancelled PIN screen from coming back). Assets/tapmate logo.png and Assets/shopping-cart.png sit next to this file.
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

// After "Order paid" the phone goes back to the student's wallet page (path from THIS page: CASHIER/ORDER TALLY + PIN/).
const WALLET_URL = new URL("../../STUDENT/STUDENT WALLET/studentwallet.html", location.href).href;
const PAID_SCREEN_MS = 4000;   // how long "Order paid" stays on screen before redirecting

const code = new URLSearchParams(location.search).get("s");
const $ = (id) => document.getElementById(id);
let V = null, sig = "", ended = false;
let pay = null, choosing = null;   // pay = {payment, paylater, parent} from the kiosk; choosing = a pick waiting for the kiosk to confirm
let dismissedReq = null, dismissUntil = 0, pinReq = null;   // Cancel must stick: don't reopen the PIN screen for a request we closed
let mode = "browse", pin = "", sending = false, paid = false, PIN_LEN = 4, shownTotal = 0, submitDoneAt = 0;

async function rpc(name, args) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + name, {
        method: "POST",
        headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(args)
    });
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
}

function msg(text) { const m = $("msg"); m.textContent = text; m.classList.add("on"); }
function hideMsg() { $("msg").classList.remove("on"); }
function toast(t, ms = 3000) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove("on"), ms); }
function endSession() { if (paid) return; ended = true; $("pin").classList.remove("on"); msg("This session has ended. Tap your RFID card at the kiosk, then scan the new QR code."); }

{   // if the logo image is missing, fall back to the TAPMATE wordmark
    const img = document.getElementById("logo");
    img.addEventListener("error", () => img.parentElement.classList.add("noimg"));
    if (img.complete && img.naturalWidth === 0) img.parentElement.classList.add("noimg");
}

const money = (v) => ((V && V.currency) || "") + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- order tally ---------- */
function render() {
    if (!V) return;
    const s = JSON.stringify([V.student, V.items, V.total]);
    if (s === sig) return; sig = s;
    const items = V.items || [];
    $("who").textContent = V.student || "\u00a0";
    $("total").textContent = money(V.total || 0);
    const n = items.reduce((a, i) => a + i.qty, 0);
    $("count").textContent = n + (n === 1 ? " item" : " items");
    const list = $("list"); list.textContent = "";
    if (!items.length) {
        list.innerHTML = '<div class="empty"><img class="bigcart" src="Assets/shopping-cart.png" alt="" onerror="this.remove()"><b>Your order is empty</b>Place items in front of the kiosk camera and they will appear here.</div>';
        return;
    }
    for (const it of items) {
        const row = document.createElement("div"); row.className = "row";
        const top = document.createElement("div"); top.className = "top";
        const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = it.name;
        if (it.ai) { const a = document.createElement("span"); a.className = "ai"; a.textContent = "AI"; nm.appendChild(a); }
        const amt = document.createElement("div"); amt.className = "amt"; amt.textContent = money(it.price * it.qty);
        top.append(nm, amt);
        const unit = document.createElement("div"); unit.className = "unit"; unit.textContent = money(it.price) + " each";
        const ctl = document.createElement("div"); ctl.className = "ctl";
        const minus = document.createElement("button"); minus.className = "step"; minus.textContent = "\u2212"; minus.setAttribute("aria-label", "One less " + it.name);
        const q = document.createElement("div"); q.className = "qty"; q.textContent = it.qty;
        const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "Remove";
        minus.onclick = () => remove(it.pid, false, row);
        rm.onclick = () => remove(it.pid, true, row);
        ctl.append(minus, q, rm); row.append(top, unit, ctl); list.appendChild(row);
    }
}

async function remove(pid, all, row) {
    row.classList.add("wait");
    try {
        const d = await rpc("kiosk_phone_remove", { p_code: code, p_pid: String(pid), p_all: !!all });
        if (!d || !d.ok) { row.classList.remove("wait"); endSession(); return; }
    } catch (e) { row.classList.remove("wait"); toast("Could not remove that item. Try again."); return; }
    setTimeout(poll, 600); setTimeout(poll, 1500);   // the kiosk applies it within about a second
}

/* ---------- polling: the order + which screen the kiosk wants ---------- */
async function poll() {
    if (ended || paid) return;
    const t0 = Date.now();
    try {
        const [d, p] = await Promise.all([
            rpc("kiosk_phone_view", { p_code: code }),
            rpc("kiosk_phone_get_phase", { p_code: code }).catch(() => null)   // SQL not installed yet: the tally still works
        ]);
        if (!d || !d.ok) return endSession();
        V = d; hideMsg(); render();
        if (p && p.ok) { syncPay(p); onPhase(p, t0); }
    } catch (e) { /* network hiccup: keep the last view, try again */ }
}

function onPhase(p, t0) {
    if (sending) {                                    // waiting for the kiosk's answer to the PIN
        if (p.result && t0 >= submitDoneAt) onResult(p.result);
        return;
    }
    const dismissed = (p.req != null && p.req === dismissedReq) || Date.now() < dismissUntil;
    if (p.phase === "pin" && mode === "browse" && !dismissed) enterPin(p);
    else if (p.phase !== "pin" && mode === "pin") leavePin("PIN entry ended. Tap your RFID card at the kiosk to try again.");
}

/* ---------- payment method (RFID payment / Pay Later) ---------- */
const PL_MSG = {
    no_parent: ["Pay Later unavailable", "You are not eligible for pay later as you are currently not linked to a parent."],
    not_active: ["Pay Later not activated", "You cannot use Pay later feature as you have not activated this feature with your linked parent."]
};
const plBlocked = () => pay && (pay.paylater === "no_parent" || pay.paylater === "not_active");
function showPL() {
    const m = PL_MSG[pay.paylater];
    $("plTitle").textContent = m[0]; $("plText").textContent = m[1];
    $("plmsg").classList.add("on");
}
function paintSeg(method) {
    const seg = $("seg"); seg.classList.toggle("pl", method === "paylater");
    seg.querySelectorAll("button").forEach(b => {
        b.classList.toggle("on", b.dataset.m === method);
        b.classList.toggle("dim", b.dataset.m === "paylater" && plBlocked());
    });
}
function syncPay(p) {
    // The kiosk sends the method + eligibility (linked parent AND activated). Until it does, show RFID payment as the default.
    pay = { payment: p.payment || "rfid", paylater: p.payment ? p.paylater : "unknown", parent: p.parent_name };
    let shown = pay.payment;
    if (choosing) {
        if (Date.now() < choosing.until && choosing.method !== pay.payment) shown = choosing.method;   // optimistic until the kiosk confirms
        else {
            if (choosing.method !== pay.payment) {
                if (choosing.method === "paylater" && plBlocked()) showPL();                              // the kiosk refused: say why
                else toast("Couldn't switch to " + (choosing.method === "paylater" ? "Pay Later" : "RFID payment") + ". Try again.");
            }
            choosing = null;
        }
    }
    paintSeg(shown);
    $("paynote").textContent = plBlocked() ? "Pay Later needs a linked parent who has activated it." : "";
}
async function choose(m) {
    if (mode !== "browse") return;
    if (!pay) pay = { payment: "rfid", paylater: "unknown", parent: "" };
    if (m === "paylater" && plBlocked()) return showPL();
    if (m === pay.payment && !choosing) return;
    choosing = { method: m, until: Date.now() + 4000 }; paintSeg(m);
    try {
        const d = await rpc("kiosk_phone_choose_payment", { p_code: code, p_method: m });
        if (!d || !d.ok) { choosing = null; paintSeg(pay.payment); return toast("The kiosk isn't ready yet. Try again in a moment."); }
    } catch (e) { choosing = null; paintSeg(pay.payment); return toast("Could not change the payment method. Try again."); }
    setTimeout(poll, 700); setTimeout(poll, 1600); setTimeout(poll, 4200);
}
document.querySelectorAll("#seg button").forEach(b => b.onclick = () => choose(b.dataset.m));
$("plOk").onclick = () => $("plmsg").classList.remove("on");

/* ---------- PIN entry ---------- */
function buildPad() {
    const pad = $("pad"), keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Cancel", "0", "\u232b"];
    for (const k of keys) {
        const b = document.createElement("button"); b.textContent = k;
        if (k === "Cancel") { b.className = "txt"; b.onclick = cancelPin; }
        else if (k === "\u232b") { b.className = "txt"; b.style.fontSize = "26px"; b.setAttribute("aria-label", "Delete"); b.onclick = () => { if (!sending) { pin = pin.slice(0, -1); drawDots(); } }; }
        else b.onclick = () => press(k);
        pad.appendChild(b);
    }
}
function buildDots() { const d = $("dots"); d.textContent = ""; for (let i = 0; i < PIN_LEN; i++) d.appendChild(document.createElement("i")); }
function drawDots() { [...$("dots").children].forEach((e, i) => e.classList.toggle("f", i < pin.length)); }
function setMsg(t, info) { const m = $("pinMsg"); m.textContent = t || ""; m.className = "pmsg" + (info ? " info" : ""); }
function lockPad(on) { document.querySelectorAll("#pad button").forEach(b => b.disabled = on && b.textContent !== "Cancel"); }

function enterPin(p) {
    mode = "pin"; pin = ""; sending = false; pinReq = p.req != null ? p.req : null;
    PIN_LEN = Number(p.pin_len) || 4; shownTotal = Number(p.total) || 0;
    buildDots(); drawDots(); setMsg(""); lockPad(false);
    $("pinTotal").textContent = money(shownTotal);
    $("pinHow").textContent = p.payment === "paylater" ? "using Pay Later" : "using your RFID wallet";
    $("pin").classList.add("on"); $("pin").setAttribute("aria-hidden", "false");   // slides in over the tally
}
function leavePin(text) {
    mode = "browse"; pin = ""; sending = false; lockPad(false); drawDots();
    $("pin").classList.remove("on"); $("pin").setAttribute("aria-hidden", "true"); sig = "";
    if (text) toast(text, 5000);
    poll();
}
function press(k) {
    if (sending || pin.length >= PIN_LEN) return;
    pin += k; drawDots();
    if (pin.length === PIN_LEN) submit();
}
async function submit() {
    sending = true; submitDoneAt = Infinity; lockPad(true); setMsg("Checking your PIN\u2026", true);
    try {
        const d = await rpc("kiosk_phone_submit_pin", { p_code: code, p_pin: pin });
        pin = ""; submitDoneAt = Date.now();
        if (!d || !d.ok) { sending = false; drawDots(); lockPad(false); return leavePin("PIN entry ended. Tap your RFID card at the kiosk to try again."); }
    } catch (e) {
        sending = false; pin = ""; drawDots(); lockPad(false);
        setMsg("Can't reach the server. Try your PIN again.");
    }
}
function onResult(r) {
    sending = false;
    if (r.ok) {
        paid = true; $("pin").classList.remove("on");
        $("paidAmt").textContent = money(r.total);
        $("paidBal").textContent = r.method === "paylater" ? "Paid with Pay Later" : (r.new_balance != null ? "New balance " + money(r.new_balance) : "");
        $("paid").classList.add("on");
        setTimeout(() => { location.replace(WALLET_URL); }, PAID_SCREEN_MS);   // back to the student's wallet
        return;
    }
    if (r.reason === "bad_pin") {
        pin = ""; drawDots(); lockPad(false);
        const el = $("dots"); el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
        return setMsg(r.message || "Wrong PIN. Try again.");
    }
    leavePin(r.message || "The payment could not be completed.");
}
async function cancelPin() {
    if (sending) return;
    dismissedReq = pinReq; dismissUntil = Date.now() + 3000;      // set BEFORE closing, so the next poll can't reopen it
    leavePin("");
    try { await rpc("kiosk_phone_cancel_pin", { p_code: code }); } catch (e) { /* the kiosk times out on its own */ }
}

async function start() {
    if (!code) { msg("Scan the QR code on the kiosk to open this page."); return; }
    try {
        const d = await rpc("kiosk_phone_connect", { p_code: code });     // tells the kiosk this phone is here
        if (!d || !d.ok) return endSession();
    } catch (e) { msg("Can't reach the server. Retrying\u2026"); setTimeout(start, 2000); return; }
    buildPad(); buildDots();
    poll(); setInterval(poll, 800);
}
start();
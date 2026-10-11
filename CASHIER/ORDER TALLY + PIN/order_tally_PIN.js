// Order tally on the phone. The student can only REMOVE items here.
// Talks to Supabase through small functions (see order_tally_PIN.sql); the kiosk sends the order and applies removals.
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

const code = new URLSearchParams(location.search).get("s");
const $ = (id) => document.getElementById(id);
let V = null, sig = "", ended = false;

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
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove("on"), 3000); }
function endSession() { ended = true; msg("This session has ended. Tap your RFID card at the kiosk, then scan the new QR code."); }

const money = (v) => ((V && V.currency) || "") + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
        list.innerHTML = '<div class="empty"><b>Your order is empty</b>Place items in front of the kiosk camera and they will appear here.</div>';
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

async function poll() {
    if (ended) return;
    try {
        const d = await rpc("kiosk_phone_view", { p_code: code });
        if (!d || !d.ok) return endSession();
        V = d; hideMsg(); render();
    } catch (e) { /* network hiccup: keep the last view, try again */ }
}

async function start() {
    if (!code) { msg("Scan the QR code on the kiosk to open this page."); return; }
    try {
        const d = await rpc("kiosk_phone_connect", { p_code: code });     // tells the kiosk this phone is here
        if (!d || !d.ok) return endSession();
    } catch (e) { msg("Can't reach the server. Retrying\u2026"); setTimeout(start, 2000); return; }
    poll(); setInterval(poll, 1000);
}
start();
"""The page the student's phone opens after scanning the kiosk QR code. Self-contained on purpose: the kiosk's
network may have no internet, so there are no web fonts, CDNs or images. __PIN_LEN__ is filled in by phone.py."""

ENDED_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>TapMate</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#4E1019;
color:#F4E9EA;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;text-align:center;padding:32px}
h1{font-size:24px;margin:0 0 8px;color:#F1DFA0}p{margin:0;opacity:.85}</style></head>
<body><div><h1>This session has ended</h1><p>Tap your RFID card at the kiosk, then scan the new QR code.</p></div></body></html>"""

PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="color-scheme" content="light"><meta name="theme-color" content="#6D1A24">
<title>TapMate</title>
<style>
:root{--maroon:#6D1A24;--maroon-dk:#4E1019;--gold:#C9A227;--gold-lt:#F1DFA0;--ink:#2B1B1E;--muted:#8A7477;--line:#EADFDF;--soft:#FAF6F4;--bad:#B3261E;--ok:#1E6B3A;
--sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%}
body{font:16px/1.4 var(--sans);color:var(--ink);background:var(--soft);-webkit-text-size-adjust:100%;touch-action:manipulation;user-select:none;-webkit-user-select:none}
button{font:inherit;color:inherit;border:0;background:none;cursor:pointer;touch-action:manipulation}
#app{display:flex;flex-direction:column;height:100%;max-width:520px;margin:0 auto;background:#fff}
header{background:var(--maroon);color:#fff;padding:calc(14px + env(safe-area-inset-top)) 20px 16px}
header .brand{font-weight:800;letter-spacing:.14em;font-size:13px;color:var(--gold-lt)}
header .who{font-size:22px;font-weight:800;margin-top:2px}
header .bal{font-size:14px;opacity:.85;margin-top:2px}
main{flex:1;overflow-y:auto;padding:14px 16px 8px;-webkit-overflow-scrolling:touch}
.hint{color:var(--muted);font-size:14px;margin:2px 4px 12px}
.empty{text-align:center;color:var(--muted);padding:56px 24px}
.empty b{display:block;color:var(--maroon);font-size:18px;margin-bottom:6px}
.row{border:1px solid var(--line);border-radius:16px;padding:12px 14px;margin-bottom:10px;background:#fff;transition:opacity .15s}
.row.wait{opacity:.45;pointer-events:none}
.row .top{display:flex;gap:10px;align-items:baseline}
.row .nm{flex:1;font-weight:700;font-size:17px}
.row .ai{font-size:10px;font-weight:800;background:var(--maroon);color:var(--gold-lt);border-radius:6px;padding:1px 6px;margin-left:6px;vertical-align:2px}
.row .amt{font-weight:800;color:var(--maroon);font-size:17px;font-variant-numeric:tabular-nums}
.row .unit{color:var(--muted);font-size:13px;margin-top:1px}
.row .ctl{display:flex;align-items:center;gap:8px;margin-top:10px}
.step{width:44px;height:44px;border-radius:12px;background:#F3E8E8;color:var(--maroon);font-size:24px;font-weight:700;line-height:1}
.step:active{background:#EBDADB}
.qty{min-width:28px;text-align:center;font-weight:800;font-size:18px;font-variant-numeric:tabular-nums}
.rm{margin-left:auto;height:44px;padding:0 16px;border-radius:12px;color:var(--bad);font-weight:700;border:1px solid #F0CFCC}
.rm:active{background:#FBE4E4}
footer{padding:12px 16px calc(14px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#fff}
.tot{display:flex;justify-content:space-between;align-items:baseline;margin:0 4px 10px}
.tot span{color:var(--muted);font-weight:600}.tot b{font-size:30px;color:var(--maroon);font-variant-numeric:tabular-nums}
.pay{font-size:13px;color:var(--muted);margin:-6px 4px 10px}
.cta{width:100%;height:56px;border-radius:28px;background:var(--gold);color:var(--maroon-dk);font-weight:800;font-size:18px}
.cta:active{background:#B8941F}.cta:disabled{opacity:.4}
/* PIN sheet */
#pin{position:fixed;inset:0;background:var(--maroon-dk);color:#F4E9EA;display:none;flex-direction:column;align-items:center;padding:calc(28px + env(safe-area-inset-top)) 20px calc(20px + env(safe-area-inset-bottom))}
#pin.on{display:flex}
#pin h2{margin:0;font-size:26px;color:var(--gold-lt)}
#pin .for{margin-top:6px;opacity:.85}
#pin .for b{color:#fff;font-size:20px}
.dots{display:flex;gap:16px;margin:34px 0 10px;height:22px}
.dots i{width:18px;height:18px;border-radius:50%;border:2px solid var(--gold-lt);transition:background .1s,transform .1s}
.dots i.f{background:var(--gold);border-color:var(--gold);transform:scale(1.08)}
.dots.shake{animation:sh .35s}
@keyframes sh{20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-7px)}80%{transform:translateX(7px)}}
.msg{min-height:44px;text-align:center;font-weight:700;color:#FFB4B4;padding:0 10px}
.msg.info{color:var(--gold-lt)}
.pad{display:grid;grid-template-columns:repeat(3,84px);gap:14px;margin-top:auto}
.pad button{height:68px;border-radius:34px;background:rgba(255,255,255,.1);color:#fff;font-size:28px;font-weight:600}
.pad button:active{background:rgba(255,255,255,.28)}
.pad button.txt{font-size:16px;background:none;color:var(--gold-lt);font-weight:700}
.pad button:disabled{opacity:.4}
@media (max-height:640px){.pad button{height:56px}.dots{margin:18px 0 6px}}
/* result + ended */
.full{position:fixed;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;background:#fff}
.full.on{display:flex}
.full .tick{width:84px;height:84px;border-radius:50%;background:var(--ok);color:#fff;font-size:46px;line-height:84px;margin-bottom:18px}
.full h2{margin:0 0 6px;font-size:28px;color:var(--maroon)}
.full p{margin:4px 0;color:var(--muted)}
.full .big{font-size:36px;font-weight:800;color:var(--maroon);margin:8px 0}
#toast{position:fixed;left:16px;right:16px;bottom:calc(96px + env(safe-area-inset-bottom));max-width:488px;margin:0 auto;background:var(--maroon-dk);color:#fff;padding:12px 16px;border-radius:14px;font-weight:600;display:none;z-index:5}
#toast.on{display:block}
#net{position:fixed;top:0;left:0;right:0;background:var(--gold);color:var(--maroon-dk);text-align:center;font-size:13px;font-weight:700;padding:calc(4px + env(safe-area-inset-top)) 0 4px;display:none;z-index:6}
@media (prefers-reduced-motion:reduce){.dots.shake{animation:none}}
</style></head>
<body>
<div id="net">Reconnecting to the kiosk…</div>
<div id="app">
  <header><div class="brand">TAPMATE</div><div class="who" id="who">&nbsp;</div><div class="bal" id="bal"></div></header>
  <main id="list"></main>
  <footer>
    <div class="tot"><span>Total</span><b id="total">0.00</b></div>
    <div class="pay" id="pay"></div>
    <button class="cta" id="confirm" disabled>Confirm order</button>
  </footer>
</div>

<div id="pin">
  <h2>Enter your PIN</h2>
  <div class="for">to pay <b id="pinTotal"></b></div>
  <div class="dots" id="dots"></div>
  <div class="msg" id="pinMsg"></div>
  <div class="pad" id="pad"></div>
</div>

<div class="full" id="paid">
  <div class="tick">&#10003;</div><h2>Order paid</h2>
  <div class="big" id="paidAmt"></div>
  <p id="paidBal"></p><p>Your receipt is printing at the kiosk.</p>
</div>
<div class="full" id="ended"><h2>This session has ended</h2><p>Tap your RFID card at the kiosk, then scan the new QR code.</p></div>
<div id="toast"></div>

<script>
const T = location.pathname.split('/')[1], PIN_LEN = __PIN_LEN__;
const $ = id => document.getElementById(id);
let S = null, mode = 'browse', pin = '', sending = false, done = false, sig = '', holdSince = 0, shownTotal = 0;

const money = v => (S ? S.currency : '') + Number(v).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
function toast(t, ms = 3200) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), ms); }

async function api(kind, body) {
  const r = await fetch('/' + T + '/' + kind, body === undefined ? {cache: 'no-store'} :
    {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (r.status === 410) throw 'ended';
  let d = {}; try { d = await r.json(); } catch (e) {}
  return d;
}
function ended() { if (!done) $('ended').classList.add('on'); done = true; $('pin').classList.remove('on'); }

/* ---------- order list ---------- */
function render() {
  if (!S) return;
  const s = JSON.stringify([S.items, S.total, S.payment, S.busy, S.hold]);
  $('who').textContent = S.student || ''; $('bal').textContent = S.balance != null ? 'Wallet balance ' + money(S.balance) : '';
  $('total').textContent = money(S.total);
  $('pay').textContent = S.items.length ? 'Paying with ' + (S.payment === 'paylater' ? 'Pay Later' : 'your RFID wallet') : '';
  $('confirm').disabled = !S.items.length || S.busy || mode !== 'browse';
  $('confirm').textContent = S.items.length ? 'Confirm order \u00b7 ' + money(S.total) : 'Confirm order';
  if (s === sig) return; sig = s;
  const list = $('list'); list.textContent = '';
  if (!S.items.length) {
    list.innerHTML = '<div class="empty"><b>Your order is empty</b>Place items in front of the kiosk camera and they will appear here.</div>'; return;
  }
  const hint = document.createElement('div'); hint.className = 'hint';
  hint.textContent = 'Scanned something by mistake? Remove it here before you confirm.'; list.appendChild(hint);
  for (const it of S.items) {
    const row = document.createElement('div'); row.className = 'row';
    const top = document.createElement('div'); top.className = 'top';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = it.name;
    if (it.ai) { const a = document.createElement('span'); a.className = 'ai'; a.textContent = 'AI'; nm.appendChild(a); }
    const amt = document.createElement('div'); amt.className = 'amt'; amt.textContent = money(it.price * it.qty);
    top.append(nm, amt);
    const unit = document.createElement('div'); unit.className = 'unit'; unit.textContent = money(it.price) + ' each';
    const ctl = document.createElement('div'); ctl.className = 'ctl';
    const minus = document.createElement('button'); minus.className = 'step'; minus.textContent = '\u2212'; minus.setAttribute('aria-label', 'One less ' + it.name);
    const q = document.createElement('div'); q.className = 'qty'; q.textContent = it.qty;
    const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = 'Remove';
    minus.onclick = () => remove(it.pid, false, row); rm.onclick = () => remove(it.pid, true, row);
    ctl.append(minus, q, rm); row.append(top, unit, ctl); list.appendChild(row);
  }
}
async function remove(pid, all, row) {
  row.classList.add('wait');
  try {
    const d = await api('remove', {pid, all});
    if (!d.ok) { row.classList.remove('wait'); toast(d.message || 'Could not remove that item.'); }
  } catch (e) { return ended(); }
  setTimeout(poll, 250); setTimeout(poll, 900);
}

/* ---------- polling ---------- */
async function poll() {
  if (done) return;
  try {
    const d = await api('state');
    $('net').style.display = 'none';
    if (!d.ok) return;
    S = d;
    if (mode === 'pin' && !sending) {
      if (!S.hold && Date.now() - holdSince > 2500) leavePin('Confirmation timed out. Review your order and try again.');
      else if (Math.abs(S.total - shownTotal) > 0.004) { api('cancel_pin', {}).catch(() => {}); leavePin('The order changed. Review it and confirm again.'); }
    }
    render();
  } catch (e) { if (e === 'ended') ended(); else $('net').style.display = 'block'; }
}
setInterval(poll, 1000); poll();

/* ---------- PIN ---------- */
function buildPad() {
  const pad = $('pad'), keys = ['1','2','3','4','5','6','7','8','9','Cancel','0','\u232b'];
  for (const k of keys) {
    const b = document.createElement('button'); b.textContent = k;
    if (k === 'Cancel') { b.className = 'txt'; b.onclick = cancelPin; }
    else if (k === '\u232b') { b.className = 'txt'; b.style.fontSize = '26px'; b.setAttribute('aria-label', 'Delete'); b.onclick = () => { if (!sending) { pin = pin.slice(0, -1); drawDots(); } }; }
    else b.onclick = () => press(k);
    pad.appendChild(b);
  }
  const d = $('dots'); for (let i = 0; i < PIN_LEN; i++) d.appendChild(document.createElement('i'));
}
function drawDots() { [...$('dots').children].forEach((e, i) => e.classList.toggle('f', i < pin.length)); }
function setMsg(t, info) { const m = $('pinMsg'); m.textContent = t || ''; m.className = 'msg' + (info ? ' info' : ''); }
function lockPad(on) { document.querySelectorAll('#pad button').forEach(b => b.disabled = on && b.textContent !== 'Cancel'); }

$('confirm').onclick = async () => {
  if (!S || !S.items.length || sending) return;
  $('confirm').disabled = true;
  try {
    const d = await api('begin_pin', {});
    if (!d.ok) { toast(d.message || 'Could not start the confirmation.'); return render(); }
    mode = 'pin'; pin = ''; holdSince = Date.now(); shownTotal = d.total; drawDots(); setMsg('');
    $('pinTotal').textContent = money(d.total); $('pin').classList.add('on');
  } catch (e) { ended(); }
};
function press(k) {
  if (sending || pin.length >= PIN_LEN) return;
  pin += k; drawDots();
  if (pin.length === PIN_LEN) submit();
}
async function submit() {
  sending = true; lockPad(true); setMsg('Checking your PIN\u2026', true);
  try {
    const d = await api('pay', {pin, expect_total: shownTotal});
    sending = false;
    if (d.ok) {
      done = true; $('pin').classList.remove('on');
      $('paidAmt').textContent = money(d.total); $('paidBal').textContent = d.method === 'paylater' ? 'Paid with Pay Later' : 'New balance ' + money(d.new_balance);
      $('paid').classList.add('on'); return;
    }
    if (d.reason === 'bad_pin') {
      pin = ''; drawDots(); lockPad(false);
      const el = $('dots'); el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      setMsg(d.message || 'Wrong PIN. Try again.'); return;
    }
    leavePin(d.message || 'The payment could not be completed.');
  } catch (e) { sending = false; ended(); }
}
async function cancelPin() {
  if (sending) return;
  try { await api('cancel_pin', {}); } catch (e) { return ended(); }
  leavePin('');
}
function leavePin(text) {
  mode = 'browse'; pin = ''; sending = false; lockPad(false); drawDots(); $('pin').classList.remove('on'); sig = '';
  if (text) toast(text, 5000); poll();
}
buildPad();
</script></body></html>
"""
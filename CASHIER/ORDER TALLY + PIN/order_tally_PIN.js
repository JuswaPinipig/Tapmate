// Connection test only: tells the kiosk "this phone opened the page". Nothing else yet.
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";

const code = new URLSearchParams(location.search).get("s");
const statusEl = document.getElementById("status");
const show = (t) => { statusEl.textContent = t; };

async function connect() {
    if (!code) { show("Scan the QR code on the kiosk to open this page."); return; }
    try {
        const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/kiosk_phone_connect", {
            method: "POST",
            headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ p_code: code })
        });
        const d = await r.json();
        if (r.ok && d && d.ok) show("Connected to the kiosk \u2713");
        else show("This session has ended. Tap your RFID card at the kiosk, then scan the new QR code.");
    } catch (e) {
        show("Can't reach the server. Retrying\u2026");
        setTimeout(connect, 2000);
    }
}
connect();
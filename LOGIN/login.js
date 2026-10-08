// ------------------------------------------------------------
// 1. SUPABASE SETUP
//    Same project as the admin page. The publishable (anon) key is
//    meant to be public; the database functions in login.sql
//    are what protect the data.
// ------------------------------------------------------------
const SUPABASE_URL = "https://inoafkspgsxzxarzboqq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fNWXtU_dOeKnc34whEzvJQ_NVDJhK7z";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ------------------------------------------------------------
// 2. SETTINGS
// ------------------------------------------------------------
const PIN_LENGTH = 4;            // must match the 4-digit rule in login.sql
const MAX_GAP_MS = 80;           // USB readers type very fast; slower typing is a person
const MIN_LENGTH = 4;            // ignore very short accidental input
const RESET_AFTER = 3000;        // go back to "waiting" after a successful login
const NOTICE_RESET_AFTER = 6000; // error boxes stay longer so they can be read
const PIN_IDLE_MS = 15000;       // PIN screen fades back to "tap your card" after this long untouched
const EMAIL_IDLE_MS = 60000;     // email form fades back to "tap your card" after this long untouched
const EMAIL_RE = /^[^@\s]+@sjc\.edu\.ph$/i;   // school emails only
const FADE_MS = 350;             // should match the CSS opacity transition (.35s)
const COLLAPSE_MS = 500;         // should match the CSS transition (.45s)
const REDIRECT_DELAY_MS = 1400;  // how long the spinner shows before the next page opens
const SESSION_KEY = "tapmate_session";

// Where to go after login, per role (path from THIS page, login.html).
// Leave "" to stay on this page. If you land on a "not found" page, the
// folder name here doesn't match yours: open the admin page in your browser
// and copy its address.
const REDIRECTS = {
    student: "../STUDENT/STUDENT WALLET/studentwallet.html",
    cashier: "../CASHIER/REGISTER (KIOSK)/Register.html",
    admin: "../ADMIN/ACCOUNT MANAGEMENT/adminaccountmanagement.html"
};

// ------------------------------------------------------------
// 3. ELEMENTS + STATE
// ------------------------------------------------------------
const tapEl = document.getElementById("tap");
const subEl = document.getElementById("sub");
const messageEl = document.getElementById("message");
const detailEl = document.getElementById("detail");
const forgotEl = document.getElementById("forgotId");
const noticeEl = document.getElementById("notice");
const statusEl = document.getElementById("status");
const pinAreaEl = document.getElementById("pinArea");
const pinDotsEl = document.getElementById("pinDots");
const emailAreaEl = document.getElementById("emailArea");
const emailInputEl = document.getElementById("emailInput");
const rfidInputEl = document.getElementById("rfidInput");
const emailBtnEl = document.getElementById("emailBtn");

const SUB_TAP = "Tap your ID card on the reader.";
const SUB_EMAIL = "Sign in with your school email.";
const FORGOT_TEXT = "FORGOT YOUR ID?";
const BACK_TEXT = "BACK TO CARD TAP";

// waiting -> (card tapped) busy -> pin -> (PIN entered) busy -> done / waiting
// waiting -> email (form open) -> busy -> pin -> ...
let state = "waiting";
let view = "tap";             // which screen is showing: "tap" or "pin"
let viewTimer = null;
let currentUid = null;
let pin = "";
let buffer = "";
let lastKeyTime = 0;
let resetTimer = null;
let collapseTimer = null;
let idleTimer = null;

// ------------------------------------------------------------
// 4. KEYBOARD INPUT
//    A USB RFID reader acts like a keyboard: it "types" the card number
//    very fast and presses Enter. A person typing a PIN is much slower,
//    so keys that arrive faster than MAX_GAP_MS are never added to the PIN.
// ------------------------------------------------------------
document.addEventListener("keydown", (e) => {
    // Typing inside the email form is normal typing: leave it alone
    // (the form handles Enter itself; Esc closes it).
    if (e.target.closest && e.target.closest("#emailArea")) {
        if (e.key === "Escape") exitEmail();
        return;
    }

    const now = Date.now();
    const fast = now - lastKeyTime <= MAX_GAP_MS;
    if (!fast) buffer = "";
    lastKeyTime = now;

    if (e.key === "Enter") {
        if (buffer.length >= MIN_LENGTH) handleScan(buffer);
        buffer = "";
        // Stops the reader's Enter from "clicking" a focused button or link
        e.preventDefault();
        return;
    }

    if (state === "pin") {
        if (e.key === "Backspace") { backspace(); return; }
        if (e.key === "Escape") { exitPin(); return; }
    }

    if (e.key.length === 1) {
        buffer += e.key;
        if (state === "pin" && /^\d$/.test(e.key) && !fast) addDigit(e.key);
    }
});

// "Forgot your ID?" link: opens the email form (and becomes "Back to card tap")
forgotEl.addEventListener("click", (e) => {
    e.preventDefault();
    if (state === "busy" || state === "done") return;
    if (view === "email") exitEmail(); else openEmail();
});

emailAreaEl.addEventListener("submit", submitEmail);
[emailInputEl, rfidInputEl].forEach((el) => el.addEventListener("input", () => {
    armEmailIdle();
    hideMessage();
}));

// ------------------------------------------------------------
// 4b. EMAIL SIGN-IN (no card in hand)
//     School email + RFID number, checked on the server by
//     card_lookup_email() (see login_email.sql). On success the normal
//     PIN step follows, so the PIN stays as the second layer.
// ------------------------------------------------------------
function openEmail() {
    clearTimeout(idleTimer);
    currentUid = null;
    pin = "";
    buffer = "";
    clearStatusNow();
    clearEmailFields();
    state = "email";
    setView("email");
    armEmailIdle();
}

function exitEmail() {
    clearTimeout(idleTimer);
    clearEmailFields();
    state = "waiting";
    clearStatusNow();
    setView("tap");
}

function armEmailIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (state === "email") exitEmail(); }, EMAIL_IDLE_MS);
}

function clearEmailFields() {
    emailInputEl.value = "";
    rfidInputEl.value = "";
    emailBtnEl.disabled = false;
}

async function submitEmail(e) {
    e.preventDefault();
    if (state !== "email") return;

    const email = emailInputEl.value.trim();
    const rfid = rfidInputEl.value.trim();

    if (!email || !rfid) {
        return showMessage("Please fill in both fields.", "Enter your school email and your RFID number.");
    }
    if (!EMAIL_RE.test(email)) {
        return showMessage("Please use your school email.", "It ends with @sjc.edu.ph.");
    }

    state = "busy";
    clearTimeout(idleTimer);
    emailBtnEl.disabled = true;

    let res;
    try {
        const { data, error } = await db.rpc("card_lookup_email", { p_email: email, p_rfid: rfid });
        if (error) throw error;
        res = data;
    } catch (err) {
        console.error("card_lookup_email failed:", err);
        state = "email";
        emailBtnEl.disabled = false;
        armEmailIdle();
        return showMessage("Can't reach TapMate right now.", "Check the connection and try again.");
    }

    switch (res.status) {
        case "ok":
            if (!res.has_pin) {
                return failWithNotice("No PIN is set for this ID yet. Please reach out to an admin to set one.");
            }
            // Same hand-off as a card tap: the RFID number is the card's uid
            currentUid = rfid;
            clearEmailFields();
            clearStatusNow();
            return enterPin(res.name);
        case "locked": {
            const mins = Math.max(1, Math.ceil((res.retry_after_seconds || 0) / 60));
            return failWithNotice("Too many wrong attempts. Try again in " + mins +
                (mins === 1 ? " minute" : " minutes") + " or reach out to an admin.");
        }
        case "inactive":
            return failWithNotice("This account is inactive. Please reach out to an admin.");
        default: {
            // Same message whether the email or the number is wrong, on purpose
            state = "email";
            emailBtnEl.disabled = false;
            rfidInputEl.value = "";
            emailAreaEl.classList.remove("shake");
            void emailAreaEl.offsetWidth;
            emailAreaEl.classList.add("shake");
            rfidInputEl.focus();
            armEmailIdle();
            showMessage("Email or RFID number is incorrect.", "Check them and try again.");
        }
    }
}

// ------------------------------------------------------------
// 5. STEP 1: CARD TAPPED
// ------------------------------------------------------------
async function handleScan(uid) {
    if (state === "busy" || state === "done") return;

    // A new tap always starts over (also replaces a half-typed PIN or the email form)
    clearEmailFields();
    pin = "";
    currentUid = null;
    state = "busy";
    clearTimeout(idleTimer);
    clearStatusNow();
    renderDots();

    let res;
    try {
        const { data, error } = await db.rpc("card_lookup", { p_uid: uid });
        if (error) throw error;
        res = data;
    } catch (err) {
        console.error("card_lookup failed:", err);
        return failWithNotice("Can't reach TapMate right now. Please try again in a moment.");
    }

    if (res.status === "ok" && res.has_pin) {
        currentUid = uid;
        return enterPin(res.name);
    }
    if (res.status === "ok") {
        return failWithNotice("No PIN is set for this ID yet. Please reach out to an admin to set one.");
    }
    if (res.status === "inactive") {
        return failWithNotice("This account is inactive. Please reach out to an admin.");
    }

    // The card number is not shown on screen. To find it when you need to
    // assign a card, press F12 and open the Console tab.
    console.log("Unassigned card number:", uid);
    failWithNotice("This ID is not currently assigned please reach out to an admin to link your ID.");
}

// ------------------------------------------------------------
// 6. STEP 2: PIN
// ------------------------------------------------------------
function enterPin(name) {
    state = "pin";
    pin = "";
    setView("pin", name);
    renderDots();
    armIdle();
}

// Back to "tap your card" (idle timeout or Esc)
function exitPin() {
    clearTimeout(idleTimer);
    currentUid = null;
    pin = "";
    state = "waiting";
    clearStatusNow();
    setView("tap");
}

function addDigit(d) {
    if (state !== "pin" || pin.length >= PIN_LENGTH) return;
    pin += d;
    afterPinChange();
    if (pin.length === PIN_LENGTH) submitPin();
}

function backspace() {
    if (state !== "pin") return;
    pin = pin.slice(0, -1);
    afterPinChange();
}

function afterPinChange() {
    renderDots();
    armIdle();
    hideMessage();
}

function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (state === "pin") exitPin(); }, PIN_IDLE_MS);
}

function renderDots() {
    pinDotsEl.textContent = "";
    for (let i = 0; i < PIN_LENGTH; i++) {
        const dot = document.createElement("span");
        dot.className = "dot" + (i < pin.length ? " filled" : "");
        pinDotsEl.appendChild(dot);
    }
    pinDotsEl.setAttribute("aria-label", pin.length + " of " + PIN_LENGTH + " digits entered");
}

async function submitPin() {
    state = "busy";
    clearTimeout(idleTimer);

    let res;
    try {
        const { data, error } = await db.rpc("card_login", { p_uid: currentUid, p_pin: pin });
        if (error) throw error;
        res = data;
    } catch (err) {
        console.error("card_login failed:", err);
        pin = "";
        renderDots();
        state = "pin";
        armIdle();
        return showMessage("Can't reach TapMate right now.", "Check the connection and enter your PIN again.");
    }

    if (res.ok) return loginSuccess(res);

    switch (res.reason) {
        case "invalid": {
            pin = "";
            renderDots();
            shakeDots();
            state = "pin";
            armIdle();
            const left = res.attempts_left;
            showMessage("Incorrect PIN.", left + (left === 1 ? " attempt" : " attempts") + " left.");
            break;
        }
        case "locked": {
            const mins = Math.max(1, Math.ceil((res.retry_after_seconds || 0) / 60));
            failWithNotice("Too many wrong PINs. This ID is locked. Try again in " + mins +
                (mins === 1 ? " minute" : " minutes") + " or reach out to an admin.");
            break;
        }
        case "no_pin":
            failWithNotice("No PIN is set for this ID yet. Please reach out to an admin to set one.");
            break;
        case "inactive":
            failWithNotice("This account is inactive. Please reach out to an admin.");
            break;
        default:
            failWithNotice("This ID is not currently assigned please reach out to an admin to link your ID.");
    }
}

function loginSuccess(res) {
    const profile = res.profile;

    // Other pages can read this and call card_session(token) to confirm it.
    try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            token: res.token,
            expires_at: res.expires_at,
            profile
        }));
    } catch (_) { /* storage can be blocked; login still succeeded */ }

    state = "done";
    currentUid = null;
    pin = "";
    clearTimeout(idleTimer);
    setView("tap");

    const welcome = "Welcome, " + profile.full_name;
    const target = REDIRECTS[profile.role];

    if (target) {
        // Spinner instead of the RFID logo, then open the next page.
        // (No auto-reset: the page is about to change.)
        show("loading", welcome, "Redirecting\u2026", false);
        setTimeout(() => { window.location.href = target; }, REDIRECT_DELAY_MS);
    } else {
        const detail = profile.role === "student"
            ? "Student ID " + profile.student_id
            : profile.role.charAt(0).toUpperCase() + profile.role.slice(1) + " account";
        show("ok", welcome, detail);
    }
}

// ------------------------------------------------------------
// 7. STATUS AREA
// ------------------------------------------------------------
function show(tapState, message = "", detail = "", autoReset = true) {
    const isError = tapState === "err";

    clearTimeout(collapseTimer);
    clearTimeout(resetTimer);

    tapEl.className = "tap " + tapState;
    messageEl.textContent = message;
    detailEl.textContent = detail;

    // Error -> show the outlined box instead of the normal text
    noticeEl.hidden = !isError;
    messageEl.hidden = isError;
    detailEl.hidden = isError;

    statusEl.classList.add("open"); // panel smoothly grows

    if (autoReset) resetTimer = setTimeout(reset, isError ? NOTICE_RESET_AFTER : RESET_AFTER);
}

function failWithNotice(text) {
    clearTimeout(idleTimer);
    currentUid = null;
    pin = "";
    clearEmailFields();
    if (view !== "tap") setView("tap");
    state = "waiting";
    noticeEl.textContent = text;
    show("err");
}

// PIN-stage feedback: stays up until the next keypress, no auto reset
function showMessage(message, detail = "") {
    clearTimeout(collapseTimer);
    messageEl.textContent = message;
    detailEl.textContent = detail;
    messageEl.hidden = false;
    detailEl.hidden = false;
    noticeEl.hidden = true;
    statusEl.classList.add("open");
}

function hideMessage() {
    if (!messageEl.textContent) return;
    statusEl.classList.remove("open");
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
        messageEl.textContent = "";
        detailEl.textContent = "";
    }, COLLAPSE_MS);
}

function shakeDots() {
    pinDotsEl.classList.remove("shake");
    void pinDotsEl.offsetWidth; // restart the animation
    pinDotsEl.classList.add("shake");
}

// Fade between the screens: "tap", "pin" or "email"
function setView(mode, name = "") {
    view = mode;
    clearTimeout(viewTimer);
    const els = [tapEl, pinAreaEl, emailAreaEl, subEl];
    els.forEach((el) => { el.style.opacity = "0"; });

    viewTimer = setTimeout(() => {
        tapEl.hidden = mode !== "tap";
        pinAreaEl.hidden = mode !== "pin";
        emailAreaEl.hidden = mode !== "email";
        subEl.textContent = mode === "pin" ? "Welcome" + (name ? ", " + name : "")
            : mode === "email" ? SUB_EMAIL : SUB_TAP;
        subEl.classList.toggle("welcome", mode === "pin");
        forgotEl.textContent = mode === "email" ? BACK_TEXT : FORGOT_TEXT;
        void subEl.offsetWidth; // apply the swap, then fade the new screen in
        els.forEach((el) => { el.style.opacity = ""; });
        if (mode === "email") emailInputEl.focus({ preventScroll: true });
    }, FADE_MS);
}

function clearStatusNow() {
    clearTimeout(collapseTimer);
    clearTimeout(resetTimer);
    statusEl.classList.remove("open");
    messageEl.textContent = "";
    detailEl.textContent = "";
    messageEl.hidden = false;
    detailEl.hidden = false;
    noticeEl.hidden = true;
    tapEl.className = "tap waiting";
}

function reset() {
    state = "waiting";
    tapEl.className = "tap waiting";
    statusEl.classList.remove("open"); // panel smoothly shrinks back

    // Clear the content only after the collapse finishes,
    // so the text doesn't vanish mid-animation
    collapseTimer = setTimeout(() => {
        messageEl.textContent = "";
        detailEl.textContent = "";
        messageEl.hidden = false;
        detailEl.hidden = false;
        noticeEl.hidden = true;
    }, COLLAPSE_MS);
}

renderDots();
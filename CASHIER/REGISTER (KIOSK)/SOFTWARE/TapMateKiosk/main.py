"""TapMate Cashier Kiosk. Launched from the website via tapmate-kiosk://launch?token=..."""
import os, sys, time
from datetime import datetime
from urllib.parse import urlparse, parse_qs

from PySide6.QtCore import (Qt, QObject, QRunnable, QThreadPool, QTimer, Signal, QUrl, QEvent, QThread,
                            QPropertyAnimation, QEasingCurve)
from PySide6.QtGui import QPixmap, QPainter, QPainterPath, QKeySequence, QShortcut
from PySide6.QtNetwork import QLocalServer, QLocalSocket, QNetworkAccessManager, QNetworkRequest
from PySide6.QtWidgets import (QApplication, QWidget, QHBoxLayout, QVBoxLayout, QLabel, QPushButton, QFrame,
                               QScrollArea, QSizePolicy, QGridLayout, QMessageBox, QStackedWidget,
                               QGraphicsOpacityEffect)

import config, protocol, phone
from api import Api, ApiError
from vision import Vision
from phone import PhoneServer
from widgets import (PillToggle, ReceiptOverlay, PromptOverlay, ConfirmOverlay, GreetingScreen, PhoneCard, GatePanel, MAROON, MAROON_DK, GOLD, GOLD_LT, INK, MUTED, LINE, SOFT)

SERVER_NAME = "tapmate-kiosk-instance"
FADE_MS = 700             # welcome -> kiosk cross-fade
WELCOME_MS = 4500          # how long the "Good Morning <name>" screen stays before the camera turns on
norm = lambda s: "".join(ch for ch in (s or "").lower() if ch.isalnum())

STYLE = """
* { font-family: 'Segoe UI', 'Figtree', sans-serif; }
QWidget#root { background: #FFFFFF; }
QFrame#side { background: @MAROON; }
QFrame#side QLabel { color: #F4E9EA; }
QLabel#brand { font-size: 34px; font-weight: 800; color: @MAROON; letter-spacing: 1px; }
QLabel#sideHead { color: #D9B9BD; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
QLabel#sideStat { font-size: 12px; color: #F4E9EA; }
QLabel#avatar { background: @GOLD; color: @MAROON_DK; border-radius: 20px; font-size: 14px; font-weight: 800; }
QLabel#cashName { font-size: 14px; font-weight: 700; color: #FFFFFF; }
QLabel#cashRole { font-size: 11px; color: #D9B9BD; }
QLabel { color: @INK; }
QFrame#brandbar { background: transparent; }
QLabel#h2 { font-size: 20px; font-weight: 800; color: @MAROON; }
QLabel#muted, QLabel#unit { color: @MUTED; font-size: 12px; }
QLabel#pill { background: #FBF3D6; color: #6B5410; border: 1px solid @GOLD_LT; border-radius: 13px; padding: 5px 12px; font-size: 12px; font-weight: 600; }
QLabel#video { background: #14090B; border: 2px solid @GOLD_LT; border-radius: 18px; color: #D9B9BD; }
QFrame#strip { background: @SOFT; border: 1px solid @LINE; border-radius: 12px; }
QFrame#tally { background: @SOFT; border-left: 1px solid @LINE; }
QFrame#line { background: #FFFFFF; border: 1px solid @LINE; border-radius: 14px; }
QFrame#lineNew { background: #FFFBEA; border: 2px solid @GOLD; border-radius: 14px; }
QFrame#student { background: #FFFFFF; border: 1px solid @LINE; border-left: 5px solid @GOLD; border-radius: 12px; }
QLabel#stuName { font-size: 17px; font-weight: 800; color: @MAROON; }
QLabel#stuVal { font-size: 14px; font-weight: 700; }
QLabel#thumb { background: #F3E8E8; border-radius: 10px; color: @MAROON; font-size: 22px; font-weight: 800; }
QLabel#nm { font-size: 15px; font-weight: 700; }
QLabel#price { font-size: 12px; color: @MUTED; }
QLabel#amt { font-size: 16px; font-weight: 800; color: @MAROON; }
QLabel#ai { background: @MAROON; color: @GOLD_LT; border-radius: 7px; padding: 1px 7px; font-size: 10px; font-weight: 800; }
QLabel#qty { font-size: 15px; font-weight: 700; min-width: 24px; }
QPushButton { background: #F3E8E8; color: @MAROON; border: 0; border-radius: 9px; padding: 6px 12px; font-size: 15px; font-weight: 700; }
QPushButton:hover { background: #EBDADB; }
QPushButton#step { min-width: 28px; max-width: 28px; padding: 3px 0; }
QPushButton#rm { background: transparent; color: #B7A3A6; max-width: 26px; padding: 3px 0; }
QPushButton#rm:hover { color: #C0392B; }
QPushButton#ghost { background: transparent; border: 1px solid @LINE; color: @MUTED; font-size: 13px; font-weight: 600; }
QPushButton#ghost:hover { border-color: @MAROON; color: @MAROON; }
QLabel#totalL { font-size: 14px; color: @MUTED; font-weight: 600; }
QLabel#total { font-size: 34px; font-weight: 800; color: @MAROON; }
QScrollArea { border: 0; background: transparent; }
QScrollArea > QWidget > QWidget { background: transparent; }
QScrollBar:vertical { width: 8px; background: transparent; }
QScrollBar::handle:vertical { background: #DCCBCD; border-radius: 4px; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
"""
for _k, _v in {"@MAROON_DK": MAROON_DK, "@MAROON": MAROON, "@GOLD_LT": GOLD_LT, "@GOLD": GOLD,
               "@INK": INK, "@MUTED": MUTED, "@LINE": LINE, "@SOFT": SOFT}.items():
    STYLE = STYLE.replace(_k, _v)

BANNER = {"idle": ("#FBF3D6", "#6B5410"), "busy": ("#F3E8E8", "#6D1A24"),
          "ok": ("#E3F4E8", "#1E6B3A"), "err": ("#FBE4E4", "#8E1B1B")}

NO_PARENT_MSG = ("This student isn't linked to any parent, so the Pay Later feature isn't available "
                 "for this student.\n\nPlease link your student account to a parent account to continue "
                 "using this feature.")


def not_activated_msg(parent_name):
    who = parent_name or "a parent"
    return (f"This student is linked to {who} but has not activated Pay Later.\n\n"
            "Please ask your linked parent to activate this feature.")


REASONS = {
    "session": "Session expired. Reopen the kiosk from the Register page.",
    "empty": "The order is empty.",
    "unknown_card": "Card not recognised. Ask the student to register their card.",
    "inactive": "This student's account is not active.",
    "not_student": "This is not a student card.",
    "unavailable": "An item in this order is no longer available. Remove it and try again.",
    "paylater_off": "Pay Later is not active for this student.",
    "paylater_overdue": "Pay Later is overdue. Settle the balance first.",
}


# ---------- tiny async helper (network calls never block the camera/UI) ----------
class _Hub(QObject):
    done = Signal(object, object, object)
    def __init__(self):
        super().__init__(); self.done.connect(self._run)      # slot lives on the main thread -> callbacks run there
    def _run(self, cb, res, err):
        cb(res, err)

_hub = None

class _Task(QRunnable):
    def __init__(self, fn, cb):
        super().__init__(); self.fn, self.cb = fn, cb
    def run(self):
        try:
            _hub.done.emit(self.cb, self.fn(), None)
        except Exception as e:
            _hub.done.emit(self.cb, None, e)

def run_async(fn, cb):
    QThreadPool.globalInstance().start(_Task(fn, cb))


class ImageCache(QObject):
    loaded = Signal()
    def __init__(self):
        super().__init__(); self.nam = QNetworkAccessManager(self); self.cache = {}; self.asked = set()
        self.nam.setRedirectPolicy(QNetworkRequest.RedirectPolicy.NoLessSafeRedirectPolicy)
    def get(self, url, size=64):
        if not url:
            return None
        key = (url, size)
        if key in self.cache:
            return self.cache[key]
        if url not in self.asked:
            self.asked.add(url)
            rep = self.nam.get(QNetworkRequest(QUrl(url)))
            rep.finished.connect(lambda r=rep, u=url: self._done(r, u))
        return None
    def _done(self, rep, url):
        pm = QPixmap()
        if pm.loadFromData(rep.readAll()):
            self.cache[(url, 64)] = self.square(pm, 64); self.loaded.emit()
        rep.deleteLater()
    @staticmethod
    def square(pm, n):
        dpr = 2; px = n * dpr
        sc = pm.scaled(px, px, Qt.KeepAspectRatioByExpanding, Qt.SmoothTransformation)
        out = QPixmap(px, px); out.fill(Qt.transparent)
        p = QPainter(out); p.setRenderHint(QPainter.Antialiasing)
        path = QPainterPath(); path.addRoundedRect(0, 0, px, px, 10 * dpr, 10 * dpr); p.setClipPath(path)
        p.drawPixmap(-(sc.width() - px) // 2, -(sc.height() - px) // 2, sc); p.end()
        out.setDevicePixelRatio(dpr); return out


class SerialReader(QThread):
    card = Signal(str)
    def __init__(self, port, baud):
        super().__init__(); self.port, self.baud, self._run = port, baud, True
    def stop(self):
        self._run = False; self.wait(2000)
    def run(self):
        import serial
        try:
            with serial.Serial(self.port, self.baud, timeout=0.5) as s:
                while self._run:
                    line = s.readline().decode(errors="ignore").strip()
                    if line:
                        self.card.emit(line)
        except Exception:
            pass


def find_asset(name):
    base = config.app_dir()
    for rel in ("assets", "Assets", "../Assets", "../../Assets", "../../REGISTER (KIOSK)/Assets",
                "../REGISTER (KIOSK)/Assets", "REGISTER (KIOSK)/Assets"):
        path = os.path.normpath(os.path.join(base, rel, name))
        if os.path.isfile(path):
            return path
    fixed = os.path.join(r"C:\Users\Jp\Desktop\Tapmate\CASHIER\REGISTER (KIOSK)\Assets", name)   # your install location
    return fixed if os.path.isfile(fixed) else None

def find_logo():
    return find_asset("tapmate logo.png")

def empty_order(payment="rfid"):
    return {"ok": True, "version": -1, "payment": payment, "items": []}


class MainWindow(QWidget):
    def __init__(self, cfg):
        super().__init__()
        self.cfg, self.api, self.cur = cfg, Api(cfg), cfg["currency"]
        self.products, self.label_map = {}, {}
        self.order = empty_order()
        self.cashier, self.student = None, None
        self.state, self.session_uid, self._retired = "", None, []     # state: boot | idle | welcome | active | locked
        self.paying, self.pending, self.polling, self.locked = False, 0, False, False
        self.queued, self.flash, self._prev_qty = [], set(), {}
        self.confirming, self.confirm_left, self.tap_through = False, 0, False   # inactivity: 'still there?' prompt state
        self.vision = self.serial = None
        self.phone_gate = False                              # True = waiting for the phone to connect (camera + tally locked)
        self.phone, self.phone_hold = None, False          # phone link: server, and 'student is confirming with their PIN'
        self.images = ImageCache(); self.images.loaded.connect(self.render_order)
        self._buf, self._last = "", 0.0
        self.setObjectName("root"); self.setWindowTitle("TapMate Kiosk"); self.resize(1400, 840)
        self.banner_timer = QTimer(self); self.banner_timer.setSingleShot(True); self.banner_timer.timeout.connect(self.idle_banner)
        self.student_timer = QTimer(self); self.student_timer.setSingleShot(True); self.student_timer.timeout.connect(self.clear_student)
        self.idle_timer = QTimer(self); self.idle_timer.setSingleShot(True)
        self.idle_timer.setInterval(int(cfg["idle_seconds"] * 1000)); self.idle_timer.timeout.connect(self.ask_continue)
        self.confirm_tick = QTimer(self); self.confirm_tick.setInterval(1000); self.confirm_tick.timeout.connect(self.tick_confirm)
        self.hold_timer = QTimer(self); self.hold_timer.setSingleShot(True); self.hold_timer.timeout.connect(self._hold_expired)
        self.phone_tick = QTimer(self); self.phone_tick.setInterval(500); self.phone_tick.timeout.connect(self._phone_tick)
        self._build()
        self.receipt = ReceiptOverlay(self); self.receipt.closed.connect(self.on_receipt_closed)
        self.prompt = PromptOverlay(self); self.prompt.closed.connect(lambda: setattr(self, "tap_through", False))
        self.confirm = ConfirmOverlay(self)          # created last so it sits above every other overlay
        QApplication.instance().installEventFilter(self)
        QShortcut(QKeySequence("F11"), self, activated=self.toggle_full)
        self.poll = QTimer(self); self.poll.setInterval(1000); self.poll.timeout.connect(self.poll_order)
        self.start_phone()
        self.show_boot()

    # ---------- UI ----------
    def _build(self):
        outer = QVBoxLayout(self); outer.setContentsMargins(0, 0, 0, 0)
        self.stack = QStackedWidget(); outer.addWidget(self.stack)
        self.main_page = QWidget(); root = QHBoxLayout(self.main_page); root.setContentsMargins(0, 0, 0, 0); root.setSpacing(0)

        # no sidebar any more: these labels only hold state for the rest of the code and are never shown
        self.ai_state, self.rfid_state, self.avatar = QLabel(), QLabel(), QLabel()
        self.cash_name, self.cash_role = QLabel(), QLabel()

        # white content: camera
        content = QWidget(); cv = QVBoxLayout(content); cv.setContentsMargins(28, 24, 28, 24); cv.setSpacing(12)
        bar = QFrame(); bar.setObjectName("brandbar"); bl = QHBoxLayout(bar); bl.setContentsMargins(0, 0, 0, 0)
        blogo = QLabel(); lp2 = find_logo()
        if lp2: blogo.setPixmap(QPixmap(lp2).scaledToHeight(84, Qt.SmoothTransformation))
        else: blogo.setText("TAPMATE"); blogo.setObjectName("brand")
        bl.addWidget(blogo); bl.addStretch()
        self.sub = sub = QLabel(); sub.setObjectName("muted"); sub.setWordWrap(True)
        self.sub_ready = "Place items in the tray in front of the camera. Recognised items are added to your order automatically, and you can review and remove them on your phone."
        self.sub_gate = "Camera is off. Scan the QR code with your phone to activate the camera and open your order tally."
        sub.setText(self.sub_ready)
        self.video = QLabel("Camera off"); self.video.setObjectName("video")
        self.video.setAlignment(Qt.AlignCenter); self.video.setMinimumSize(560, 380)
        self.video.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Ignored)
        strip = QFrame(); strip.setObjectName("strip"); sl = QHBoxLayout(strip); sl.setContentsMargins(14, 10, 14, 10)
        self.last = QLabel("Waiting for the first item…"); self.last.setObjectName("muted"); sl.addWidget(self.last)
        cv.addWidget(bar); cv.addWidget(sub); cv.addWidget(self.video, 1); cv.addWidget(strip)
        root.addWidget(content, 1)

        # order tally
        panel = QFrame(); panel.setObjectName("tally"); panel.setFixedWidth(450)
        p = QVBoxLayout(panel); p.setContentsMargins(20, 22, 20, 20); p.setSpacing(10)
        self.student_box = QFrame(); self.student_box.setObjectName("student")
        sb = QVBoxLayout(self.student_box); sb.setContentsMargins(16, 12, 16, 12); sb.setSpacing(4)
        self.stu_name = QLabel(""); self.stu_name.setObjectName("stuName"); sb.addWidget(self.stu_name)
        def kv(k):
            r = QHBoxLayout(); a = QLabel(k); a.setObjectName("muted"); v = QLabel(""); v.setObjectName("stuVal")
            v.setAlignment(Qt.AlignRight); r.addWidget(a); r.addStretch(); r.addWidget(v); sb.addLayout(r); return v
        self.stu_bal = kv("RFID wallet balance")
        self.stu_lim = kv("Today's spending limit")
        self.student_box.hide()

        self.phone_card = PhoneCard(); self.phone_card.hide()
        p.addWidget(self.student_box); p.addWidget(self.phone_card)
        h = QHBoxLayout(); h2 = QLabel("Order tally"); h2.setObjectName("h2")
        self.count = QLabel("0 items"); self.count.setObjectName("pill")
        self.tally_box = QWidget(); tb = QVBoxLayout(self.tally_box); tb.setContentsMargins(0, 0, 0, 0); tb.setSpacing(10)
        self.tally_top = QWidget(); tt = QVBoxLayout(self.tally_top); tt.setContentsMargins(0, 0, 0, 0); tt.setSpacing(10)   # collapses once the phone has the tally
        h.addWidget(h2); h.addStretch(); h.addWidget(self.count); tt.addLayout(h)
        note = QLabel("Scanned items stay here until the cashier or the student removes them."); note.setObjectName("muted"); tt.addWidget(note)
        self.lines_host = QWidget(); self.lines = QVBoxLayout(self.lines_host)
        self.lines.setContentsMargins(0, 0, 4, 0); self.lines.setSpacing(8); self.lines.addStretch()
        sc = QScrollArea(); sc.setFocusPolicy(Qt.NoFocus); sc.setWidgetResizable(True); sc.setWidget(self.lines_host)
        self.empty = QWidget(); ev = QVBoxLayout(self.empty); ev.setContentsMargins(0, 0, 0, 90); ev.setSpacing(10)
        ev.addStretch()                                       # bottom margin above lifts the block a bit over the center
        cart_png = find_asset("shopping-cart.png")
        if cart_png:
            ic = QLabel(); ic.setAlignment(Qt.AlignCenter)
            pm = QPixmap(cart_png).scaledToHeight(56 * 2, Qt.SmoothTransformation); pm.setDevicePixelRatio(2)
            ic.setPixmap(pm); ev.addWidget(ic)
        et = QLabel("Cart is empty\nScan an item to start an order."); et.setObjectName("muted"); et.setAlignment(Qt.AlignCenter)
        ev.addWidget(et); ev.addStretch()
        area = QWidget(); ag = QGridLayout(area); ag.setContentsMargins(0, 0, 0, 0)
        ag.addWidget(sc, 0, 0); ag.addWidget(self.empty, 0, 0)                              # stacked in the same cell
        tt.addWidget(area, 1)
        tb.addWidget(self.tally_top, 1)

        # The RFID payment / Pay Later choice now lives on the student's phone (order_tally_PIN). This pill is no longer
        # shown; it only stays as a hidden holder so apply_order() can keep calling set_index() on it.
        self.pay_toggle = PillToggle(["RFID payment", "Pay Later"]); self.pay_toggle.changed.connect(self.on_pay_toggled)
        self.pay_toggle.setParent(self.tally_box); self.pay_toggle.hide()
        self.clear_btn = QPushButton("Clear order"); self.clear_btn.setObjectName("ghost")
        self.clear_btn.setFocusPolicy(Qt.NoFocus); self.clear_btn.clicked.connect(self.clear_order); tb.addWidget(self.clear_btn)
        tot = QHBoxLayout(); tl = QLabel("Total"); tl.setObjectName("totalL")
        self.total = QLabel(self.money(0)); self.total.setObjectName("total")
        tot.addWidget(tl); tot.addStretch(); tot.addWidget(self.total); tb.addLayout(tot)
        self.banner = QLabel(); self.banner.setAlignment(Qt.AlignCenter); self.banner.setWordWrap(True); self.banner.setMinimumHeight(64)
        tb.addWidget(self.banner); self.show_banner("Waiting for the cashier session…", "busy")
        p.addWidget(self.tally_box, 1)
        self.gate = GatePanel(); self.gate.hide(); p.addWidget(self.gate, 1)
        root.addWidget(panel)
        self.stack.addWidget(self.main_page)
        self.greet = GreetingScreen(find_logo()); self.stack.addWidget(self.greet); self.stack.setCurrentWidget(self.greet)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if hasattr(self, "receipt"): self.receipt.setGeometry(self.rect())
        if hasattr(self, "prompt"): self.prompt.setGeometry(self.rect())
        if hasattr(self, "confirm"): self.confirm.setGeometry(self.rect())

    def money(self, v):
        return f"{self.cur}{float(v):,.2f}"

    def show_banner(self, text, kind="idle", secs=0):
        bg, fg = BANNER[kind]
        self.banner.setText(text)
        self.banner.setStyleSheet(f"background:{bg}; color:{fg}; border-radius:14px; padding:10px; font-size:15px; font-weight:700;")
        self.banner_timer.stop()
        if secs: self.banner_timer.start(int(secs * 1000))

    def idle_banner(self):
        if self.locked or self.paying or self.state != "active": return
        if self.phone_hold: return self.show_banner("Enter your PIN on your phone to finalize your payment…", "busy")
        if self.order["items"] and self.phone and self.phone.connected() and hasattr(self.phone, "set_phase"):
            return self.show_banner("Tap your RFID to confirm your payment, and confirm your PIN directly through your phone to finalize.", "idle")
        method = "Pay Later" if self.order["payment"] == "paylater" else "RFID"
        self.show_banner(f"Tap the same RFID card again to pay ({method})" if self.order["items"] else "Waiting for items to scan…", "idle")

    def toggle_full(self):
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    # ---------- session / boot ----------
    def start_session(self, token):
        self.locked = False; self.api.token = token
        if not token:
            return self.lock("Open the kiosk from the Register page\n(Open Cashier kiosk button).")
        self.show_boot()
        self.show_banner("Signing in…", "busy")
        run_async(lambda: self.api.rpc("kiosk_whoami"), self.on_whoami)

    def on_whoami(self, res, err):
        if err: return self.lock(str(err))
        if not res.get("ok"): return self.lock("Session expired or not a cashier.\nLog in again and reopen the kiosk from the Register page.")
        self.cashier = res; self.cash_name.setText(res["name"]); self.cash_role.setText(str(res.get("role", "cashier")).title())
        self.avatar.setText("".join(w[0] for w in res["name"].split()[:2]).upper() or "?")
        run_async(self.api.products, self.on_products)

    def on_products(self, prods, err):
        if err: return self.lock(str(err))
        self.products = {p["id"]: p for p in prods}
        self.label_map = {norm(p["name"]): p["id"] for p in prods}
        for p in prods:                                    # an explicit yolo_label always wins over a name match
            if p.get("yolo_label"): self.label_map[norm(p["yolo_label"])] = p["id"]
        self.start_serial()
        self.poll.start(); self.poll_order(); self.go_idle()

    def start_serial(self):
        r = self.cfg["rfid"]
        if r.get("mode") == "serial" and self.serial is None:
            self.serial = SerialReader(r["serial_port"], r["baud"]); self.serial.card.connect(self.on_card); self.serial.start()

    def start_camera(self):
        if self.vision or self.phone_gate: return
        self.video.clear(); self.video.setText("Camera starting…")
        self.on_ai_status("Starting camera…", False)
        self.vision = Vision(self.cfg); self.vision.known = set(self.label_map)
        self.vision.frame.connect(self.on_frame); self.vision.detected.connect(self.on_detect)
        self.vision.status.connect(self.on_ai_status)
        self.vision.start()

    def stop_camera(self):
        v, self.vision = self.vision, None
        if v:
            for sig, slot in ((v.frame, self.on_frame), (v.detected, self.on_detect), (v.status, self.on_ai_status)):
                try: sig.disconnect(slot)
                except (RuntimeError, TypeError): pass
            v.stop()
            if v.isRunning(): self._retired.append(v)          # keep a reference until the thread really ends
        self._retired = [x for x in self._retired if x.isRunning()]
        self.video.clear(); self.video.setText("Camera off")
        self.ai_state.setText("   ● Camera off"); self.ai_state.setStyleSheet("color:#D9B9BD;")

    # ---------- screen flow: greeting -> tap -> welcome -> camera on -> scan -> tap again to pay -> greeting ----------
    def show_boot(self):
        was = self.state
        self.state = "boot"; self.stop_watch(); self.stop_camera(); self.phone_close(); self.student = self.session_uid = None; self.student_box.hide()
        self.stack.setCurrentWidget(self.greet)
        self.greet.show_idle(ready=False, replay=(was != "boot"))
        self.greet.set_status("Signing in…")

    def go_idle(self):
        was = self.state
        self.state = "idle"; self.stop_watch(); self.stop_camera(); self.phone_close(); self.queued = []
        if self.student and self.api.token:                  # tell the server this student is done (it uses this to vet Pay Later on the website)
            run_async(lambda: self.api.rpc("kiosk_end_student", _timeout=4), lambda r, e: None)
        self.student = self.session_uid = None; self.student_box.hide()
        self.stack.setCurrentWidget(self.greet)
        self.greet.show_idle(ready=True, replay=(was != "boot"))

    def welcome_text(self, s):
        return f"Welcome! {s['name']}!", ""

    def fade_to(self, page, ms=FADE_MS):
        """Cross-fade: snapshot the current screen, switch pages underneath, then fade the snapshot away."""
        old = self.stack.currentWidget()
        if old is page: return
        prev = getattr(self, "_xfade", None)
        if prev: prev[1].stop(); prev[0].deleteLater()
        ov = QLabel(self.stack); ov.setPixmap(old.grab()); ov.setGeometry(self.stack.rect())
        ov.setAttribute(Qt.WA_TransparentForMouseEvents)
        eff = QGraphicsOpacityEffect(ov); eff.setOpacity(1.0); ov.setGraphicsEffect(eff)
        self.stack.setCurrentWidget(page); ov.show(); ov.raise_()
        anim = QPropertyAnimation(eff, b"opacity", ov)
        anim.setDuration(ms); anim.setStartValue(1.0); anim.setEndValue(0.0); anim.setEasingCurve(QEasingCurve.InOutCubic)
        def done():
            ov.deleteLater()
            if getattr(self, "_xfade", None) and self._xfade[0] is ov: self._xfade = None
        anim.finished.connect(done); self._xfade = (ov, anim); anim.start()

    def enter_active(self):
        if self.state != "welcome" or self.locked: return
        self.state = "active"; self.idle_timer.start()
        self.set_gate(bool(self.phone and self.phone.token and phone.settings(self.cfg).get("required", True)))
        self.phone_card.setVisible(bool(self.phone and self.phone.token) and not self.phone_gate)
        self.last.setText("Waiting for your phone…" if self.phone_gate else "Waiting for the first item…")
        self.fade_to(self.main_page); self.idle_banner()
        # start the camera once the fade is nearly done, so loading it can't stutter the animation
        QTimer.singleShot(FADE_MS - 150, lambda: self.start_camera() if self.state == "active" and not self.locked else None)

    def lock(self, msg):
        self.locked = True; self.poll.stop(); self.state = "locked"; self.stop_watch(); self.stop_camera(); self.phone_close(); self.show_banner(msg, "err")
        self.stack.setCurrentWidget(self.greet)
        self.greet.show_idle(ready=False, replay=False); self.greet.set_status(msg, True)

    def end_session(self):
        if self.paying or self.locked or self.state != "active": return
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_clear_order"), self.after_mutation)
        self.go_idle()

    # ---------- inactivity: "still continuing?" -> tap -> continue, or expire ----------
    def touch(self):
        """Activity (a scan, a click, an order change, a card tap) restarts the inactivity clock."""
        if self.state == "active" and not self.confirming and not self.paying and not self.locked:
            self.idle_timer.start()

    def stop_watch(self):
        self.idle_timer.stop(); self.confirm_tick.stop(); self.confirming = False
        self.confirm.hide_now()

    def ask_continue(self):
        if self.state != "active" or self.locked: return
        if self.paying or self.phone_hold or self.receipt.isVisible() or self.prompt.isVisible():
            return self.idle_timer.start()                    # busy right now: look again later
        self.confirming = True; self.confirm_left = int(self.cfg["confirm_seconds"])
        self.confirm.show_confirm(self.confirm_left); self.confirm_tick.start()

    def tick_confirm(self):
        self.confirm_left -= 1
        if self.confirm_left <= 0:
            self.confirm_tick.stop(); self.expire_session()
        else:
            self.confirm.set_left(self.confirm_left)

    def continue_order(self):
        self.stop_watch(); self.idle_timer.start()
        self.show_banner("Thanks! Order continued. Tap the same card again to pay.", "ok", 4)

    def expire_session(self):
        """Only the student's RFID session ends. The cashier stays signed in, so the next tap works right away."""
        if self.state != "active" or self.paying: return self.stop_watch()
        self.stop_watch()
        self.end_session()                                    # clears the order (website follows) + back to the greeting screen
        self.tap_through = True
        self.prompt.show_prompt("Session expired",
                                "Please tap your RFID to log in to the kiosk and continue your order.", secs=20)

    def clear_on_close(self):
        """Closing the kiosk with an unpaid order wipes it, so the website tally isn't left with stale items."""
        if self.paying or not self.api.token: return
        self.poll.stop()
        QThreadPool.globalInstance().waitForDone(1500)        # let any add/remove already in flight land first
        try: self.api.rpc("kiosk_clear_order", _timeout=3)
        except ApiError: pass

    def on_ai_status(self, msg, is_err):
        if is_err: self.last.setText("⚠ " + msg)                  # camera / AI problems show under the video
        self.ai_state.setText(("   ⚠ " if is_err else "   ● ") + msg)
        self.ai_state.setStyleSheet("color:#FFB4B4;" if is_err else "color:#9FE6B8;")

    def on_frame(self, img):
        self.video.setPixmap(QPixmap.fromImage(img).scaled(self.video.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

    # ---------- the AI adds, only the cashier removes ----------
    def on_detect(self, label):
        if self.locked or self.state != "active" or self.confirming: return
        self.touch()
        if self.paying or self.phone_hold: self.queued.append(label); return       # added after the student finishes confirming
        pid = self.label_map.get(norm(label))
        if not pid:
            self.last.setText(f"Detected “{label}” – not linked to any product (set products.yolo_label)."); return
        self.last.setText(f"Camera added: {self.products[pid]['name']}")
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_add_item", p_product_id=pid, p_qty=1, p_ai=True), self.after_mutation)

    def flush_queue(self):
        q, self.queued = self.queued, []
        for lab in q: self.on_detect(lab)

    def change_qty(self, pid, delta):
        if self.paying or self.locked: return
        cur = next((i["qty"] for i in self.order["items"] if i["product_id"] == pid), 0)
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_set_qty", p_product_id=pid, p_qty=max(cur + delta, 0)), self.after_mutation)

    def clear_order(self):
        if self.paying or self.locked or not self.order["items"]: return
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_clear_order"), self.after_mutation)

    def paylater_state(self):
        """Returns (state, parent_name). state is one of:
        'ok'         linked to a parent AND Pay Later is activated
        'no_parent'  not linked to any parent
        'not_active' linked, but the parent hasn't activated Pay Later
        'unknown'    the server didn't say (older kiosk_card_info). The server still checks at payment time.
        kiosk_card_info should return parent_linked, parent_name and pay_later_enabled."""
        s = self.student or {}
        name = s.get("parent_name") or s.get("parent_full_name") or ""
        link_keys = [k for k in ("parent_linked", "has_parent", "parent_id", "parent_account_id") if k in s]
        if not link_keys:
            return "unknown", name
        if not any(bool(s.get(k)) for k in link_keys):
            return "no_parent", name
        for k in ("pay_later_enabled", "paylater_enabled", "pay_later_active"):
            if k in s:
                return ("ok" if s.get(k) else "not_active"), name
        return "ok", name

    def show_pay_later_block(self, state, name=""):
        if state == "no_parent":
            self.prompt.show_prompt("Pay Later unavailable", NO_PARENT_MSG)
        else:
            self.prompt.show_prompt("Pay Later not activated", not_activated_msg(name))

    def on_pay_toggled(self, idx):
        if self.paying or self.locked: return self.pay_toggle.set_index(0 if self.order["payment"] == "rfid" else 1)
        if idx == 1:
            st, name = self.paylater_state()
            if st in ("no_parent", "not_active"):
                self.pay_toggle.set_index(0); self.show_pay_later_block(st, name); return
        m = "paylater" if idx == 1 else "rfid"
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_set_payment", p_method=m), self.after_mutation)

    def after_mutation(self, res, err):
        self.pending = max(self.pending - 1, 0)
        if err:
            self.show_banner(str(err), "err", 4); return self.apply_order(self.order)
        if res and res.get("ok") is False and res.get("reason") in ("no_parent", "paylater_off"):
            st = "no_parent" if res["reason"] == "no_parent" else "not_active"
            self.show_pay_later_block(st, res.get("parent_name") or self.paylater_state()[1])
            return self.apply_order(self.order)          # snap the toggle back to what the order really uses
        self.apply_order(res)

    # ---------- shared order (website <-> kiosk) ----------
    def poll_order(self):
        if self.polling or self.pending or self.locked: return
        self.polling = True
        run_async(lambda: self.api.rpc("kiosk_get_order"), self.on_poll)

    def on_poll(self, res, err):
        self.polling = False
        if err or self.pending: return
        if res and res.get("ok") and res["version"] != self.order["version"]: self.apply_order(res)
        elif res and res.get("reason") == "session": self.lock("Session expired. Reopen the kiosk from the Register page.")

    def apply_order(self, res):
        if not res: return
        if res.get("reason") == "session": return self.lock("Session expired. Reopen the kiosk from the Register page.")
        if not res.get("ok"): return
        self.order = res; self.touch()                         # any change to the order (kiosk or website) is activity
        cur = {i["product_id"]: i["qty"] for i in res["items"]}
        new = {pid for pid, q in cur.items() if q > self._prev_qty.get(pid, 0)}
        self._prev_qty = cur
        if new and not self.receipt.isVisible():
            self.flash |= new; QTimer.singleShot(1400, self.unflash)
        self.pay_toggle.set_index(1 if res["payment"] == "paylater" else 0)
        self.render_order()
        if not self.banner_timer.isActive() and not self.receipt.isVisible(): self.idle_banner()

    def unflash(self):
        self.flash.clear(); self.render_order()

    def render_order(self):
        while self.lines.count() > 1:
            w = self.lines.takeAt(0).widget()
            if w: w.deleteLater()
        total = n = 0
        for it in self.order["items"]:
            p = self.products.get(it["product_id"])
            if not p: continue
            total += p["price"] * it["qty"]; n += it["qty"]
            self.lines.insertWidget(self.lines.count() - 1, self.line_widget(it, p))
        self.empty.setVisible(n == 0); self.clear_btn.setVisible(n > 0)
        self.count.setText(f"{n} item{'' if n == 1 else 's'}"); self.total.setText(self.money(total))

    def line_widget(self, it, p):
        w = QFrame(); w.setObjectName("lineNew" if it["product_id"] in self.flash else "line")
        h = QHBoxLayout(w); h.setContentsMargins(10, 10, 10, 10); h.setSpacing(12)
        th = QLabel(); th.setObjectName("thumb"); th.setFixedSize(64, 64); th.setAlignment(Qt.AlignCenter)
        pm = self.images.get(p.get("image_url"))
        if pm: th.setPixmap(pm); th.setStyleSheet("background:transparent;")
        else: th.setText(p["name"][:1].upper())
        info = QVBoxLayout(); info.setSpacing(2)
        top = QHBoxLayout(); top.setSpacing(6); nm = QLabel(p["name"]); nm.setObjectName("nm"); top.addWidget(nm)
        if it.get("ai"):
            ai = QLabel("AI"); ai.setObjectName("ai"); ai.setFixedHeight(18); top.addWidget(ai, 0, Qt.AlignVCenter)
        top.addStretch()
        unit = QLabel(f"{self.money(p['price'])} each"); unit.setObjectName("price")
        def btn(txt, name, fn):
            b = QPushButton(txt); b.setObjectName(name); b.setFocusPolicy(Qt.NoFocus); b.clicked.connect(fn); return b
        pid = it["product_id"]
        q = QLabel(str(it["qty"])); q.setObjectName("qty"); q.setAlignment(Qt.AlignCenter)
        stepper = QHBoxLayout(); stepper.setSpacing(4)
        stepper.addWidget(btn("−", "step", lambda: self.change_qty(pid, -1))); stepper.addWidget(q)
        stepper.addWidget(btn("+", "step", lambda: self.change_qty(pid, 1))); stepper.addStretch()
        info.addLayout(top); info.addWidget(unit); info.addLayout(stepper)
        right = QVBoxLayout(); right.setSpacing(0)
        right.addWidget(btn("✕", "rm", lambda: self.change_qty(pid, -99)), 0, Qt.AlignRight)
        amt = QLabel(self.money(p["price"] * it["qty"])); amt.setObjectName("amt"); right.addStretch(); right.addWidget(amt, 0, Qt.AlignRight)
        h.addWidget(th); h.addLayout(info, 1); h.addLayout(right)
        return w

    # ---------- phone link: scan the QR, review / remove items, confirm with a PIN ----------
    def start_phone(self):
        ps = phone.settings(self.cfg)
        if not ps["enabled"]: return
        try:
            srv = phone.make_server(self.cfg); srv.start()
        except OSError:
            self.last.setText(f"⚠ Phone link unavailable: port {ps['port']} is in use. Change phone.port in config.json.")
            return
        if ps["mode"] == "web" and not str(ps.get("page_url") or "").startswith("http"):
            self.last.setText("⚠ Phone link: set phone.page_url in config.json to your order_tally_PIN.html address.")
        self.phone = srv
        srv.hub.request.connect(self.on_phone_request)
        self.phone_tick.start()

    def phone_open(self):
        """A student just tapped in: give them a fresh QR code / token."""
        if not self.phone: return
        self.phone.new_session(); url = self.phone.url()
        self.phone_card.set_url(url); self.gate.set_url(url); self.phone_card.set_connected(False)

    def phone_close(self):
        """Student done (or session ended): the old QR code stops working immediately."""
        self.phone_release(flush=False)
        if self.phone: self.phone.revoke()
        self.tally_top.show()
        self.phone_card.hide(); self.phone_card.set_connected(False); self.set_gate(False)

    def phone_release(self, flush=True):
        was, self.phone_hold = self.phone_hold, False
        self.hold_timer.stop()
        if was and self.phone and hasattr(self.phone, "set_phase"): self.phone.set_phase("browse")
        if was and flush: self.flush_queue(); self.idle_banner()

    def _hold_expired(self):
        if self.paying: return self.hold_timer.start(5000)      # never drop the hold in the middle of a payment
        self.phone_release()

    def set_gate(self, on):
        """on=True: camera off, the order tally is replaced by the QR panel. on=False: normal kiosk."""
        self.phone_gate = on
        if on: self.tally_top.show()
        self.tally_box.setVisible(not on); self.gate.setVisible(on)
        self.sub.setText(self.sub_gate if on else self.sub_ready)
        if on and not self.vision:
            self.video.clear(); self.video.setText("Camera is off\nScan the QR code with your phone to turn it on.")

    def _fade(self, w, a, b, ms, done=None):
        """Fade a widget's opacity from a to b, then call done()."""
        eff = QGraphicsOpacityEffect(w); eff.setOpacity(a); w.setGraphicsEffect(eff)
        an = QPropertyAnimation(eff, b"opacity", self)
        an.setDuration(ms); an.setStartValue(a); an.setEndValue(b); an.setEasingCurve(QEasingCurve.InOutCubic)
        def fin():
            w.setGraphicsEffect(None)
            if done: done()
        an.finished.connect(fin); an.start(QPropertyAnimation.DeleteWhenStopped)

    def phone_unlock(self):
        """The student's phone connected: camera on. The order tally now lives on the phone (the student can only
        remove items there), so the kiosk's own tally never shows: the QR panel fades out and the compact panel fades in."""
        self.phone_gate = False                                      # also stops _phone_tick from unlocking twice
        self.sub.setText(self.sub_ready)
        self.phone_card.show(); self.last.setText("Waiting for the first item…")
        self.touch(); self.start_camera(); self.idle_banner()
        self.tally_top.hide()
        def show_compact():
            if not (self.phone and self.phone.connected()): return   # the session ended during the fade
            self.gate.hide(); self.tally_box.show(); self._fade(self.tally_box, 0.0, 1.0, 320)
        self._fade(self.gate, 1.0, 0.0, 220, show_compact)

    def _phone_tick(self):
        if self.phone_gate and self.state == "active" and not self.confirming and self.phone and self.phone.connected():
            return self.phone_unlock()
        if self.phone and self.phone.token and self.state == "active":
            was = self.phone_card._connected
            self.phone_card.set_connected(self.phone.connected())
            if was != self.phone_card._connected and not self.banner_timer.isActive(): self.idle_banner()
            if self.phone.connected() and hasattr(self.phone, "push_state"): self.phone.push_state(self.phone_snapshot())
            if self.phone.connected() and hasattr(self.phone, "set_pay_info"):
                st, name = self.paylater_state()               # what the phone needs to offer / block Pay Later
                self.phone.set_pay_info(self.order["payment"], st, name)

    def phone_snapshot(self):
        """The order as the phone page shows it (no balance, no PIN: only what the student needs to review)."""
        items = []
        for it in self.order["items"]:
            p = self.products.get(it["product_id"])
            if p: items.append({"pid": str(it["product_id"]), "name": p["name"], "price": p["price"], "qty": it["qty"], "ai": bool(it.get("ai"))})
        return {"student": (self.student or {}).get("name", ""), "currency": self.cur, "items": items, "total": round(self.order_total(), 2)}

    def order_total(self):
        return sum(self.products[i["product_id"]]["price"] * i["qty"] for i in self.order["items"] if i["product_id"] in self.products)

    def on_phone_request(self, kind, body, reply):
        """Runs on the UI thread. `reply(code, dict)` may be called now or later (after a network call)."""
        try:
            getattr(self, "_ph_" + kind)(body or {}, reply)
        except Exception as e:
            reply(500, {"ok": False, "reason": "error", "message": f"Kiosk error: {e}"})

    def _ph_no(self, reply, reason, msg, code=409):
        reply(code, {"ok": False, "reason": reason, "message": msg}); return False

    def _ph_ready(self, reply):
        if self.locked or self.state != "active": return self._ph_no(reply, "inactive", "The kiosk isn't taking changes right now.")
        if self.paying: return self._ph_no(reply, "busy", "A payment is in progress.")
        if self.confirming: return self._ph_no(reply, "confirming", "Tap your card at the kiosk first to keep this session open.")
        return True

    def _ph_state(self, body, reply):
        s, items = self.student or {}, []
        for it in self.order["items"]:
            p = self.products.get(it["product_id"])
            if p: items.append({"pid": it["product_id"], "name": p["name"], "price": p["price"], "qty": it["qty"], "ai": bool(it.get("ai"))})
        reply(200, {"ok": True, "student": s.get("name", ""), "balance": s.get("balance"), "currency": self.cur, "items": items,
                    "total": round(self.order_total(), 2), "payment": self.order["payment"], "busy": self.paying,
                    "hold": self.phone_hold, "active": self.state == "active"})

    def _ph_remove(self, body, reply):
        if not self._ph_ready(reply): return
        if self.phone_hold: return self._ph_no(reply, "locked", "Your order is locked while you confirm it.")
        pid = next((i["product_id"] for i in self.order["items"] if str(i["product_id"]) == str(body.get("pid"))), None)
        if pid is None: return reply(200, {"ok": True})              # already gone
        self.touch(); self.change_qty(pid, -99 if body.get("all") else -1)
        reply(200, {"ok": True})

    def _ph_begin_pin(self, body, reply):
        if not self._ph_ready(reply): return
        if not self.order["items"]: return self._ph_no(reply, "empty", "Your order is empty.")
        if self.order["payment"] == "paylater":
            st, name = self.paylater_state()
            if st in ("no_parent", "not_active"):
                self.pending += 1                                    # same rule as the card tap: fall back to RFID
                run_async(lambda: self.api.rpc("kiosk_set_payment", p_method="rfid"), self.after_mutation)
                msg = NO_PARENT_MSG if st == "no_parent" else not_activated_msg(name)
                return self._ph_no(reply, "paylater", msg.replace("\n\n", " "))
        self.phone_hold = True; self.hold_timer.start(90_000); self.touch()
        self.show_banner("The student is confirming on their phone…", "busy")
        reply(200, {"ok": True, "total": round(self.order_total(), 2)})

    def _ph_set_payment(self, body, reply):
        """The student picked RFID payment / Pay Later on the phone. Same rules as the old kiosk pill: Pay Later needs a
        linked parent who has activated it. The phone already blocks that case; this is the second check."""
        reply(200, {"ok": True})                                       # the phone watches the order's real payment method instead
        if self.locked or self.state != "active" or self.paying or self.phone_hold: return
        m = "paylater" if body.get("method") == "paylater" else "rfid"
        if m == self.order["payment"]: return
        if m == "paylater" and self.paylater_state()[0] in ("no_parent", "not_active"): return
        self.touch(); self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_set_payment", p_method=m), self.after_mutation)

    def _ph_pin(self, body, reply):
        """Web mode: the phone typed its PIN. The order was frozen when the card was tapped, so the total is the one it saw."""
        self._ph_pay({"pin": body.get("pin"), "expect_total": self.order_total()}, reply)

    def _ph_cancel_pin(self, body, reply):
        if not self.paying: self.phone_release()
        reply(200, {"ok": True})

    def _ph_pay(self, body, reply):
        if self.locked or self.state != "active": return self._ph_no(reply, "inactive", "The kiosk isn't taking payments right now.")
        if self.paying: return self._ph_no(reply, "busy", "A payment is already in progress.")
        if not self.phone_hold: return self._ph_no(reply, "not_started", "Confirmation timed out. Confirm your order again.")
        pin, n = str(body.get("pin", "")), int(phone.settings(self.cfg)["pin_length"])
        if not (pin.isdigit() and len(pin) == n): return self._ph_no(reply, "bad_request", f"Enter your {n}-digit PIN.", 400)
        try: shown = round(float(body.get("expect_total")) * 100)
        except (TypeError, ValueError): shown = None
        if not self.order["items"] or shown != round(self.order_total() * 100):
            self.phone_release()
            return self._ph_no(reply, "changed", "Your order changed. Review it and confirm again.")
        uid = self.session_uid
        self.paying = True; self.show_banner("Checking PIN…", "busy")
        run_async(lambda: self.api.rpc("kiosk_verify_pin", p_rfid=uid, p_pin=pin), lambda r, e: self.on_pin_checked(uid, r, e, reply))

    def on_pin_checked(self, uid, res, err, reply):
        if err or not res.get("ok"):
            self.paying = False
            if not err and res.get("reason") == "session":
                reply(200, {"ok": False, "reason": "session", "message": REASONS["session"]}); self.phone_release(flush=False)
                return self.lock(REASONS["session"])
            msg = str(err) if err else self.reason_text(res)
            r = "network" if err else res.get("reason")
            if r != "bad_pin": self.phone_release()                 # wrong PIN: stay on the PIN screen, order stays frozen
            else: self.idle_banner()
            return reply(200, {"ok": False, "reason": r, "message": msg})
        self.show_banner("Processing payment…", "busy")
        run_async(lambda: self.api.rpc("kiosk_checkout", p_rfid=uid), lambda r, e: self.on_phone_paid(r, e, reply))

    def on_phone_paid(self, res, err, reply):
        ok = bool(res and res.get("ok")) and not err
        self.phone_hold = False; self.hold_timer.stop()
        self.on_paid(res, err)                                      # the kiosk's own screen: receipt, or the error banner
        if ok:
            reply(200, {"ok": True, "total": res["total"], "new_balance": res.get("new_balance"), "method": res.get("method")})
        else:
            reply(200, {"ok": False, "reason": (res or {}).get("reason") or "error",
                        "message": str(err) if err else self.reason_text(res or {})})

    # ---------- RFID tap = show the student, then pay ----------
    def eventFilter(self, obj, ev):
        if ev.type() in (QEvent.MouseButtonPress, QEvent.TouchBegin): self.touch()
        if ev.type() == QEvent.KeyPress and self.cfg["rfid"].get("mode") == "keyboard":
            now = time.monotonic()
            if now - self._last > 0.15: self._buf = ""            # humans type slower than a reader
            self._last = now
            if ev.key() in (Qt.Key_Return, Qt.Key_Enter):
                uid, self._buf = self._buf, ""
                if len(uid) >= 4: self.on_card(uid)
            elif ev.text() and ev.text().isprintable():
                self._buf += ev.text()
            else:
                return False
            return True          # consume it: an unhandled key bubbles up through every parent widget and would be typed several times
        return False

    def on_card(self, uid):
        uid = (uid or "").strip()
        if not uid or self.locked or self.paying: return
        if self.confirming:                          # "still there?" prompt: a tap only confirms presence, it never pays
            if uid == self.session_uid: self.continue_order()
            else: self.confirm.set_note("That card is not the student who started this order.")
            return
        if self.prompt.isVisible():
            if not self.tap_through: return          # only the "session expired" prompt lets a tap straight through
            self.prompt.dismiss()
        if self.receipt.isVisible(): self.receipt.dismiss()      # closing the receipt returns to the greeting screen
        if self.state == "idle": self.begin_session(uid)
        elif self.state == "active": self.touch(); self.pay(uid)

    def begin_session(self, uid):
        self.paying = True; self.greet.set_status("Reading card…")
        run_async(lambda: self.api.rpc("kiosk_card_info", p_rfid=uid), lambda r, e: self.on_tap_info(uid, r, e))

    def on_tap_info(self, uid, res, err):
        self.paying = False
        if self.state != "idle": return
        if err: return self.greet.set_status(str(err), True, 5)
        if not res.get("ok"):
            if res.get("reason") == "session": return self.lock(REASONS["session"])
            msg = self.reason_text(res)
            if res.get("reason") == "unknown_card": msg += f"\nReader sent: {uid}"      # compare with accounts.rfid_uid
            return self.greet.set_status(msg, True, 8)
        self.student, self.session_uid, self.state = res, uid, "welcome"
        self.greet.show_welcome(*self.welcome_text(res))
        self.show_student(); self.phone_open()
        QTimer.singleShot(WELCOME_MS, self.enter_active)

    def pay(self, uid):
        if self.phone_hold: return self.show_banner("Enter your PIN on your phone to finalize your payment.", "busy", 3)
        if uid != self.session_uid:
            return self.show_banner("This card is not the student who started this order.", "err", 3)
        if not self.order["items"]:
            return self.show_banner("The order is empty. Scan items before paying.", "err", 3)
        if self.order["payment"] == "paylater":
            st, name = self.paylater_state()
            if st in ("no_parent", "not_active"):
                self.pending += 1                              # switch back to RFID so the cashier isn't stuck
                run_async(lambda: self.api.rpc("kiosk_set_payment", p_method="rfid"), self.after_mutation)
                return self.show_pay_later_block(st, name)
        if self.phone and self.phone.connected() and hasattr(self.phone, "set_phase"):
            return self.begin_phone_pin()                  # 2nd tap = confirm; the PIN is typed on the phone
        self.paying = True; self.show_banner("Processing payment…", "busy")
        run_async(lambda: self.api.rpc("kiosk_checkout", p_rfid=uid), self.on_paid)

    def begin_phone_pin(self):
        """Second RFID tap: freeze the order and tell the phone to switch from the order tally to PIN entry."""
        self.phone_hold = True; self.hold_timer.start(90_000); self.touch()
        self.show_banner("Enter your PIN on your phone to finalize your payment…", "busy")
        self.phone.set_phase("pin", round(self.order_total(), 2), int(phone.settings(self.cfg)["pin_length"]))

    def fail(self, msg, secs=6):
        self.paying = False; self.touch(); self.show_banner("✖ " + msg, "err", secs)
        self.flush_queue()

    def reason_text(self, res):
        r = res.get("reason")
        if r == "insufficient": return f"Insufficient balance ({self.money(res.get('balance') or 0)})."
        if r == "over_limit": return f"Over today's spending limit. Left today: {self.money(res.get('remaining') or 0)}."
        if r == "out_of_stock": return f"Out of stock: {res.get('name') or 'an item'} ({res.get('stock') or 0} left). Remove it or lower the quantity."
        if r == "paylater_limit": return f"Over the Pay Later limit. Available: {self.money(res.get('available') or 0)}."
        if r == "bad_pin":
            n = res.get("attempts_left")
            return "Wrong PIN. Try again." if n is None else f"Wrong PIN. {n} {'try' if n == 1 else 'tries'} left."
        if r == "no_pin": return "You haven't set a PIN yet. Set one on the TapMate website first."
        if r == "pin_locked": return "Too many wrong PINs. PIN entry is locked for a few minutes."
        if r == "no_parent": return NO_PARENT_MSG.replace("\n\n", " ")
        if r == "paylater_off":
            who = res.get("parent_name") or self.paylater_state()[1] or "a parent"
            return f"Pay Later isn't activated. Ask {who} to activate it."
        return REASONS.get(r, "Payment failed.")

    def show_student(self):
        s = self.student
        self.stu_name.setText(s["name"])
        self.stu_bal.setText(self.money(s["balance"]))
        cap = s.get("daily_cap")
        self.stu_lim.setText(self.money(cap) if cap else "No limit")
        self.student_box.show(); self.student_timer.stop()

    def clear_student(self):
        self.student_box.hide()

    def on_paid(self, res, err):
        if err: return self.fail(str(err))
        if not res.get("ok"):
            if res.get("reason") == "session": self.paying = False; return self.lock(REASONS["session"])
            return self.fail(self.reason_text(res))
        self.idle_timer.stop()                               # paid: nothing left to time out
        self.stop_camera()                                   # the order is done: camera off until the next student taps
        self.student["balance"] = res["new_balance"]; self.student["remaining_today"] = res.get("remaining_today")
        self.show_student()
        self.order = empty_order(self.order["payment"]); self._prev_qty = {}
        self.render_order()
        self.show_banner(f"✔ Paid {self.money(res['total'])} · {self.student['name']}", "ok")
        # a short beat so the cashier sees the student's name / new balance, then the receipt prints
        QTimer.singleShot(1100, lambda: self.print_receipt(res))

    def print_receipt(self, res):
        self.paying = False
        self.receipt.show_receipt(res, self.student, self.cashier["name"], self.cur)
        self.poll_order()

    def on_receipt_closed(self):
        if not self.locked: self.go_idle()

    def closeEvent(self, e):
        self.stop_watch(); self.stop_camera(); self.clear_on_close()
        for t in self._retired: t.wait(2000)
        if self.serial: self.serial.stop()
        if self.phone: self.phone.stop()
        e.accept()


def token_from_args(argv):
    for a in argv[1:]:
        if a.startswith(protocol.SCHEME + ":"):
            return (parse_qs(urlparse(a).query).get("token") or [""])[0]
        if a.startswith("--token="):
            return a.split("=", 1)[1]
    return ""


def main():
    if "--register" in sys.argv: return protocol.register()
    if "--unregister" in sys.argv: return protocol.unregister()
    token = token_from_args(sys.argv)
    app = QApplication(sys.argv)

    # one kiosk at a time (one camera): a second click on the website just hands the new session to the open window
    sock = QLocalSocket(); sock.connectToServer(SERVER_NAME)
    if sock.waitForConnected(300):
        sock.write(token.encode()); sock.flush(); sock.waitForBytesWritten(1000); return 0

    try:
        cfg = config.load()
    except Exception as e:
        QMessageBox.critical(None, "TapMate Kiosk", f"Couldn't read config.json:\n{e}"); return 1

    global _hub
    _hub = _Hub()
    app.setStyleSheet(STYLE)
    win = MainWindow(cfg)
    win.showFullScreen() if cfg.get("fullscreen") else win.show()

    server = QLocalServer(); QLocalServer.removeServer(SERVER_NAME); server.listen(SERVER_NAME)
    def on_conn():
        c = server.nextPendingConnection()
        def read():
            win.start_session(bytes(c.readAll()).decode(errors="ignore")); win.showNormal(); win.raise_(); win.activateWindow()
        c.readyRead.connect(read)
    server.newConnection.connect(on_conn)

    win.start_session(token)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
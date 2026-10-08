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

import config, protocol
from api import Api, ApiError
from vision import Vision
from widgets import (PillToggle, ReceiptOverlay, PromptOverlay, ConfirmOverlay, GreetingScreen, MAROON, MAROON_DK, GOLD, GOLD_LT, INK, MUTED, LINE, SOFT)

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
        self.images = ImageCache(); self.images.loaded.connect(self.render_order)
        self._buf, self._last = "", 0.0
        self.setObjectName("root"); self.setWindowTitle("TapMate Kiosk"); self.resize(1400, 840)
        self.banner_timer = QTimer(self); self.banner_timer.setSingleShot(True); self.banner_timer.timeout.connect(self.idle_banner)
        self.student_timer = QTimer(self); self.student_timer.setSingleShot(True); self.student_timer.timeout.connect(self.clear_student)
        self.idle_timer = QTimer(self); self.idle_timer.setSingleShot(True)
        self.idle_timer.setInterval(int(cfg["idle_seconds"] * 1000)); self.idle_timer.timeout.connect(self.ask_continue)
        self.confirm_tick = QTimer(self); self.confirm_tick.setInterval(1000); self.confirm_tick.timeout.connect(self.tick_confirm)
        self._build()
        self.receipt = ReceiptOverlay(self); self.receipt.closed.connect(self.on_receipt_closed)
        self.prompt = PromptOverlay(self); self.prompt.closed.connect(lambda: setattr(self, "tap_through", False))
        self.confirm = ConfirmOverlay(self)          # created last so it sits above every other overlay
        QApplication.instance().installEventFilter(self)
        QShortcut(QKeySequence("F11"), self, activated=self.toggle_full)
        self.poll = QTimer(self); self.poll.setInterval(1000); self.poll.timeout.connect(self.poll_order)
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
        sub = QLabel("Place items in the tray in front of the camera. Recognised items are added to the order tally automatically.")
        sub.setObjectName("muted"); sub.setWordWrap(True)
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

        p.addWidget(self.student_box)
        h = QHBoxLayout(); h2 = QLabel("Order tally"); h2.setObjectName("h2")
        self.count = QLabel("0 items"); self.count.setObjectName("pill")
        h.addWidget(h2); h.addStretch(); h.addWidget(self.count); p.addLayout(h)
        note = QLabel("Scanned items stay here until the cashier removes them."); note.setObjectName("muted"); p.addWidget(note)
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
        p.addWidget(area, 1)

        self.pay_toggle = PillToggle(["RFID payment", "Pay Later"]); self.pay_toggle.changed.connect(self.on_pay_toggled)
        p.addWidget(self.pay_toggle)
        self.clear_btn = QPushButton("Clear order"); self.clear_btn.setObjectName("ghost")
        self.clear_btn.setFocusPolicy(Qt.NoFocus); self.clear_btn.clicked.connect(self.clear_order); p.addWidget(self.clear_btn)
        tot = QHBoxLayout(); tl = QLabel("Total"); tl.setObjectName("totalL")
        self.total = QLabel(self.money(0)); self.total.setObjectName("total")
        tot.addWidget(tl); tot.addStretch(); tot.addWidget(self.total); p.addLayout(tot)
        self.banner = QLabel(); self.banner.setAlignment(Qt.AlignCenter); self.banner.setWordWrap(True); self.banner.setMinimumHeight(64)
        p.addWidget(self.banner); self.show_banner("Waiting for the cashier session…", "busy")
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
        method = "Pay Later" if self.order["payment"] == "paylater" else "RFID"
        self.show_banner(f"Tap the same RFID card again to pay ({method})" if self.order["items"]
                         else "Waiting for items to scan…", "idle")

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
        if self.vision: return
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
        self.state = "boot"; self.stop_watch(); self.stop_camera(); self.student = self.session_uid = None; self.student_box.hide()
        self.stack.setCurrentWidget(self.greet)
        self.greet.show_idle(ready=False, replay=(was != "boot"))
        self.greet.set_status("Signing in…")

    def go_idle(self):
        was = self.state
        self.state = "idle"; self.stop_watch(); self.stop_camera(); self.queued = []
        self.student = self.session_uid = None; self.student_box.hide()
        self.stack.setCurrentWidget(self.greet)
        self.greet.show_idle(ready=True, replay=(was != "boot"))

    def welcome_text(self, s):
        return f"Welcome! {s['name']}!", ""

    def fade_to(self, page, ms=FADE_MS):
        """Cross-fade: snapshot the current screen, switch pages underneath, then fade the snapshot away."""
        old = self.stack.currentWidget()
        if old is page: return
        prev = getattr(self, "_fade", None)
        if prev: prev[1].stop(); prev[0].deleteLater()
        ov = QLabel(self.stack); ov.setPixmap(old.grab()); ov.setGeometry(self.stack.rect())
        ov.setAttribute(Qt.WA_TransparentForMouseEvents)
        eff = QGraphicsOpacityEffect(ov); eff.setOpacity(1.0); ov.setGraphicsEffect(eff)
        self.stack.setCurrentWidget(page); ov.show(); ov.raise_()
        anim = QPropertyAnimation(eff, b"opacity", ov)
        anim.setDuration(ms); anim.setStartValue(1.0); anim.setEndValue(0.0); anim.setEasingCurve(QEasingCurve.InOutCubic)
        def done():
            ov.deleteLater()
            if getattr(self, "_fade", None) and self._fade[0] is ov: self._fade = None
        anim.finished.connect(done); self._fade = (ov, anim); anim.start()

    def enter_active(self):
        if self.state != "welcome" or self.locked: return
        self.state = "active"; self.idle_timer.start()
        self.last.setText("Waiting for the first item…")
        self.fade_to(self.main_page); self.idle_banner()
        # start the camera once the fade is nearly done, so loading it can't stutter the animation
        QTimer.singleShot(FADE_MS - 150, lambda: self.start_camera() if self.state == "active" and not self.locked else None)

    def lock(self, msg):
        self.locked = True; self.poll.stop(); self.state = "locked"; self.stop_watch(); self.stop_camera(); self.show_banner(msg, "err")
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
        if self.paying or self.receipt.isVisible() or self.prompt.isVisible():
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
        if self.paying: self.queued.append(label); return       # belongs to the next order
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

    def parent_linked(self):
        """Pay Later needs a linked parent. Fails CLOSED: unless the server explicitly says the student has a
        parent (kiosk_card_info must return `parent_linked: true`), Pay Later is treated as not allowed."""
        s = self.student or {}
        return any(bool(s.get(k)) for k in ("parent_linked", "has_parent", "parent_id", "parent_account_id"))

    def show_no_parent(self):
        self.prompt.show_prompt("Pay Later unavailable", NO_PARENT_MSG)

    def on_pay_toggled(self, idx):
        if self.paying or self.locked: return self.pay_toggle.set_index(0 if self.order["payment"] == "rfid" else 1)
        if idx == 1 and not self.parent_linked():
            self.pay_toggle.set_index(0); self.show_no_parent(); return
        m = "paylater" if idx == 1 else "rfid"
        self.pending += 1
        run_async(lambda: self.api.rpc("kiosk_set_payment", p_method=m), self.after_mutation)

    def after_mutation(self, res, err):
        self.pending = max(self.pending - 1, 0)
        if err:
            self.show_banner(str(err), "err", 4); return self.apply_order(self.order)
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
        self.show_student()
        QTimer.singleShot(WELCOME_MS, self.enter_active)

    def pay(self, uid):
        if uid != self.session_uid:
            return self.show_banner("This card is not the student who started this order.", "err", 3)
        if not self.order["items"]:
            return self.show_banner("The order is empty. Scan items before paying.", "err", 3)
        if self.order["payment"] == "paylater" and not self.parent_linked():
            self.pending += 1                                  # switch back to RFID so the cashier isn't stuck
            run_async(lambda: self.api.rpc("kiosk_set_payment", p_method="rfid"), self.after_mutation)
            return self.show_no_parent()
        self.paying = True; self.show_banner("Processing payment…", "busy")
        run_async(lambda: self.api.rpc("kiosk_checkout", p_rfid=uid), self.on_paid)

    def fail(self, msg, secs=6):
        self.paying = False; self.touch(); self.show_banner("✖ " + msg, "err", secs)
        self.flush_queue()

    def reason_text(self, res):
        r = res.get("reason")
        if r == "insufficient": return f"Insufficient balance ({self.money(res.get('balance') or 0)})."
        if r == "over_limit": return f"Over today's spending limit. Left today: {self.money(res.get('remaining') or 0)}."
        if r == "out_of_stock": return f"Out of stock: {res.get('name') or 'an item'} ({res.get('stock') or 0} left). Remove it or lower the quantity."
        if r == "paylater_limit": return f"Over the Pay Later limit. Available: {self.money(res.get('available') or 0)}."
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
"""Theme + custom widgets: sliding pill toggle and the animated receipt printer."""
import math
from datetime import datetime
from PySide6.QtCore import (Qt, Signal, Property, QPropertyAnimation, QVariantAnimation, QEasingCurve, QRectF,
                            QPointF, QTimer)
from PySide6.QtGui import (QPainter, QColor, QPen, QPainterPath, QLinearGradient, QRadialGradient, QFont, QPixmap)
from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QFrame, QGraphicsOpacityEffect

MAROON, MAROON_DK, GOLD, GOLD_LT = "#6D1A24", "#4E1019", "#C9A227", "#F1DFA0"
INK, MUTED, LINE, SOFT = "#2B1B1E", "#8A7477", "#EADFDF", "#FAF6F4"


class PillToggle(QWidget):
    """Two-option pill with a gold knob that glides between the options."""
    changed = Signal(int)

    def __init__(self, labels):
        super().__init__()
        self.labels, self._idx, self._k = labels, 0, 0.0
        self.setFixedHeight(48); self.setCursor(Qt.PointingHandCursor); self.setFocusPolicy(Qt.NoFocus)
        self.anim = QPropertyAnimation(self, b"knob", self)
        self.anim.setDuration(300); self.anim.setEasingCurve(QEasingCurve.OutCubic)

    def _get(self): return self._k
    def _set(self, v): self._k = v; self.update()
    knob = Property(float, _get, _set)

    def set_index(self, i, animate=True):
        if i == self._idx and abs(self._k - i) < 0.001: return
        self._idx = i; self.anim.stop()
        if animate:
            self.anim.setStartValue(self._k); self.anim.setEndValue(float(i)); self.anim.start()
        else:
            self._set(float(i))

    def mousePressEvent(self, e):
        if not self.isEnabled(): return
        i = 0 if e.position().x() < self.width() / 2 else 1
        if i != self._idx:
            self.set_index(i); self.changed.emit(i)

    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.Antialiasing)
        p.setOpacity(1.0 if self.isEnabled() else 0.55)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setPen(QPen(QColor(LINE))); p.setBrush(QColor("#F3E8E8"))
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)
        pad = 4; w = (r.width() - 2 * pad) / 2
        k = QRectF(r.left() + pad + self._k * w, r.top() + pad, w, r.height() - 2 * pad)
        g = QLinearGradient(k.topLeft(), k.bottomLeft()); g.setColorAt(0, QColor("#E3C458")); g.setColorAt(1, QColor(GOLD))
        p.setPen(Qt.NoPen); p.setBrush(g); p.drawRoundedRect(k, k.height() / 2, k.height() / 2)
        f = QFont(self.font()); f.setPointSize(10); f.setBold(True); p.setFont(f)
        for i, text in enumerate(self.labels):
            t = max(0.0, 1 - abs(self._k - i))                    # 1 = selected, 0 = not
            a, b = QColor(MUTED), QColor(MAROON_DK)
            c = QColor(int(a.red() + (b.red() - a.red()) * t), int(a.green() + (b.green() - a.green()) * t),
                       int(a.blue() + (b.blue() - a.blue()) * t))
            p.setPen(c); p.drawText(QRectF(r.left() + pad + i * w, r.top(), w, r.height()), Qt.AlignCenter, text)


class _Dash(QWidget):
    def __init__(self):
        super().__init__(); self.setFixedHeight(12)
    def paintEvent(self, _):
        p = QPainter(self); pen = QPen(QColor("#B9ABAD"), 1, Qt.DashLine); p.setPen(pen)
        p.drawLine(0, 6, self.width(), 6)


class _Barcode(QWidget):
    def __init__(self, text):
        super().__init__(); self.text = text; self.setFixedHeight(40)
    def paintEvent(self, _):
        p = QPainter(self); p.setPen(Qt.NoPen); p.setBrush(QColor("#222"))
        bits = "".join(format(ord(c), "08b") for c in self.text + self.text)
        x, total = 0, sum(2 if b == "1" else 1 for b in bits) + len(bits)
        scale = min(1.0, self.width() / max(total, 1)); x = (self.width() - total * scale) / 2
        for b in bits:
            w = (2 if b == "1" else 1) * scale
            p.drawRect(QRectF(x, 0, w, self.height())); x += w + scale


class ReceiptPaper(QWidget):
    W = 330

    def __init__(self, d, student, cashier, cur):
        super().__init__()
        self.setFixedWidth(self.W)
        self.setStyleSheet("QLabel{background:transparent;color:#222;font-family:Consolas,'Courier New',monospace;font-size:12px;}")
        m = lambda v: f"{cur}{float(v):,.2f}"
        lay = QVBoxLayout(self); lay.setContentsMargins(22, 22, 22, 30); lay.setSpacing(5)

        def label(t, size=12, bold=False, center=False, color=None):
            l = QLabel(t); l.setWordWrap(True)
            l.setStyleSheet(f"font-size:{size}px;{'font-weight:700;' if bold else ''}{f'color:{color};' if color else ''}")
            if center: l.setAlignment(Qt.AlignCenter)
            return l
        def row(a, b, size=12, bold=False):
            h = QHBoxLayout(); h.setSpacing(8); x = label(a, size, bold); y = label(b, size, bold)
            y.setAlignment(Qt.AlignRight | Qt.AlignTop); y.setWordWrap(False); h.addWidget(x, 1); h.addWidget(y); lay.addLayout(h)

        try:
            when = datetime.fromisoformat(str(d.get("paid_at")).replace("Z", "+00:00")).astimezone()
        except Exception:
            when = datetime.now()
        lay.addWidget(label("TAPMATE", 20, True, True, MAROON))
        lay.addWidget(label("Cashier Kiosk · Official Receipt", 11, False, True, "#777"))
        lay.addWidget(_Dash())
        row("Reference", d.get("reference", ""), 12, True)
        row("Date", when.strftime("%b %d, %Y  %I:%M %p"))
        row("Student", student.get("name", ""))
        row("Cashier", cashier)
        row("Payment", "Pay Later" if d.get("method") == "paylater" else "RFID wallet")
        lay.addWidget(_Dash())
        items = d.get("items") or []
        for it in items[:12]:
            row(f"{it['qty']} × {it['name']}", m(float(it["price"]) * int(it["qty"])))
        if len(items) > 12:
            extra = items[12:]
            row(f"+ {len(extra)} more item(s)", m(sum(float(i['price']) * int(i['qty']) for i in extra)))
        lay.addWidget(_Dash())
        row("TOTAL", m(d["total"]), 16, True)
        lay.addWidget(_Dash())
        if d.get("method") == "paylater":
            row("Pay Later available", m(d.get("pay_later_available") or 0))
        else:
            row("Wallet balance", m(d.get("new_balance") or 0))
        if d.get("remaining_today") is not None:
            row("Left to spend today", m(d["remaining_today"]))
        lay.addSpacing(6); lay.addWidget(_Barcode(d.get("reference", "TAPMATE")))
        lay.addWidget(label("Thank you!", 12, True, True))

    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.Antialiasing)
        w, h, z = self.width(), self.height(), 8
        path = QPainterPath(); path.moveTo(0, 0); path.lineTo(w, 0); path.lineTo(w, h - z)
        x, up = float(w), False
        step = w / 22
        while x > 0:                                    # torn, zig-zag bottom edge
            x -= step; path.lineTo(max(x, 0), h if not up else h - z); up = not up
        path.closeSubpath()
        p.setPen(QPen(QColor("#E2D8D8"))); p.setBrush(QColor("#FFFFFF")); p.drawPath(path)


class _Edge(QWidget):
    """Torn leading edge of the paper while it is still being printed."""
    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.Antialiasing)
        W, z = self.width(), 8
        path = QPainterPath(); path.moveTo(0, 0); path.lineTo(W, 0); path.lineTo(W, 1)
        x, up, step = float(W), False, W / 22
        while x > 0:
            x -= step; path.lineTo(max(x, 0), 1 + (z if not up else 0)); up = not up
        path.closeSubpath()
        p.setPen(QPen(QColor("#E2D8D8"))); p.setBrush(QColor("#FFFFFF")); p.drawPath(path)


class _Printer(QWidget):
    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.Antialiasing)
        r = QRectF(self.rect())
        g = QLinearGradient(r.topLeft(), r.bottomLeft()); g.setColorAt(0, QColor(MAROON)); g.setColorAt(1, QColor(MAROON_DK))
        p.setPen(Qt.NoPen); p.setBrush(g); p.drawRoundedRect(r, 14, 14)
        p.setBrush(QColor("#1A0508")); p.drawRoundedRect(QRectF(r.left() + 22, r.bottom() - 16, r.width() - 44, 7), 3.5, 3.5)
        p.setBrush(QColor(GOLD)); p.drawEllipse(QPointF(r.left() + 24, r.top() + 14), 4, 4)


class ReceiptOverlay(QWidget):
    """Dims the kiosk and 'prints' a receipt out of a slot, line by line."""
    closed = Signal()

    def __init__(self, parent):
        super().__init__(parent)
        self.hide(); self.paper = None; self._shown = 0; self._cx0 = self._cy0 = 0
        self.printer = _Printer(self); self.printer.setFixedSize(380, 46)
        self.clip = QWidget(self)
        self.edge = _Edge(self); self.edge.setFixedSize(ReceiptPaper.W, 10)
        self.done = QPushButton("Done", self); self.done.setFocusPolicy(Qt.NoFocus); self.done.setCursor(Qt.PointingHandCursor)
        self.done.setFixedSize(160, 44); self.done.clicked.connect(self.dismiss)
        self.done.setStyleSheet(f"QPushButton{{background:{GOLD};color:{MAROON_DK};border:0;border-radius:22px;font-size:15px;font-weight:700;}}"
                                f"QPushButton:hover{{background:#D8B53A;}}")
        self.anim = QVariantAnimation(self); self.anim.setStartValue(0.0); self.anim.setEndValue(1.0)
        self.anim.setEasingCurve(QEasingCurve.InOutSine); self.anim.valueChanged.connect(self._tick)
        self.auto = QTimer(self); self.auto.setSingleShot(True); self.auto.timeout.connect(self.dismiss)

    def show_receipt(self, data, student, cashier, cur):
        if self.paper: self.paper.deleteLater()
        self.paper = ReceiptPaper(data, student, cashier, cur)
        self.paper.setParent(self.clip); self.paper.adjustSize()
        self.paper.resize(ReceiptPaper.W, self.paper.sizeHint().height()); self.paper.show()
        self.setGeometry(self.parentWidget().rect()); self._layout()
        self.paper.move(0, 0); self._vis(0)
        self.done.hide(); self.show(); self.raise_()
        self.anim.stop(); self.anim.setDuration(1300 + self.paper.height() * 4); self.anim.start()
        self.auto.start(25000)

    def _layout(self):
        if not self.paper: return
        h = self.paper.height(); total = self.printer.height() + h + 70
        top = max(16, (self.height() - total) // 2); cx = self.width() // 2
        self.printer.move(cx - self.printer.width() // 2, top)
        self._cx0, self._cy0 = cx - ReceiptPaper.W // 2, top + self.printer.height() - 8
        self._vis(getattr(self, "_shown", 0))
        self.printer.raise_()
        self.done.move(cx - self.done.width() // 2, self._cy0 + h + 22)

    def _vis(self, vis):
        """Show the top `vis` pixels of the paper (printing goes top to bottom)."""
        self._shown = vis
        self.clip.setGeometry(self._cx0, self._cy0, ReceiptPaper.W, max(vis, 0))
        self.edge.move(self._cx0, self._cy0 + vis - 1); self.edge.setVisible(0 < vis < self.paper.height())
        self.printer.raise_()

    def _tick(self, v):
        h = self.paper.height()
        self._vis(min(h, round(v * h / 7) * 7))            # advances in small steps, like a thermal printer
        if v >= 1.0:
            self._vis(h); self.edge.hide(); self.done.show(); self.done.raise_()

    def resizeEvent(self, e):
        self._layout(); super().resizeEvent(e)

    def paintEvent(self, _):
        QPainter(self).fillRect(self.rect(), QColor(30, 8, 12, 178))

    def mousePressEvent(self, e):
        if self.done.isVisible(): self.dismiss()

    def dismiss(self):
        if not self.isVisible(): return
        self.anim.stop(); self.auto.stop(); self.hide(); self.closed.emit()



class PromptOverlay(QWidget):
    """In-app prompt: dims the kiosk and shows a themed card (no native dialog, so the look stays immersive)."""
    closed = Signal()

    def __init__(self, parent):
        super().__init__(parent)
        self.hide()
        self.fx = QGraphicsOpacityEffect(self); self.fx.setOpacity(1.0); self.setGraphicsEffect(self.fx)
        self.fade = QPropertyAnimation(self.fx, b"opacity", self); self.fade.setDuration(220)
        self.fade.setEasingCurve(QEasingCurve.OutCubic)
        self.card = QFrame(self); self.card.setObjectName("promptCard"); self.card.setFixedWidth(500)
        self.card.setStyleSheet(f"QFrame#promptCard{{background:#FFFFFF;border:1px solid {LINE};border-radius:22px;}}"
                                "QFrame#promptCard QLabel{background:transparent;}")
        lay = QVBoxLayout(self.card); lay.setContentsMargins(36, 32, 36, 28); lay.setSpacing(12)
        self.icon = QLabel("!"); self.icon.setFixedSize(64, 64); self.icon.setAlignment(Qt.AlignCenter)
        self.icon.setStyleSheet(f"background:{GOLD};color:{MAROON_DK};border-radius:32px;font-size:36px;font-weight:800;")
        self.title = QLabel(); self.title.setAlignment(Qt.AlignCenter); self.title.setWordWrap(True)
        self.title.setStyleSheet(f"color:{MAROON};font-size:24px;font-weight:800;")
        self.text = QLabel(); self.text.setAlignment(Qt.AlignCenter); self.text.setWordWrap(True)
        self.text.setStyleSheet(f"color:{INK};font-size:15px;")
        self.ok = QPushButton("OK"); self.ok.setFocusPolicy(Qt.NoFocus); self.ok.setCursor(Qt.PointingHandCursor)
        self.ok.setFixedSize(160, 44); self.ok.clicked.connect(self.dismiss)
        self.ok.setStyleSheet(f"QPushButton{{background:{GOLD};color:{MAROON_DK};border:0;border-radius:22px;font-size:15px;font-weight:700;}}"
                              f"QPushButton:hover{{background:#D8B53A;}}")
        lay.addWidget(self.icon, 0, Qt.AlignHCenter); lay.addWidget(self.title); lay.addWidget(self.text)
        lay.addSpacing(8); lay.addWidget(self.ok, 0, Qt.AlignHCenter)
        self.auto = QTimer(self); self.auto.setSingleShot(True); self.auto.timeout.connect(self.dismiss)

    def show_prompt(self, title, text, secs=12):
        self.title.setText(title); self.text.setText(text)
        self.setGeometry(self.parentWidget().rect()); self._place()
        self.fade.stop(); self.fx.setOpacity(0.0); self.show(); self.raise_()
        self.fade.setStartValue(0.0); self.fade.setEndValue(1.0); self.fade.start()
        self.auto.start(int(secs * 1000))

    def _place(self):
        lay = self.card.layout(); lay.activate()
        self.card.setFixedHeight(max(lay.totalHeightForWidth(self.card.width()), lay.sizeHint().height()))   # room for wrapped text
        self.card.move((self.width() - self.card.width()) // 2, (self.height() - self.card.height()) // 2)

    def resizeEvent(self, e):
        self._place(); super().resizeEvent(e)

    def paintEvent(self, _):
        QPainter(self).fillRect(self.rect(), QColor(30, 8, 12, 170))

    def mousePressEvent(self, e):
        if not self.card.geometry().contains(e.position().toPoint()): self.dismiss()

    def dismiss(self):
        if not self.isVisible(): return
        self.auto.stop(); self.fade.stop(); self.hide(); self.closed.emit()


class ConfirmOverlay(PromptOverlay):
    """'Are you still continuing this order?' It has no OK button and ignores clicks:
    it only goes away when the student taps their card or the countdown runs out."""
    def __init__(self, parent):
        super().__init__(parent)
        self.ok.hide(); self.icon.setText("?")
        self.count = QLabel(); self.count.setAlignment(Qt.AlignCenter); self.count.setWordWrap(True)
        self.count.setFixedHeight(52)
        self.card.layout().insertWidget(3, self.count)
        self._left, self._note = 0, ""

    def show_confirm(self, left):
        self.title.setText("Are you still continuing this order?")
        self.text.setText("Please tap your RFID card to continue.\nNo payment will be made. This only confirms you are still here.")
        self._note = ""; self.set_left(left)
        self.setGeometry(self.parentWidget().rect()); self._place()
        self.fade.stop(); self.fx.setOpacity(0.0); self.show(); self.raise_()
        self.fade.setStartValue(0.0); self.fade.setEndValue(1.0); self.fade.start()

    def set_left(self, n):
        self._left = n; self._render()

    def set_note(self, text):
        self._note = text; self._render()
        QTimer.singleShot(3000, self._clear_note)

    def _clear_note(self):
        self._note = ""; self._render()

    def _render(self):
        if self._note:
            self.count.setText(self._note); self.count.setStyleSheet("color:#8E1B1B;font-size:15px;font-weight:700;")
        else:
            self.count.setText(f"Session ends in {self._left}s"); self.count.setStyleSheet(f"color:{MAROON};font-size:20px;font-weight:800;")

    def hide_now(self):
        self.fade.stop(); self.hide()

    def mousePressEvent(self, e):
        pass


# ---------------------------------------------------------------- greeting screen
class PopLogo(QWidget):
    """TAPMATE logo that pops in (scale + fade, with a soft overshoot)."""
    def __init__(self, pixmap=None):
        super().__init__()
        self.pm, self._scaled, self._s = pixmap, None, 0.0
        self.anim = QPropertyAnimation(self, b"pop", self)
        self.anim.setDuration(1000); self.anim.setStartValue(0.0); self.anim.setEndValue(1.0)
        self.anim.setEasingCurve(QEasingCurve.OutBack)

    def _get(self): return self._s
    def _set(self, v): self._s = v; self.update()
    pop = Property(float, _get, _set)

    def play(self):
        self.anim.stop(); self._set(0.0); self.anim.start()

    def resizeEvent(self, e):
        if self.pm and not self.pm.isNull():
            self._scaled = self.pm.scaled(self.width() - 20, self.height() - 20, Qt.KeepAspectRatio, Qt.SmoothTransformation)
        super().resizeEvent(e)

    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform | QPainter.TextAntialiasing)
        s = max(self._s, 0.0)
        p.setOpacity(min(1.0, s * 1.8))
        p.translate(self.width() / 2, self.height() / 2); p.scale(s, s)
        if self._scaled:
            p.drawPixmap(QPointF(-self._scaled.width() / 2, -self._scaled.height() / 2), self._scaled)
        else:
            f = QFont(self.font()); f.setPointSize(54); f.setBold(True); f.setLetterSpacing(QFont.AbsoluteSpacing, 6)
            p.setFont(f); p.setPen(QColor(GOLD_LT))
            p.drawText(QRectF(-self.width() / 2, -self.height() / 2, self.width(), self.height()), Qt.AlignCenter, "TAPMATE")


class FloatText(QWidget):
    """Text that fades in and out smoothly while it floats up and down."""
    def __init__(self, text):
        super().__init__()
        self.text, self._t, self._in, self._pending = text, 0.0, 0.0, False
        self.setFixedHeight(80)
        self.loop = QVariantAnimation(self); self.loop.setStartValue(0.0); self.loop.setEndValue(1.0)
        self.loop.setDuration(2800); self.loop.setLoopCount(-1); self.loop.setEasingCurve(QEasingCurve.Linear)
        self.loop.valueChanged.connect(self._tick)
        self.fade = QVariantAnimation(self); self.fade.setStartValue(0.0); self.fade.setEndValue(1.0)
        self.fade.setDuration(700); self.fade.valueChanged.connect(self._fade)

    def _tick(self, v): self._t = v; self.update()
    def _fade(self, v): self._in = v; self.update()

    def start(self, delay=0):
        self.stop(); self._in = 0.0; self._pending = True
        QTimer.singleShot(delay, self._go)

    def _go(self):
        if self._pending:
            self.loop.start(); self.fade.start()

    def stop(self):
        self._pending = False; self.loop.stop(); self.fade.stop()

    def paintEvent(self, _):
        p = QPainter(self); p.setRenderHint(QPainter.TextAntialiasing)
        wave = math.sin(self._t * 2 * math.pi)
        p.setOpacity(self._in * (0.30 + 0.70 * (0.5 + 0.5 * wave)))
        f = QFont(self.font()); f.setPointSize(20); f.setWeight(QFont.DemiBold); f.setLetterSpacing(QFont.AbsoluteSpacing, 1.5)
        p.setFont(f); p.setPen(QColor(GOLD_LT))
        p.drawText(QRectF(0, 18 - 8 * wave, self.width(), 44), Qt.AlignCenter, self.text)


class GreetingScreen(QWidget):
    """Full-window screen shown while no student is using the kiosk (camera is OFF here)."""
    def __init__(self, logo_path=None):
        super().__init__()
        lay = QVBoxLayout(self); lay.setContentsMargins(60, 40, 60, 40); lay.setSpacing(0)
        self.logo = PopLogo(QPixmap(logo_path) if logo_path else None); self.logo.setFixedSize(560, 230)
        self.prompt = FloatText("Tap your RFID to start.")
        self.hello = QLabel(); self.info = QLabel(); self.status = QLabel()
        for lb, css in ((self.hello, f"font-size:44px;font-weight:800;color:{GOLD_LT};"),
                        (self.info, "font-size:24px;color:#F4E9EA;"),
                        (self.status, "font-size:16px;font-weight:700;color:#F4E9EA;")):
            lb.setStyleSheet(css); lb.setAlignment(Qt.AlignCenter); lb.setWordWrap(True); lb.hide()
        lay.addStretch(3); lay.addWidget(self.logo, 0, Qt.AlignHCenter); lay.addSpacing(10)
        lay.addWidget(self.prompt); lay.addWidget(self.hello); lay.addSpacing(10); lay.addWidget(self.info)
        lay.addSpacing(14); lay.addWidget(self.status); lay.addStretch(4)
        self.status_timer = QTimer(self); self.status_timer.setSingleShot(True)
        self.status_timer.timeout.connect(lambda: self.set_status(""))

    def show_idle(self, ready=True, replay=True):
        self.hello.hide(); self.info.hide(); self.set_status("")
        if replay: self.logo.play()
        if ready:
            self.prompt.show(); self.prompt.start(delay=900 if replay else 0)
        else:
            self.prompt.stop(); self.prompt.hide()

    def show_welcome(self, hello, info):
        self.prompt.stop(); self.prompt.hide(); self.set_status("")
        self.hello.setText(hello); self.info.setText(info); self.hello.show(); self.info.show()

    def set_status(self, text, error=False, secs=0):
        self.status_timer.stop()
        self.status.setText(text)
        self.status.setStyleSheet(f"font-size:16px;font-weight:700;color:{'#FFB4B4' if error else '#F4E9EA'};")
        self.status.setVisible(bool(text))
        if text and secs: self.status_timer.start(int(secs * 1000))

    def paintEvent(self, _):
        p = QPainter(self)
        g = QLinearGradient(0, 0, 0, self.height()); g.setColorAt(0, QColor(MAROON)); g.setColorAt(1, QColor(MAROON_DK))
        p.fillRect(self.rect(), g)
        glow = QRadialGradient(QPointF(self.logo.geometry().center()), 420)
        glow.setColorAt(0, QColor(201, 162, 39, 60)); glow.setColorAt(1, QColor(201, 162, 39, 0))
        p.fillRect(self.rect(), glow)
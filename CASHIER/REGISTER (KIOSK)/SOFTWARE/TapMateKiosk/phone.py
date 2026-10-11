"""Phone link. After a student taps their card the kiosk shows a QR code. Scanning it opens a small web page
(served by this program, over the local network) where the student can review and remove items and then confirm
the order with their PIN. No app to install, works with iPhone Safari.

Safety rules:
  * Every session gets a fresh random token. It is only valid while that student is signed in at the kiosk.
  * The HTTP threads never touch the UI. Each request is handed to the main thread through `PhoneHub`.
"""
import hmac, json, secrets, socket, threading
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time

import requests
from PySide6.QtCore import QObject, Signal

import os
from phone_page import ENDED_PAGE

DEFAULTS = {"enabled": True, "required": True, "host": "", "port": 8765, "pin_length": 4,
            "mode": "web", "page_url": ""}
KINDS = {"state", "remove", "begin_pin", "cancel_pin", "pay"}


BLANK_PAGE = ("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
              "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>TapMate</title></head><body></body></html>")


TALLY_FILES = {"order_tally_PIN.html": "text/html; charset=utf-8",
               "order_tally_PIN.css": "text/css; charset=utf-8",
               "order_tally_PIN.js": "application/javascript; charset=utf-8"}


def tally_file(name):
    """Reads order_tally_PIN.html / .css / .js fresh on every request. An empty .html shows as a blank page."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), name), "rb") as f:
            data = f.read()
    except OSError:
        data = b""
    if name.endswith(".html") and not data.strip():
        data = BLANK_PAGE.encode()
    return data


LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "phone_debug.log")


def dbg(msg):
    """Tiny debug log next to phone.py (tokens are masked). Never raises."""
    try:
        if os.path.isfile(LOG_PATH) and os.path.getsize(LOG_PATH) > 200_000:
            os.remove(LOG_PATH)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + msg + "\n")
    except Exception:
        pass


class _Server(ThreadingHTTPServer):
    """On Windows, SO_REUSEADDR lets TWO programs listen on the same port and connections then go to either one
    (the other may be an old, stuck kiosk). Bind exclusively instead, so a second copy fails loudly."""
    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        import traceback
        last = traceback.format_exc().strip().splitlines()[-1]
        if last.endswith("tls"): return                      # the deliberate close of an https attempt, already logged
        dbg("ERROR from %s: %s" % (client_address[0], last))


def settings(cfg):
    return {**DEFAULTS, **(cfg.get("phone") or {})}


def lan_ip():
    """The address the iPhone should use. Opens no connection: a UDP 'connect' only picks the outgoing interface."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class PhoneHub(QObject):
    """Lives on the main thread. HTTP threads emit `request`; the slot connected in MainWindow runs on the UI thread."""
    request = Signal(str, object, object)          # kind, body (dict), reply(code, dict)


class PhoneServer:
    def __init__(self, cfg):
        self.s = settings(cfg)
        self.hub = PhoneHub()
        self.token = None
        self.last_seen = 0.0
        self.opened = False
        self.opened_at = 0.0
        self._httpd = None

    # ---- lifecycle ----
    def start(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            timeout = 20                           # idle / half-open connections (Safari opens several) are dropped after 20 s

            def setup(self):
                super().setup()
                # Safari may try https:// first. A TLS hello is not HTTP: close it at once so Safari falls back to
                # plain http:// right away instead of waiting for an answer that never comes.
                try:
                    self.connection.settimeout(2)
                    first = self.connection.recv(1, socket.MSG_PEEK)
                    if first == b"\x16":
                        dbg("HTTPS (TLS) attempt from %s: closed so the browser retries over http" % self.client_address[0])
                        self.connection.close()
                        raise ConnectionError("tls")
                except socket.timeout:
                    pass                           # idle connection, normal
                except OSError as e:
                    if isinstance(e, ConnectionError): raise
                self.connection.settimeout(self.timeout)

            def log_message(self, *a): pass        # never log URLs (they contain the session token)

            def _send(self, code, body, ctype="application/json; charset=utf-8", location=None):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                if location: self.send_header("Location", location)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(data)

            def _route(self, method):
                parts = [p for p in self.path.split("?")[0].split("/") if p]
                tok = outer.token
                dbg("%s %s from %s" % (method, "/" + "/".join("<token>" if (i == 0 and tok and x == tok) else x
                                                              for i, x in enumerate(parts)), self.client_address[0]))
                if parts == ["ping"] and method == "GET":        # test page: http://<kiosk-ip>:8765/ping
                    return self._send(200, b"TapMate kiosk phone link is reachable.", "text/plain; charset=utf-8")
                if not parts or not tok or not hmac.compare_digest(parts[0].encode(), tok.encode()):
                    if method == "GET" and len(parts) <= 1:
                        return self._send(410, ENDED_PAGE.encode(), "text/html; charset=utf-8")
                    return self._send(410, {"ok": False, "reason": "ended"})
                if len(parts) == 1 and method == "GET":          # /<token>  ->  /<token>/order_tally_PIN.html
                    return self._send(302, b"", "text/plain", location=f"/{tok}/order_tally_PIN.html")
                if len(parts) == 2 and method == "GET" and parts[1] in TALLY_FILES:
                    self._send(200, tally_file(parts[1]), TALLY_FILES[parts[1]])
                    if parts[1].endswith(".html") and outer.token == tok:
                        # Mark the phone as connected only AFTER the page has been fully sent. Connecting starts the
                        # camera + AI model on the kiosk, and that can stall the whole program for a few seconds.
                        outer.opened_at = time.monotonic(); outer.opened = True
                    return
                kind = parts[1] if len(parts) == 2 else ""
                if kind not in KINDS or (kind == "state") != (method == "GET"):
                    return self._send(404, {"ok": False, "reason": "not_found"})
                body = {}
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    if n > 2048:
                        return self._send(413, {"ok": False, "reason": "too_big"})
                    try:
                        body = json.loads(self.rfile.read(n) or b"{}")
                        if not isinstance(body, dict): raise ValueError
                    except ValueError:
                        return self._send(400, {"ok": False, "reason": "bad_request"})
                if kind == "state":
                    outer.last_seen = time.monotonic()
                code, data = outer.ask(kind, body)
                self._send(code, data)

            def do_GET(self): self._route("GET")
            def do_POST(self): self._route("POST")

        self._httpd = _Server(("0.0.0.0", int(self.s["port"])), Handler)
        dbg("server listening on port %s (pid %s)" % (self.s["port"], os.getpid()))
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def stop(self):
        self.token = None
        if self._httpd:
            self._httpd.shutdown(); self._httpd.server_close(); self._httpd = None

    # ---- sessions ----
    def new_session(self):
        self.token = secrets.token_urlsafe(16); self.last_seen = 0.0; self.opened = False; self.opened_at = 0.0
        return self.token

    def revoke(self):
        self.token = None; self.last_seen = 0.0; self.opened = False; self.opened_at = 0.0

    def url(self):
        host = self.s["host"] or lan_ip()
        return f"http://{host}:{self.s['port']}/{self.token}" if self.token else ""

    def connected(self):
        return self.token is not None and ((self.opened and time.monotonic() - self.opened_at > 1.5) or time.monotonic() - self.last_seen < 4)

    # ---- bridge to the UI thread ----
    def ask(self, kind, body):
        fut = Future()
        def reply(code, data):
            if not fut.done(): fut.set_result((code, data))
        self.hub.request.emit(kind, body, reply)
        try:
            return fut.result(timeout=25)
        except Exception:
            return 503, {"ok": False, "reason": "timeout", "message": "The kiosk didn't answer in time. Try again."}


class PhoneWeb:
    """Phone link through Supabase + your website (phone.mode = "web").
    The QR code opens phone.page_url (your GitHub Pages order_tally_PIN.html) with ?s=<session code>. That page tells
    Supabase "this session's phone arrived" (kiosk_phone_connect) and this class notices it by polling
    kiosk_phone_status once a second in a background thread. It has the same interface as PhoneServer, so main.py
    does not care which one it is talking to. The phone never needs to reach this PC, so no firewall / Wi-Fi setup."""

    def __init__(self, cfg):
        self.s = settings(cfg)
        self.base, self.key = cfg["supabase_url"], cfg["supabase_key"]
        self.hub = PhoneHub()                      # carries the phone's "remove" requests to the UI thread
        self.token = None
        self.last_seen = 0.0
        self.opened = False
        self.opened_at = 0.0
        self._run = False
        self._wake = threading.Event()
        self._state = None                         # latest order snapshot from the kiosk (set by push_state)
        self._pushed = None                        # the snapshot Supabase already has
        self._phase = ("browse", 0.0, 4)           # what the phone should show: order tally ("browse") or PIN entry ("pin")
        self._phase_pushed = None

    def _rpc(self, name, **args):
        r = requests.post(f"{self.base}/rest/v1/rpc/{name}", timeout=8, json=args,
                          headers={"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        if not r.ok:
            raise RuntimeError(f"{name} -> HTTP {r.status_code}: {r.text[:160]}")
        return r.json()

    def start(self):
        self._run = True
        dbg("web phone link started; page_url=%r" % self.s.get("page_url"))
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self._run = False; self._wake.set()

    def _loop(self):
        while self._run:
            code = self.token
            try:
                if code and not self.opened:
                    d = self._rpc("kiosk_phone_status", p_code=code)
                    if self.token == code and isinstance(d, dict):
                        if not d.get("exists"):
                            self._rpc("kiosk_phone_open", p_code=code); dbg("session registered")
                        elif d.get("connected"):
                            self.opened_at = time.monotonic(); self.opened = True; dbg("phone connected")
                elif code and self.opened:
                    st = self._state
                    sig = json.dumps(st, sort_keys=True) if st else None
                    if st and sig != self._pushed:                       # send the order only when it changed
                        self._rpc("kiosk_phone_push", p_code=code, p_student=st.get("student", ""),
                                  p_currency=st.get("currency", ""), p_items=st.get("items", []), p_total=st.get("total", 0))
                        if self.token == code: self._pushed = sig
                    ph = self._phase
                    if ph != self._phase_pushed:                         # tally <-> PIN screen on the phone
                        self._rpc("kiosk_phone_set_phase", p_code=code, p_phase=ph[0], p_total=ph[1], p_pin_len=ph[2])
                        if self.token == code: self._phase_pushed = ph
                        dbg("phone phase -> %s" % ph[0])
                    if ph[0] == "pin" and self._phase_pushed == ph:      # PIN typed on the phone (never logged)
                        inp = self._rpc("kiosk_phone_take_input", p_code=code)
                        if isinstance(inp, dict) and self.token == code:
                            if inp.get("cancel"):
                                self.hub.request.emit("cancel_pin", {}, lambda *a: None)
                            elif inp.get("pin"):
                                dbg("phone sent a PIN")
                                self.hub.request.emit("pin", {"pin": str(inp["pin"])}, self._result_cb(code))
                    reqs = self._rpc("kiosk_phone_take_removals", p_code=code)
                    for r in (reqs if isinstance(reqs, list) else []):
                        if self.token != code: break
                        dbg("phone asked to remove %s%s" % (r.get("pid"), " (all)" if r.get("all") else ""))
                        self.hub.request.emit("remove", {"pid": r.get("pid"), "all": bool(r.get("all"))}, lambda *a: None)
            except Exception as e:
                dbg("web link error: %s" % e)
            self._wake.wait(0.3 if self._phase[0] == "pin" else 0.7); self._wake.clear()

    def _result_cb(self, code):
        """The kiosk's answer to a PIN (paid / wrong PIN / error) goes back to the phone through Supabase."""
        def reply(_code, data):
            def send():
                try: self._rpc("kiosk_phone_set_result", p_code=code, p_result=data)
                except Exception as e: dbg("result failed: %s" % e)
            threading.Thread(target=send, daemon=True).start()
        return reply

    def set_phase(self, phase, total=0, pin_len=4):
        """Called by the kiosk (UI thread): 'pin' = the phone switches to PIN entry, 'browse' = back to the order tally."""
        self._phase = (phase, float(total or 0), int(pin_len)); self._wake.set()

    def push_state(self, state):
        """Called by the kiosk (UI thread) with the current order: {student, currency, items[], total}."""
        self._state = state

    # ---- sessions ----
    def new_session(self):
        self.token = secrets.token_urlsafe(16); self.opened = False; self.opened_at = 0.0
        self._state = None; self._pushed = None; self._phase = ("browse", 0.0, 4); self._phase_pushed = None
        self._wake.set()                           # register the code right away
        return self.token

    def revoke(self):
        code = self.token
        self.token = None; self.opened = False; self.opened_at = 0.0; self._state = None; self._pushed = None
        self._phase = ("browse", 0.0, 4); self._phase_pushed = None
        if code:
            def close():
                try: self._rpc("kiosk_phone_close", p_code=code)
                except Exception as e: dbg("close failed: %s" % e)
            threading.Thread(target=close, daemon=True).start()

    def url(self):
        base = (self.s.get("page_url") or "").strip()
        if not self.token or not base: return ""
        return f"{base}{'&' if '?' in base else '?'}s={self.token}"

    def connected(self):
        return self.token is not None and self.opened


def make_server(cfg):
    """PhoneWeb (Supabase + your website) when phone.mode is "web", otherwise the old local-network PhoneServer."""
    return PhoneWeb(cfg) if settings(cfg)["mode"] == "web" else PhoneServer(cfg)
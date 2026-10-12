import threading, time
import requests

class ApiError(Exception):
    pass

# Never retried automatically: if the first attempt reached the server but the answer was lost, a retry could charge twice.
NO_RETRY = {"kiosk_checkout"}

class Api:
    """Thin Supabase client. Same headers the website uses: apikey + x-card-token."""
    def __init__(self, cfg):
        self.base = cfg["supabase_url"]
        self.key = cfg["supabase_key"]
        self.token = None
        self._lock = threading.Lock()
        self.http = requests.Session()

    def _headers(self):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if self.token:
            h["x-card-token"] = self.token
        return h

    def reset(self):
        """Throw away the pooled keep-alive connections. After a long idle spell (Wi-Fi power saving, a router that drops
        idle connections, the PC waking up) the old socket is dead and the first request on it fails."""
        with self._lock:
            old, self.http = self.http, requests.Session()
        try: old.close()
        except Exception: pass

    def _request(self, method, url, read_timeout=12, retries=2, **kw):
        delays = (0.4, 1.0)[:retries]
        for attempt in range(len(delays) + 1):
            try:
                return self.http.request(method, url, headers=self._headers(), timeout=(4, read_timeout), **kw)
            except requests.ConnectionError:                 # stale / dropped connection (includes connect timeouts)
                self.reset()
                if attempt >= len(delays): raise
                time.sleep(delays[attempt])                  # then retry on a brand-new connection
            except requests.RequestException:                # read timeout etc.: not retried, but don't reuse that socket
                self.reset()
                raise

    def rpc(self, name, _timeout=12, **args):
        try:
            r = self._request("POST", f"{self.base}/rest/v1/rpc/{name}", read_timeout=_timeout,
                              retries=0 if name in NO_RETRY else 2, json={"p_token": self.token, **args})
        except requests.RequestException:
            raise ApiError("Can't reach the server. Check the internet connection.")
        if not r.ok:
            try:
                body = r.json()
                detail = body.get("message") or body.get("hint") or ""
            except ValueError:
                detail = r.text[:200]
            if r.status_code == 404:
                detail = f"Function {name} was not found on the server. {detail}".strip()
            raise ApiError(f"Server error ({r.status_code}): {detail or 'no details'}")
        return r.json()

    def products(self):
        try:
            r = self._request("GET", f"{self.base}/rest/v1/products", params={
                "select": "id,name,price,image_url,yolo_label", "status": "eq.active", "order": "name"})
        except requests.RequestException:
            raise ApiError("Can't reach the server. Check the internet connection.")
        if not r.ok:
            raise ApiError(f"Couldn't load products ({r.status_code}). Did you run kiosk_v8.sql?")
        return [{**p, "price": float(p["price"])} for p in r.json()]
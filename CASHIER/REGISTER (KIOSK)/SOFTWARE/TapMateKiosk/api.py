import requests

class ApiError(Exception):
    pass

class Api:
    """Thin Supabase client. Same headers the website uses: apikey + x-card-token."""
    def __init__(self, cfg):
        self.base = cfg["supabase_url"]
        self.key = cfg["supabase_key"]
        self.token = None
        self.http = requests.Session()

    def _headers(self):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if self.token:
            h["x-card-token"] = self.token
        return h

    def rpc(self, name, _timeout=12, **args):
        try:
            r = self.http.post(f"{self.base}/rest/v1/rpc/{name}", headers=self._headers(),
                               json={"p_token": self.token, **args}, timeout=_timeout)
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
            r = self.http.get(f"{self.base}/rest/v1/products", headers=self._headers(), timeout=12, params={
                "select": "id,name,price,image_url,yolo_label", "status": "eq.active", "order": "name"})
        except requests.RequestException:
            raise ApiError("Can't reach the server. Check the internet connection.")
        if not r.ok:
            raise ApiError(f"Couldn't load products ({r.status_code}). Did you run kiosk_v8.sql?")
        return [{**p, "price": float(p["price"])} for p in r.json()]
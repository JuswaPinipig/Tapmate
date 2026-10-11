import json, os, sys

def app_dir():
    return os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else os.path.dirname(os.path.abspath(__file__))

DEFAULTS = {
    "supabase_url": "", "supabase_key": "", "currency": "₱",
    "model_path": "models/best.pt", "camera_index": 0, "camera_width": 1280, "camera_height": 720,
    "confidence": 0.60, "confirm_frames": 6, "image_size": 640,
    "idle_seconds": 30, "confirm_seconds": 30,
    "rfid": {"mode": "keyboard", "serial_port": "COM3", "baud": 9600}, "fullscreen": False,
    "phone": {"enabled": True, "required": True, "host": "", "port": 8765, "pin_length": 4,
              "mode": "web", "page_url": ""},
}

def load():
    cfg = dict(DEFAULTS)
    with open(os.path.join(app_dir(), "config.json"), encoding="utf-8") as f:
        for k, v in json.load(f).items():
            cfg[k] = {**cfg[k], **v} if isinstance(v, dict) and isinstance(cfg.get(k), dict) else v
    cfg["supabase_url"] = cfg["supabase_url"].rstrip("/")
    if not os.path.isabs(cfg["model_path"]):
        cfg["model_path"] = os.path.join(app_dir(), cfg["model_path"])
    return cfg
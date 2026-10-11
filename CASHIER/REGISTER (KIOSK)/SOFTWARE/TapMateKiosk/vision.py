import os, time
import cv2
from PySide6.QtCore import QThread, Signal
from PySide6.QtGui import QImage


_MODELS = {}      # YOLO weights are loaded once and reused every time the camera is switched on again


def _try_open(index, backend, width, height):
    """Open one camera index with one backend at one resolution. Returns an opened capture or None."""
    cap = cv2.VideoCapture(index, backend)
    if not cap.isOpened():
        cap.release()
        return None
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    for _ in range(15):                     # webcams often need a moment before the first real frame
        ok, _frame = cap.read()
        if ok and _frame is not None:
            return cap
        time.sleep(0.1)
    cap.release()
    return None


def open_camera(c):
    """Tries the configured camera first, then other indexes; DirectShow then Media Foundation;
    the configured resolution then 640x480. Returns (cap, description) or (None, None)."""
    backends = [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)] if os.name == "nt" else [("ANY", cv2.CAP_ANY)]
    sizes = [(int(c["camera_width"]), int(c["camera_height"]))]
    if sizes[0] != (640, 480):
        sizes.append((640, 480))
    first = int(c["camera_index"])
    indexes = [first] + [i for i in range(5) if i != first]
    for idx in indexes:
        for bname, backend in backends:
            for (w, h) in sizes:
                cap = _try_open(idx, backend, w, h)
                if cap:
                    return cap, f"camera {idx} ({bname}, {w}x{h})"
    return None, None


class Vision(QThread):
    """Camera + YOLO tracking. Emits `detected(label)` ONCE per physical item (per tracker ID).
    It only ever ADDS items. Nothing here can remove one: removal lives in the cashier's buttons."""
    frame = Signal(QImage)
    detected = Signal(str)
    status = Signal(str, bool)          # message, is_error

    def __init__(self, cfg):
        super().__init__()
        self.cfg = cfg
        self.known = set()              # normalised labels that match a product (drawn green)
        self._run = True

    def stop(self):
        self._run = False
        self.wait(4000)

    def run(self):
        c = self.cfg
        model = _MODELS.get(c["model_path"])
        if model is None and os.path.isfile(c["model_path"]):
            try:
                from ultralytics import YOLO
                model = _MODELS[c["model_path"]] = YOLO(c["model_path"])
            except Exception as e:
                self.status.emit(f"AI model failed to load: {e}", True)
        elif model is None:
            self.status.emit(f"AI model not found at {c['model_path']}", True)

        cap, desc = open_camera(c)
        if cap is None:
            self.status.emit("Camera not found or in use by another program. Close other apps using the "
                             "webcam, end leftover python/pythonw processes, then try again.", True)
            return
        if model:
            try:                                            # forget tracker IDs left over from the previous student
                for t in getattr(model.predictor, "trackers", None) or []:
                    t.reset()
            except Exception:
                pass
            self.status.emit(f"Camera and AI ready: {desc}", False)
        else:
            self.status.emit(f"Camera ready: {desc}", False)

        streak, counted, last_seen = {}, set(), time.time()
        while self._run:
            ok, img = cap.read()
            if not ok:
                time.sleep(0.05)
                continue
            if model:
                try:
                    r = model.track(img, persist=True, conf=c["confidence"], imgsz=c["image_size"],
                                    tracker="bytetrack.yaml", verbose=False)[0]
                    ids = r.boxes.id
                    cur = set()
                    for i, box in enumerate(r.boxes):
                        label = r.names[int(box.cls)]
                        # No box or label is drawn on the video any more. Detection and counting below are unchanged.
                        if ids is None:
                            continue
                        tid = int(ids[i]); cur.add(tid)
                        streak[tid] = streak.get(tid, 0) + 1
                        if streak[tid] >= c["confirm_frames"] and tid not in counted:
                            counted.add(tid)
                            self.detected.emit(label)
                    for k in [k for k in streak if k not in cur]:
                        del streak[k]
                    if cur:
                        last_seen = time.time()
                    elif time.time() - last_seen > 8 and len(counted) > 500:
                        counted.clear()
                except Exception as e:
                    self.status.emit(f"AI error: {e}", True)
                    model = None
            rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            h, w, ch = rgb.shape
            self.frame.emit(QImage(rgb.data, w, h, ch * w, QImage.Format.Format_RGB888).copy())
        cap.release()
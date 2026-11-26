"""
CampusX people counter (reads any connected webcam)
  python web_count3.py              -> run the counter (open http://localhost:5000)
  python web_count3.py --always     -> ignore the 9-15 working hours (for testing)
  python web_count3.py --calibrate  -> run ONCE with an EMPTY room to learn fixed "ghost" spots

CV_DETECTOR=auto (default) covers every direction with one count:
  1) head240.pt -> heads seen from above (top-down / ESP32-CAM)
  2) frontal face cascade -> faces on a front-facing webcam
  3) yolov8n.pt class 0 -> full person from the side / behind / any angle
CV_DETECTOR=head forces head240.pt only; CV_DETECTOR=person forces yolov8n.pt only.
The active source is reported as `source` in /json and in the dashboard status.
"""
import os, sys, time, json, csv, threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

# CV settings live next to this script so switching camera profiles does not
# require restarting the Node backend. override=True makes this file win over
# inherited process env (the backend spawns this script with its own .env).
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent / ".env", override=True)
except ImportError:
    pass

import cv2
import numpy as np
import requests
from flask import Flask, Response, jsonify
from ultralytics import YOLO

# ================== الإعدادات ==================
# CampusX settings come from the environment (the server loads .env into its
# child processes). CV_DETECTOR chooses a preset for the camera angle; any
# explicit CV_* variable below overrides that preset.
DETECTOR = os.getenv("CV_DETECTOR", "auto").strip().lower()
if DETECTOR not in ("auto", "person", "head"):
    raise SystemExit(f"CV_DETECTOR must be 'auto', 'person' or 'head', got {DETECTOR!r}")

PRESETS = {
    # Front-facing webcam: full COCO person boxes are what the webcam actually sees.
    "person": dict(model="yolov8n.pt", simulate240=False, conf_keep=0.20,
                   conf_new=0.40, min_hits=3, grace=10, smooth=5,
                   min_area=0.02, max_area=0.85, min_ratio=0.40, max_ratio=3.0,
                   label="people", class_filter=0),
    # Overhead / ESP32-CAM 240px: model trained to see only the top of heads.
    "head": dict(model="head240.pt", simulate240=True, conf_keep=0.20,
                 conf_new=0.40, min_hits=3, grace=10, smooth=5,
                 min_area=0.0002, max_area=0.10, min_ratio=0.5, max_ratio=2.5,
                 label="heads", class_filter=0),
    # All directions: head240 (top) -> face (front) -> person (side/back/any).
    "auto": dict(model="head240.pt", simulate240=True, conf_keep=0.20,
                 conf_new=0.40, min_hits=3, grace=10, smooth=5,
                 min_area=0.0002, max_area=0.10, min_ratio=0.5, max_ratio=2.5,
                 label="heads", class_filter=0),
}
P = PRESETS[DETECTOR]
BASE_SOURCE = "person" if DETECTOR == "person" else "head"


def env_int(name, default):
    return int(os.getenv(name, str(default)))


def env_float(name, default):
    return float(os.getenv(name, str(default)))


def env_bool(name, default):
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


MODEL_PATH = os.getenv("CV_MODEL_PATH", P["model"]).strip()
_cv_source = os.getenv("CV_SOURCE", "0").strip()
SOURCE = int(_cv_source) if _cv_source.isdigit() else _cv_source  # 0 = laptop webcam, URL = ESP32-CAM
HOST = os.getenv("CV_WEB_HOST", "127.0.0.1").strip()
PORT = env_int("CV_WEB_PORT", 5000)
TARGET_FPS = env_int("CV_TARGET_FPS", 5)
ACTIVE_FROM = env_int("CV_ACTIVE_FROM", 9)
ACTIVE_TO = env_int("CV_ACTIVE_TO", 15)
IMGSZ = env_int("CV_IMGSZ", 640)
CLASS_FILTER = env_int("CV_CLASS_FILTER", P["class_filter"])  # 0 = person (COCO) or head (head240)

CONF_KEEP = env_float("CV_CONF_KEEP", P["conf_keep"])   # أقل ثقة يتابعها التتبّع
CONF_NEW = env_float("CV_CONF_NEW", P["conf_new"])     # لازم تعدّي الثقة دي مرة على الأقل عشان تتحسب
MIN_HITS = env_int("CV_MIN_HITS", P["min_hits"])       # لازم تتشاف في كام صورة قبل التأكيد
GRACE = env_int("CV_GRACE", P["grace"])                 # لو اختفت كام صورة تفضل محسوبة
SMOOTH = env_int("CV_SMOOTH", P["smooth"])             # الرقم النهائي = وسيط آخر قراءات

MIN_AREA = env_float("CV_MIN_AREA", P["min_area"])     # حجم المربع (نسبة من الصورة)
MAX_AREA = env_float("CV_MAX_AREA", P["max_area"])
MIN_RATIO = env_float("CV_MIN_RATIO", P["min_ratio"])  # الطول / العرض
MAX_RATIO = env_float("CV_MAX_RATIO", P["max_ratio"])
LABEL = P["label"]                                     # "people" أو "heads"

MANUAL_ZONES = [                 # مناطق تتجاهلها يدوياً: (x1, y1, x2, y2) بنسبة من 0 لـ 1
    # (0.00, 0.00, 0.20, 0.30),
]
ZONES_FILE = os.getenv("CV_ZONES_FILE", "ignore_zones.json") # بيتعمل من --calibrate
CALIBRATE_SECONDS = env_int("CV_CALIBRATE_SECONDS", 30)
LOG_FILE = os.getenv("CV_LOG_FILE", "counts.csv")          # سجل العدد
LOG_EVERY = env_int("CV_LOG_EVERY", 60)                    # ثانية
# ===============================================

ALWAYS = "--always" in sys.argv or env_bool("CV_ALWAYS", True)
# الوب كام الأمامي بيتقرأ بحجمه الكامل؛ تصغير 240 مطلوب بس لكاميرا الـ ESP32 العلوية.
SIMULATE_240 = isinstance(SOURCE, int) and env_bool("CV_SIMULATE_240", P["simulate240"])
# head240.pt مدرّب على رؤوس من فوق. لو الكاميرا أمامية ومفيش كشف، نكمّل بوجوه أمامية،
# ولو الجنب/الخلف نكمّل بكاشف الأشخاص الكاملين (يشتغل في أي اتجاه).
FACE_FALLBACK = env_bool("CV_FACE_FALLBACK", True)
PERSON_FALLBACK = env_bool("CV_PERSON_FALLBACK", True)
PERSON_MODEL_PATH = os.getenv("CV_PERSON_MODEL", "yolov8n.pt").strip()
PERSON_CONF = env_float("CV_PERSON_CONF", 0.25)

# حدود مربعات الكاشفات المساعدة (مختلفة عن حدود رؤوس head240.pt)
FACE_MIN_AREA, FACE_MAX_AREA = env_float("CV_FACE_MIN_AREA", 0.01), env_float("CV_FACE_MAX_AREA", 0.40)
FACE_MIN_RATIO, FACE_MAX_RATIO = env_float("CV_FACE_MIN_RATIO", 0.6), env_float("CV_FACE_MAX_RATIO", 1.8)
PERSON_MIN_AREA, PERSON_MAX_AREA = env_float("CV_PERSON_MIN_AREA", 0.02), env_float("CV_PERSON_MAX_AREA", 0.90)
PERSON_MIN_RATIO, PERSON_MAX_RATIO = env_float("CV_PERSON_MIN_RATIO", 0.3), env_float("CV_PERSON_MAX_RATIO", 4.0)

model = YOLO(MODEL_PATH)
person_model = None  # lazy: أول استخدام بس، عشان الـ Start يفضل سريع


def get_person_model():
    global person_model
    if person_model is None:
        person_model = YOLO(PERSON_MODEL_PATH)
    return person_model


try:
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
except Exception:
    face_cascade = None
state = {"count": 0, "cand": 0, "status": "starting", "infer": 0.0, "fps": 0.0,
         "ts": "", "jpg": None, "raw_jpg": None, "fallback": False,
         "source": BASE_SOURCE, "log": []}


# ---------------------------- الكاميرا ----------------------------
class Camera:
    """بتقرا الصور طول الوقت في thread لوحدها، والعدّاد ياخد آخر صورة."""

    def __init__(self):
        self.frame, self.fid, self.lock = None, 0, threading.Lock()
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        use_cv = isinstance(SOURCE, int) or str(SOURCE).endswith("/stream")
        cap = None
        while True:
            try:
                if use_cv:
                    if cap is None or not cap.isOpened():
                        # DirectShow is for local USB/built-in cameras only.
                        # Network MJPEG streams (ESP32-CAM) need the default
                        # FFmpeg backend, otherwise VideoCapture fails to open.
                        backend = (cv2.CAP_DSHOW
                                   if (os.name == "nt" and isinstance(SOURCE, int))
                                   else cv2.CAP_ANY)
                        cap = cv2.VideoCapture(SOURCE, backend)
                        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    ok, f = cap.read()
                    if not ok:
                        cap.release(); cap = None
                        time.sleep(1)
                        continue
                else:
                    data = requests.get(SOURCE, timeout=3).content
                    f = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                    if f is None:
                        time.sleep(0.5)
                        continue
                    time.sleep(0.02)
                with self.lock:
                    self.frame, self.fid = f, self.fid + 1
            except Exception:
                time.sleep(1)

    def latest(self):
        with self.lock:
            return self.fid, (None if self.frame is None else self.frame.copy())


# ---------------------------- أدوات ----------------------------
def shrink_to_240(frame):
    h, w = frame.shape[:2]
    s = 240 / max(h, w)
    if s < 1:
        frame = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return frame


def iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def load_zones():
    zones = [list(z) for z in MANUAL_ZONES]
    p = Path(ZONES_FILE)
    if p.exists():
        try:
            zones += json.loads(p.read_text())
        except Exception:
            print("Could not read", ZONES_FILE)
    return zones


ZONES = load_zones()


def in_zone(cx, cy, w, h):
    return any(x1 * w <= cx <= x2 * w and y1 * h <= cy <= y2 * h for x1, y1, x2, y2 in ZONES)


def valid_box_for(x1, y1, x2, y2, w, h, min_area, max_area, min_ratio, max_ratio):
    bw, bh = x2 - x1, y2 - y1
    if bw <= 0 or bh <= 0:
        return False
    if not (min_area <= bw * bh / (w * h) <= max_area):
        return False
    if not (min_ratio <= bh / bw <= max_ratio):
        return False
    return not in_zone((x1 + x2) / 2, (y1 + y2) / 2, w, h)


def valid_box(x1, y1, x2, y2, w, h):
    return valid_box_for(x1, y1, x2, y2, w, h,
                         MIN_AREA, MAX_AREA, MIN_RATIO, MAX_RATIO)


# ---------------------------- المعايرة ----------------------------
def calibrate():
    """شغّليه والأوضة فاضية: أي حاجة الموديل بيشوفها كراس طول الوقت = شبح ثابت."""
    print(f"Calibrating for {CALIBRATE_SECONDS}s. Make sure the room is EMPTY...")
    cam = Camera()
    end, last_id, frames, clusters = time.time() + CALIBRATE_SECONDS, -1, 0, []
    while time.time() < end:
        fid, frame = cam.latest()
        if frame is None or fid == last_id:
            time.sleep(0.05)
            continue
        last_id = fid
        if SIMULATE_240:
            frame = shrink_to_240(frame)
        h, w = frame.shape[:2]
        res = model.predict(frame, classes=[CLASS_FILTER], conf=CONF_KEEP,
                            iou=0.5, imgsz=IMGSZ, verbose=False)[0]
        frames += 1
        for b in res.boxes.xyxy.tolist():
            nb = [b[0] / w, b[1] / h, b[2] / w, b[3] / h]
            for cl in clusters:
                if iou(nb, cl["box"]) > 0.3:
                    cl["n"] += 1
                    cl["box"] = [(a * (cl["n"] - 1) + x) / cl["n"] for a, x in zip(cl["box"], nb)]
                    break
            else:
                clusters.append({"box": nb, "n": 1})
    zones = []
    for cl in clusters:
        if frames and cl["n"] >= 0.3 * frames:      # ظهر في 30% من الصور على الأقل
            x1, y1, x2, y2 = cl["box"]
            pw, ph = (x2 - x1) * 0.25, (y2 - y1) * 0.25
            zones.append([max(0, x1 - pw), max(0, y1 - ph), min(1, x2 + pw), min(1, y2 + ph)])
    Path(ZONES_FILE).write_text(json.dumps(zones))
    print(f"Processed {frames} frames. Saved {len(zones)} ghost zone(s) to {ZONES_FILE}.")
    print("Now run:  python web_count3.py")


# ---------------------------- العدّاد ----------------------------
def loop():
    cam = Camera()
    tracks, recent, stamps = {}, deque(maxlen=SMOOTH), deque(maxlen=10)
    fi, last_id, last_new, last_log = 0, -1, time.time(), 0.0
    period = 1.0 / TARGET_FPS
    while True:
        t0 = time.time()
        now = datetime.now()
        if not ALWAYS and not (ACTIVE_FROM <= now.hour < ACTIVE_TO):
            state.update(count=0, cand=0, fps=0.0, infer=0.0, status="خارج وقت التشغيل")
            tracks.clear(); recent.clear(); stamps.clear()
            time.sleep(5)
            continue

        fid, frame = cam.latest()
        if frame is None or fid == last_id:
            if time.time() - last_new > 3:
                state["status"] = "مفيش صورة من الكاميرا"
            time.sleep(0.02)
            continue
        last_id, last_new = fid, time.time()
        full = frame
        state["raw_jpg"] = cv2.imencode(".jpg", full)[1].tobytes()
        if SIMULATE_240:
            frame = shrink_to_240(frame)
        h, w = frame.shape[:2]
        scale = w / full.shape[1] if full.shape[1] else 1.0

        t = time.time()
        res = model.track(frame, persist=True, tracker="bytetrack.yaml",
                          classes=[CLASS_FILTER], conf=CONF_KEEP, iou=0.5,
                          imgsz=IMGSZ, verbose=False)[0]
        ms = (time.time() - t) * 1000
        fi += 1

        seen = {}
        if res.boxes is not None and res.boxes.id is not None:
            for b, tid, c in zip(res.boxes.xyxy.tolist(), res.boxes.id.int().tolist(),
                                 res.boxes.conf.tolist()):
                if not valid_box(*b, w, h):
                    continue
                seen[tid] = (b, c)
                tr = tracks.setdefault(tid, {"hits": 0, "maxconf": 0.0, "last": fi, "box": b})
                tr["hits"] += 1
                tr["maxconf"] = max(tr["maxconf"], c)
                tr["last"], tr["box"] = fi, b

        # head240.pt بيشوف الرؤوس من فوق بس. عشان كده بنكمّل بكاشف وجوه أمامي،
        # ولو الجنب/الخلف بنكمّل بكاشف أشخاص كامل (أي اتجاه). كلهم يدخلوا نفس
        # الـ tracker عشان العدد والرسم يتطابقوا، والمصدر يتسجّل في /json.
        used_source = BASE_SOURCE

        if FACE_FALLBACK and not seen and face_cascade is not None:
            gray = cv2.cvtColor(full, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.1, 3, minSize=(60, 60))
            for i, (x, y, fw, fh) in enumerate(faces):
                box = [x * scale, y * scale, (x + fw) * scale, (y + fh) * scale]
                if not valid_box_for(*box, w, h, FACE_MIN_AREA, FACE_MAX_AREA,
                                     FACE_MIN_RATIO, FACE_MAX_RATIO):
                    continue
                used_source = "face"
                tid, conf = 10000 + i, 0.99
                seen[tid] = (box, conf)
                tr = tracks.setdefault(tid, {"hits": 0, "maxconf": 0.0, "last": fi, "box": box})
                tr["hits"] += 1
                tr["maxconf"] = max(tr["maxconf"], conf)
                tr["last"], tr["box"] = fi, box

        if PERSON_FALLBACK and not seen and DETECTOR != "person":
            # yolov8n.pt class 0 = person: بيشوف الجسم في أي زاوية (أمام/جنب/خلف)
            try:
                pres = get_person_model().predict(full, classes=[0], conf=PERSON_CONF,
                                                  imgsz=IMGSZ, verbose=False)[0]
                boxes = pres.boxes
                if boxes is not None:
                    for i, b in enumerate(boxes.xyxy.tolist()):
                        box = [v * scale for v in b]
                        if not valid_box_for(*box, w, h, PERSON_MIN_AREA, PERSON_MAX_AREA,
                                             PERSON_MIN_RATIO, PERSON_MAX_RATIO):
                            continue
                        used_source = "person"
                        tid, conf = 20000 + i, float(boxes.conf[i])
                        seen[tid] = (box, conf)
                        tr = tracks.setdefault(tid, {"hits": 0, "maxconf": 0.0, "last": fi, "box": box})
                        tr["hits"] += 1
                        tr["maxconf"] = max(tr["maxconf"], conf)
                        tr["last"], tr["box"] = fi, box
            except Exception as exc:
                state["log"] = (state["log"] + [f"person fallback error: {exc}"])[-5:]

        used_fallback = used_source != BASE_SOURCE

        for tid in [k for k, v in tracks.items() if fi - v["last"] > GRACE * 4]:
            del tracks[tid]

        def confirmed(tr):
            return tr["hits"] >= MIN_HITS and tr["maxconf"] >= CONF_NEW

        # لو اتنين tracks مؤكدين فوق بعض (نفس الراس بـ ID مختلف) نعدّهم واحد
        active = sorted(((tid, tr) for tid, tr in tracks.items()
                         if confirmed(tr) and fi - tr["last"] <= GRACE),
                        key=lambda kv: -kv[1]["hits"])
        kept = []
        for tid, tr in active:
            if all(iou(tr["box"], o["box"]) < 0.3 for _, o in kept):
                kept.append((tid, tr))
        recent.append(len(kept))
        smooth = int(np.median(recent))
        kept_ids = {tid for tid, _ in kept}

        stamps.append(time.time())
        fps = (len(stamps) - 1) / (stamps[-1] - stamps[0]) if len(stamps) > 1 else 0.0

        # الرسم على نسخة مكبّرة للعرض فقط
        k = 640 / max(h, w)
        vis = cv2.resize(frame, None, fx=k, fy=k, interpolation=cv2.INTER_LINEAR)
        for tid, (b, c) in seen.items():
            if tid not in kept_ids:                              # رمادي = مرشّح لسه
                x1, y1, x2, y2 = [int(v * k) for v in b]
                cv2.rectangle(vis, (x1, y1), (x2, y2), (130, 130, 130), 1)
        for tid, tr in kept:
            x1, y1, x2, y2 = [int(v * k) for v in tr["box"]]
            col = (0, 255, 0) if tr["last"] == fi else (0, 255, 255)   # أخضر = شايفاه الآن، أصفر = اختفى لحظة
            cv2.rectangle(vis, (x1, y1), (x2, y2), col, 2)
            cv2.putText(vis, f"{tr['maxconf']:.2f}", (x1, max(y1 - 4, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
        for x1, y1, x2, y2 in ZONES:
            cv2.rectangle(vis, (int(x1 * w * k), int(y1 * h * k)),
                          (int(x2 * w * k), int(y2 * h * k)), (0, 0, 255), 1)
        headline = f"{LABEL} {smooth} [{used_source}]"
        cv2.putText(vis, headline, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

        state["jpg"] = cv2.imencode(".jpg", vis)[1].tobytes()
        state.update(count=smooth, cand=len([t for t in seen if t not in kept_ids]),
                     status="يعمل", fallback=used_fallback, source=used_source,
                     infer=round(ms, 1), fps=round(fps, 1),
                     ts=datetime.now(timezone.utc).isoformat())
        state["log"] = (state["log"] + [f"{now:%H:%M:%S} count={smooth} raw={len(kept)} "
                                        f"infer={ms:.0f}ms fps={fps:.1f}"])[-5:]

        if time.time() - last_log >= LOG_EVERY:
            last_log = time.time()
            new = not Path(LOG_FILE).exists()
            with open(LOG_FILE, "a", newline="", encoding="utf-8") as f:
                wr = csv.writer(f)
                if new:
                    wr.writerow(["time", LABEL])
                wr.writerow([now.strftime("%Y-%m-%d %H:%M:%S"), smooth])

        time.sleep(max(0.0, period - (time.time() - t0)))


# ---------------------------- الصفحة ----------------------------
app = Flask(__name__)

PAGE = """<body style="background:#111;color:#ddd;font-family:monospace;padding:20px">
<h1 id="n" style="color:#5f5;font-size:52px;margin:0">0 __LABEL__</h1>
<p id="s">...</p>
<p id="view">Camera + detections (__MODEL__)</p>
<img src="/video" width="640" style="background:#000;max-width:100%"><br>
<p>log:<br><span id="log"></span></p>
<a href="/json">json</a> <a href="/frame">frame</a> <a href="/health">health</a>
<script>
async function tick(){
  try{
    const d = await (await fetch('/json')).json();
    document.getElementById('n').textContent = d.count + ' ' + d.label + (d.count==1?'':'s');
    document.getElementById('s').textContent = 'status=' + d.status + ' | fps=' + d.fps +
      ' | candidates=' + d.candidates + ' | infer=' + d.infer_ms + 'ms' +
      ' | detector=' + d.detector + ' (' + d.model + ') | source=' + (d.source || d.detector) +
      (d.face_fallback ? ' [fallback]' : '');
    document.getElementById('log').innerHTML = d.log.join('<br>');
  }catch(e){}
}
setInterval(tick, 500); tick();
</script></body>""".replace("__LABEL__", LABEL).replace("__MODEL__", MODEL_PATH)


@app.route("/")
def index():
    return PAGE


def gen():
    while True:
        if state["jpg"]:
            yield (b"--f\r\nContent-Type: image/jpeg\r\n\r\n" + state["jpg"] + b"\r\n")
        time.sleep(0.1)


@app.route("/video")
def video():
    return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=f")


def gen_raw():
    while True:
        if state["raw_jpg"]:
            yield (b"--f\r\nContent-Type: image/jpeg\r\n\r\n" + state["raw_jpg"] + b"\r\n")
        time.sleep(0.1)


@app.route("/rawstream")
def rawstream():
    return Response(gen_raw(), mimetype="multipart/x-mixed-replace; boundary=f")


@app.route("/raw")
def raw():
    return Response(state["raw_jpg"] or b"", mimetype="image/jpeg")


@app.route("/frame")
def frame():
    return Response(state["jpg"] or b"", mimetype="image/jpeg")


@app.route("/json")
def js():
    # `raw` is kept as an alias so the existing CampusX MQTT bridge and older
    # dashboard readers keep working regardless of the active detector.
    return jsonify(count=state["count"], raw=state["count"], candidates=state["cand"],
                   status=state["status"], infer_ms=state["infer"], fps=state["fps"],
                   ts=state["ts"], log=state["log"], detector=DETECTOR,
                   model=MODEL_PATH, label=LABEL,
                   face_fallback=state["fallback"], source=state["source"])


@app.route("/health")
def health():
    return jsonify(status="ok")


if __name__ == "__main__":
    if "--calibrate" in sys.argv:
        calibrate()
    else:
        print(f"Detector={DETECTOR} model={MODEL_PATH} camera={SOURCE} "
              f"simulate240={SIMULATE_240} face_fallback={FACE_FALLBACK} "
              f"person_fallback={PERSON_FALLBACK} person_model={PERSON_MODEL_PATH} | "
              f"zones={len(ZONES)} | always={ALWAYS} | target fps={TARGET_FPS}")
        threading.Thread(target=loop, daemon=True).start()
        app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)

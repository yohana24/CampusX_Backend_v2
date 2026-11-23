import time, threading
from collections import deque
from datetime import datetime, timezone
import cv2
import numpy as np
import requests
from flask import Flask, Response, jsonify
from ultralytics import YOLO

# ================== الإعدادات ==================
SOURCE = 0                      # 0 = وب كام الكمبيوتر | "http://192.168.1.50/capture" = ESP32-CAM
ACTIVE_FROM, ACTIVE_TO = 0, 24  # يشتغل من 9 الصبح لـ 3 العصر (بتوقيت الجهاز)
IMGSZ = 640                 # صورة 240x240 بتتكبّر لـ 640 قبل الموديل

CONF_NEW = 0.45                 # أقل ثقة عشان شخص جديد يتحسب (إضاءة عالية = صورة واضحة)
CONF_KEEP = 0.25                # ثقة أقل بتكفي لمتابعة شخص اتأكد قبل كده
MIN_HITS = 3                    # لازم يتشاف في 3 فريمات على الأقل
GRACE = 6                       # لو اختفى كام فريم يفضل متحسوب (علشان الرمشة)
SMOOTH = 5                      # الرقم النهائي = وسيط آخر 5 قراءات

MIN_AREA = 0.0008               # أصغر مربع (نسبة من مساحة الصورة) ~ 46 بكسل في 240x240
MAX_AREA = 0.45                 # أكبر من كده غالباً غلط
MIN_RATIO, MAX_RATIO = 0.6, 5.0 # الطول / العرض: بيشيل المربعات العريضة جداً أو الرفيعة جداً

# مناطق تتجاهلها (شباك، مراية، بوستر، شاشة): (x1, y1, x2, y2) بنسبة من 0 لـ 1
IGNORE_ZONES = [
    # (0.00, 0.00, 0.20, 0.30),
]
# ===============================================

model = YOLO("head240.pt")
cap = cv2.VideoCapture(SOURCE) if isinstance(SOURCE, int) else None
state = {"count": 0, "cand": 0, "status": "starting", "infer": 0.0, "ts": "",
         "jpg": None, "log": []}


def read_frame():
    if cap is not None:
        ok, frame = cap.read()
        return frame if ok else None
    try:
        data = requests.get(SOURCE, timeout=3).content
        return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        return None


def upscale(frame):
    h, w = frame.shape[:2]
    s = IMGSZ / max(h, w)
    if s > 1:
        frame = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    return frame


def in_ignore_zone(cx, cy, w, h):
    return any(x1 * w <= cx <= x2 * w and y1 * h <= cy <= y2 * h
               for x1, y1, x2, y2 in IGNORE_ZONES)


def valid_box(x1, y1, x2, y2, w, h):
    bw, bh = x2 - x1, y2 - y1
    if bw <= 0 or bh <= 0:
        return False
    area = bw * bh / (w * h)
    if not (MIN_AREA <= area <= MAX_AREA):
        return False
    if not (MIN_RATIO <= bh / bw <= MAX_RATIO):
        return False
    return not in_ignore_zone((x1 + x2) / 2, (y1 + y2) / 2, w, h)


def loop():
    tracks = {}                      # id -> {hits, maxconf, last}
    recent = deque(maxlen=SMOOTH)
    fi = 0
    while True:
        now = datetime.now()
        if not (ACTIVE_FROM <= now.hour < ACTIVE_TO):
            state.update(count=0, cand=0, status="خارج وقت التشغيل", infer=0.0)
            tracks.clear(); recent.clear()
            time.sleep(5)
            continue

        frame = read_frame()
        if frame is None:
            state["status"] = "مفيش صورة من الكاميرا"
            time.sleep(0.5)
            continue
        frame = upscale(frame)
        h, w = frame.shape[:2]

        t = time.time()
        res = model.track(frame, persist=True, tracker="bytetrack.yaml", classes=[0],
                          conf=CONF_KEEP, imgsz=IMGSZ, verbose=False)[0]
        ms = (time.time() - t) * 1000
        fi += 1

        seen = {}
        if res.boxes is not None and res.boxes.id is not None:
            for b, tid, c in zip(res.boxes.xyxy.tolist(), res.boxes.id.int().tolist(),
                                 res.boxes.conf.tolist()):
                if not valid_box(*b, w, h):
                    continue
                seen[tid] = (b, c)
                tr = tracks.setdefault(tid, {"hits": 0, "maxconf": 0.0, "last": fi})
                tr["hits"] += 1
                tr["maxconf"] = max(tr["maxconf"], c)
                tr["last"] = fi

        # شيل الـ tracks القديمة
        for tid in [k for k, v in tracks.items() if fi - v["last"] > GRACE * 4]:
            del tracks[tid]

        def confirmed(tr):
            return tr["hits"] >= MIN_HITS and tr["maxconf"] >= CONF_NEW

        count = sum(1 for tr in tracks.values()
                    if confirmed(tr) and fi - tr["last"] <= GRACE)
        recent.append(count)
        smooth = int(np.median(recent))

        for tid, (b, c) in seen.items():
            x1, y1, x2, y2 = map(int, b)
            ok = confirmed(tracks[tid])
            col = (0, 255, 0) if ok else (130, 130, 130)   # أخضر = مؤكد، رمادي = مرشّح
            cv2.rectangle(frame, (x1, y1), (x2, y2), col, 2)
            cv2.putText(frame, f"{c:.2f}", (x1, max(y1 - 6, 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)
        for x1, y1, x2, y2 in IGNORE_ZONES:
            cv2.rectangle(frame, (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h)),
                          (0, 0, 255), 1)
        cv2.putText(frame, f"occupancy {smooth}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)

        state["jpg"] = cv2.imencode(".jpg", frame)[1].tobytes()
        state.update(count=smooth, cand=len(seen) - count if len(seen) > count else 0,
                     status="يعمل", infer=ms, ts=datetime.now(timezone.utc).isoformat())
        state["log"] = (state["log"] + [f"{now:%H:%M:%S} count={smooth} raw={count} infer={ms:.0f}ms"])[-5:]


threading.Thread(target=loop, daemon=True).start()
app = Flask(__name__)

PAGE = """<body style="background:#111;color:#aaa;font-family:monospace;padding:20px">
<h1 style="color:#5f5;font-size:60px;margin:0">{n} head{s}</h1>
<p>status={status} candidates={cand} infer={ms:.1f}ms ts={ts}</p>
<img src="/frame" width="320"><br>
<p>log:<br>{log}</p>
<a href="/json">json</a> <a href="/health">health</a>
<script>setTimeout(()=>location.reload(),1000)</script></body>"""


@app.route("/")
def index():
    n = state["count"]
    return PAGE.format(n=n, s="" if n == 1 else "s", status=state["status"],
                       cand=state["cand"], ms=state["infer"], ts=state["ts"],
                       log="<br>".join(state["log"]))


@app.route("/frame")
def frame():
    return Response(state["jpg"] or b"", mimetype="image/jpeg")


@app.route("/json")
def js():
    return jsonify(count=state["count"], candidates=state["cand"], status=state["status"],
                   infer_ms=state["infer"], ts=state["ts"])


@app.route("/health")
def health():
    return jsonify(status="ok")


app.run(host="0.0.0.0", port=5000)

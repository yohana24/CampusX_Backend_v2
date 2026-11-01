import time, threading
from datetime import datetime, timezone
import cv2
from flask import Flask, Response, jsonify
from ultralytics import YOLO

model = YOLO("yolov8n.pt")
cap = cv2.VideoCapture(0)
state = {"raw": 0, "infer": 0.0, "ts": "", "jpg": None, "log": []}

def loop():
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1)
            continue
        t = time.time()
        res = model(frame, classes=[0], conf=0.3, verbose=False)[0]
        ms = (time.time() - t) * 1000
        n = len(res.boxes)
        for b in res.boxes:
            x1, y1, x2, y2 = map(int, b.xyxy[0])
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(frame, f"{float(b.conf[0]):.2f}", (x1, y1 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cv2.putText(frame, f"occupancy {n}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        state["jpg"] = cv2.imencode(".jpg", frame)[1].tobytes()
        state["raw"], state["infer"] = n, ms
        state["ts"] = datetime.now(timezone.utc).isoformat()
        state["log"] = (state["log"] + [f"{datetime.now():%H:%M:%S} raw={n} infer={ms:.0f}ms"])[-5:]

threading.Thread(target=loop, daemon=True).start()
app = Flask(__name__)

PAGE = """<body style="background:#111;color:#aaa;font-family:monospace;padding:20px">
<h1 style="color:#5f5;font-size:60px;margin:0">{n} head{s}</h1>
<p>raw={n} infer={ms:.1f}ms ts={ts}</p>
<img src="/frame" width="320"><br>
<p>log:<br>{log}</p>
<a href="/json">json</a> <a href="/health">health</a>
<script>setTimeout(()=>location.reload(),1000)</script></body>"""

@app.route("/")
def index():
    n = state["raw"]
    return PAGE.format(n=n, s="" if n == 1 else "s", ms=state["infer"],
                       ts=state["ts"], log="<br>".join(state["log"]))

@app.route("/frame")
def frame():
    return Response(state["jpg"] or b"", mimetype="image/jpeg")

@app.route("/json")
def js():
    return jsonify(raw=state["raw"], infer_ms=state["infer"], ts=state["ts"])

@app.route("/health")
def health():
    return jsonify(status="ok")

app.run(host="127.0.0.1", port=5000)
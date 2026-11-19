import os
import time
import threading
from datetime import datetime, timezone

import cv2
from flask import Flask, Response, jsonify

# torch / ultralytics are imported lazily in the background thread: importing
# torch costs ~8.5 s here, so doing it at module level delays Flask (and the
# dashboard Start button) for no reason.
cv2.setNumThreads(1)

# Settings come from the environment (the server loads .env into its child
# processes). Defaults keep the original local behaviour.
HOST = os.getenv("CV_WEB_HOST", "127.0.0.1").strip()
PORT = int(os.getenv("CV_WEB_PORT", "5000"))

state = {"raw": 0, "infer": 0.0, "ts": "", "jpg": None, "log": []}
app = Flask(__name__)


def loop():
    # Camera + heavy imports + model setup all happen in the background thread
    # so Flask can bind its port immediately and Start returns at once.
    import torch
    from ultralytics import YOLO

    # This host has 16 logical CPUs. PyTorch's default (8 threads) thrashes and
    # makes a single yolov8n inference take ~9-32 s. One thread runs in ~0.4 s.
    torch.set_num_threads(1)
    model = YOLO("yolov8n.pt")
    # MSMF takes ~11 s to open and often fails to grab a frame on this host;
    # DirectShow opens in ~0.7 s and reads reliably.
    cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1)
            continue
        t = time.time()
        # workers=0 stops Ultralytics spawning a second Python process that
        # re-imports this script and fights over the same camera / CPU.
        res = model(frame, classes=[0], conf=0.3, verbose=False, workers=0)[0]
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


def main():
    threading.Thread(target=loop, daemon=True).start()
    app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)


# Critical on Windows: spawned children must not re-run model/camera/Flask.
if __name__ == "__main__":
    main()

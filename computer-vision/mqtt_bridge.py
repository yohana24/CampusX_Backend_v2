"""Bridge the original headcount Flask JSON output to CampusX MQTT.

The detection algorithm stays in web_count_campusx.py (copied from the
teammate's original web_count.py). This process only reads /json and publishes
people_count telemetry; it does not open the camera or run YOLO.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import paho.mqtt.client as mqtt
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)s [CampusX-CV-Bridge] %(message)s",
)
log = logging.getLogger("campusx-cv-bridge")

DEVICE_ID = os.getenv("DEVICE_ID", "people-counter-lab-01").strip()
MQTT_HOST = os.getenv("MQTT_HOST", "127.0.0.1").strip()
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC = os.getenv("MQTT_TOPIC", "smart-campus/telemetry").strip()
MQTT_USERNAME = os.getenv("MQTT_USERNAME", "").strip()
MQTT_PASSWORD = os.getenv("MQTT_PASSWORD", "")
MQTT_KEEPALIVE = int(os.getenv("MQTT_KEEPALIVE", "30"))
MQTT_QOS = int(os.getenv("MQTT_QOS", "1"))
CV_JSON_URL = os.getenv("CV_JSON_URL", "http://127.0.0.1:5000/json").strip()
PUBLISH_INTERVAL = float(os.getenv("PUBLISH_INTERVAL_SECONDS", "2"))
HTTP_TIMEOUT = float(os.getenv("CV_HTTP_TIMEOUT_SECONDS", "3"))

if not DEVICE_ID:
    raise RuntimeError("DEVICE_ID must match an active dbo.Devices.DeviceCode")
if not MQTT_HOST or not MQTT_TOPIC:
    raise RuntimeError("MQTT_HOST and MQTT_TOPIC must not be empty")
if PUBLISH_INTERVAL <= 0 or HTTP_TIMEOUT <= 0:
    raise RuntimeError("Publish interval and HTTP timeout must be positive")
if MQTT_QOS not in (0, 1, 2):
    raise RuntimeError("MQTT_QOS must be 0, 1, or 2")

connected = False
running = True


def on_connect(client, userdata, flags, reason_code, properties):
    global connected
    connected = not reason_code.is_failure
    if connected:
        log.info("Connected to MQTT broker %s:%s", MQTT_HOST, MQTT_PORT)
    else:
        log.error("MQTT connection rejected: %s", reason_code)


def on_disconnect(client, userdata, disconnect_flags, reason_code, properties):
    global connected
    connected = False
    log.warning("MQTT disconnected: %s", reason_code)


mqtt_client = mqtt.Client(
    callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
    client_id=f"campusx-headcount-bridge-{uuid.uuid4().hex[:10]}",
    protocol=mqtt.MQTTv311,
)
if MQTT_USERNAME:
    mqtt_client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD or None)
mqtt_client.on_connect = on_connect
mqtt_client.on_disconnect = on_disconnect


def get_cv_snapshot() -> dict:
    request = Request(CV_JSON_URL, headers={"Accept": "application/json"})
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        if response.status != 200:
            raise RuntimeError(f"CV endpoint returned HTTP {response.status}")
        data = json.loads(response.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise RuntimeError("CV /json endpoint must return a JSON object")
    return data


def publish_count(count: int, source_timestamp: str) -> None:
    payload = {
        "device_id": DEVICE_ID,
        "message_id": f"{DEVICE_ID}-{uuid.uuid4().hex}",
        "recorded_at": source_timestamp,
        "readings": [
            {"metric": "people_count", "value": count, "unit": "persons"}
        ],
    }
    info = mqtt_client.publish(
        MQTT_TOPIC,
        json.dumps(payload, separators=(",", ":")),
        qos=MQTT_QOS,
        retain=False,
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        raise RuntimeError(f"MQTT publish failed with code {info.rc}")
    info.wait_for_publish(timeout=10)
    if not info.is_published():
        raise RuntimeError("MQTT publish did not complete before timeout")
    log.info("Published people_count=%s for %s", count, DEVICE_ID)


def request_stop(signum, frame):
    global running
    running = False
    log.info("Stop requested; shutting down bridge")


signal.signal(signal.SIGINT, request_stop)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, request_stop)


def main() -> int:
    global running
    log.info("Reading teammate CV service at %s", CV_JSON_URL)
    log.info("Publishing %s to MQTT topic %s", DEVICE_ID, MQTT_TOPIC)
    try:
        mqtt_client.connect(MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE)
        mqtt_client.loop_start()
        deadline = time.monotonic() + 15
        while running and not connected and time.monotonic() < deadline:
            time.sleep(0.1)
        if not connected:
            raise RuntimeError("Could not connect to MQTT broker within 15 seconds")

        last_source_timestamp = None
        last_publish_monotonic = 0.0
        last_http_error_log = 0.0

        while running:
            try:
                snapshot = get_cv_snapshot()
                count_value = snapshot.get("raw")
                source_timestamp = snapshot.get("ts")

                # The original CV app starts its camera worker in a background
                # thread. Do not publish a fabricated zero before its first frame.
                if source_timestamp and count_value is not None:
                    count = int(count_value)
                    if count < 0:
                        raise RuntimeError("CV returned a negative people count")
                    now = time.monotonic()
                    is_new_frame = source_timestamp != last_source_timestamp
                    interval_elapsed = now - last_publish_monotonic >= PUBLISH_INTERVAL
                    if is_new_frame and interval_elapsed:
                        publish_count(count, str(source_timestamp))
                        last_source_timestamp = source_timestamp
                        last_publish_monotonic = now
                else:
                    log.info("Waiting for first camera frame from CV service")
            except (HTTPError, URLError, TimeoutError, OSError, ValueError, RuntimeError) as exc:
                now = time.monotonic()
                if now - last_http_error_log >= 5:
                    log.warning("CV read/publish not ready: %s", exc)
                    last_http_error_log = now
            time.sleep(min(0.5, PUBLISH_INTERVAL / 2))
    except Exception as exc:
        log.exception("Bridge stopped: %s", exc)
        return 1
    finally:
        try:
            mqtt_client.disconnect()
            mqtt_client.loop_stop()
        except Exception:
            pass
    log.info("Bridge stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

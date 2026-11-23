# دمج كاميرا CampusX مع عدّاد الرؤوس `head240.pt`

## الخلاصة
الخدمة النشطة هي `web_count3.py` ومعها **الموديل الجديد `head240.pt`** — وهذا هو الافتراضي دلوقتي (`CV_DETECTOR=head`). بتقرأ من **أي كاميرا متصلة** (`CV_SOURCE=0` أول webcam، أو `1`/`2`، أو رابط ESP32-CAM).

افتح المعاينة من هنا 👉 **http://127.0.0.1:5000/**
هتلاقي صورتين جنب بعض:
- **Camera view (raw):** اللي الكاميرا شايفاه بالظبط (`/raw` و`/rawstream`).
- **Detection view (`head240.pt`):** نفس الصورة مع مربعات الكشف (`/frame` و`/video`).

فوقهم العدد الحي وحالة الـ detector والـ FPS وزمن الاستنتاج.

## لازم تعرفه عن `head240.pt`
الموديل متدرّب على **رؤوس من فوق** (كاميرا علوية / ESP32-CAM 240px). على webcam أمامية بيشوف وجه مش رأس من فوق، ففي بعض الأوضاع بيرجّع 0.
عشان كده ضفنا `CV_FACE_FALLBACK=true` (مفعّل افتراضيًا): لو `head240.pt` ما لقى أي رأس في الفريم، الخدمة تشغّل كاشف وجوه أمامي (Haar) وتحط مربعاته **نفس الـ tracker**، فيطلع العدد والرسم على المعاينة شغالين من أي كاميرا.
في `/json` هتلاقي `face_fallback: true` لو الحالة دي حصلت، و`model: head240.pt` دايمًا في الوضع الافتراضي.

لو عايز تجرّب كشف الأشخاص الكاملين بدل ده:
```env
CV_DETECTOR=person
CV_MODEL_PATH=yolov8n.pt
CV_SIMULATE_240=false
CV_FACE_FALLBACK=false
```

## إيه اللي اتطوّر في `web_count3.py`
- **ByteTrack** لتتبّع كل رأس/وجه (ما يتحسبش أكتر من مرة).
- تأكيد بعد ظهورات متكررة، وتسامح مؤقت لفقدان اللحظة، و**وسيط** آخر قراءات عشان الرقم ما يرقصش.
- **مناطق تجاهل** (`ignore_zones.json`) تتعمل من `--calibrate` والأوضة فاضية عشان تشيل الأشباح الثابتة.
- سجل CSV (`counts.csv`) كل دقيقة، وبث MJPEG للصورتين.
- `/json` بيرجّع: `count`, `raw`, `candidates`, `status`, `infer_ms`, `fps`, `ts`, `log`, `detector`, `model`, `label`, `face_fallback`.

## التدفق (زي ما هو)
`كاميرا → web_count3.py → /json → mqtt_bridge.py → MQTT → CampusX Backend → SQL Server / SSE`

الـ bridge ما بيفتحش الكاميرا ولا بيشغّل YOLO. بيقرأ `/json` وينشر `people_count` على `smart-campus/telemetry` بمعرّف `message_id` جديد لكل رسالة. **عقد الـ MQTT نفسه ما اتغيرش.**

## الإعداد
```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
Copy-Item .env.example .env
notepad .env
```

أهم الإعدادات:
- `CV_DETECTOR=head` و`CV_MODEL_PATH=head240.pt` — الموديل الجديد (الافتراضي).
- `CV_FACE_FALLBACK=true` — عشان الكاميرا الأمامية تفضل شغالة.
- `CV_SOURCE=0` = أول كاميرا متصلة. جرّب `1` أو `2` لو عندك أكتر من واحدة، أو حط رابط `http://<IP>:81/stream`.
- `CV_WEB_HOST=127.0.0.1` و`CV_WEB_PORT=5000` — المعاينة **loopback فقط**.
- `CV_ALWAYS=true` يعني العدّ شغال طول اليوم. لو عايز 9-15 بس، حطه `false` واستخدم `CV_ACTIVE_FROM` / `CV_ACTIVE_TO`.
- `DEVICE_ID=people-counter-lab-01` لازم يطابق DeviceCode مسجّل في `dbo.Devices`.
- `CV_JSON_URL` لازم يشير لنفس الـ host/port بتاع الخدمة.

## تثبيت المكتبات
```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## التشغيل من الداشبورد
زرارا **Start Computer Vision** و**Stop** بيشغّلوا/بيوقفوا `web_count3.py` و`mqtt_bridge.py` بس. السيرفر وMosquitto ما بيتوقفوش.
بعد Start افتح `http://127.0.0.1:5000/` عشان تشوف الكاميرا والكشف.

التشغيل اليدوي (3 نوافذ):
```powershell
# 1) Backend
npm start

# 2) كاميرا / عدّاد الرؤوس
.\.venv\Scripts\python.exe web_count3.py --always

# 3) الجسر
.\.venv\Scripts\python.exe mqtt_bridge.py
```

## اختبارات سريعة
```powershell
.\.venv\Scripts\python.exe cam_test.py
.\.venv\Scripts\python.exe test_image.py <صورة.jpg>
.\.venv\Scripts\python.exe web_count3.py --calibrate   # والأوضة فاضية
.\.venv\Scripts\python.exe web_count3.py --always
```

> `web_count1.py`, `head_test.py`, `test_image.py`, `cam_test.py`, `voc_to_yolo.py`, `train_colab.ipynb`, `README.md` جايّة من الـ zip؛ أدوات اختبار/تدريب بس. **ما تشغّلش أي واحدة منهن جنب `web_count3.py`** لأن الاتنين هيفتحوا الكاميرا.

## رسالة MQTT الناتجة
```json
{
  "device_id": "people-counter-lab-01",
  "message_id": "people-counter-lab-01-UNIQUE_ID",
  "recorded_at": "2026-11-24T00:00:00.000Z",
  "readings": [
    {"metric": "people_count", "value": 2, "unit": "persons"}
  ]
}
```

## ملاحظات
- العدد هو **رؤوس/وجوه مكتشفة في اللحظة الحالية**، مش إجمالي الداخلين طول اليوم.
- الصور ما بتروحش لـ MQTT أو SQL؛ العدد بس.
- لو المتصفح مش معاه `API_KEY` محفوظ، حقول الـ API هتظهر `—`؛ أدخل المفتاح مرة واحدة.
- بيانات تدريب موديل الرؤوس من SCUT-HEAD للبحث الأكاديمي بس — راجع الترخيص قبل استخدامها تجاريًا.

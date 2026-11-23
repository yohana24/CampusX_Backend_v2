# دمج كاميرا CampusX مع عدّاد الأشخاص

## الخلاصة (مهم)
الداشبورد بيقرأ دلوقتي من **أي كاميرا متصلة بالجهاز** (الافتراضي `CV_SOURCE=0` = أول webcam).
الوضع الافتراضي `CV_DETECTOR=person` بيستخدم `yolov8n.pt` (فئة `person`) على الصورة الكاملة — وهذا اللي بيشوف وجهك/جسمك فعليًا.
موديل `head240.pt` لسه موجود ومشتغل بس للكاميرات **العلوية** (ESP32-CAM / 240px)؛ جرّبناه على webcam أمامية فوجدناه بيرجّع 0 رأس، فما بقيناش بنستخدمه كافتراضي.

## الوضعان

| `CV_DETECTOR` | الموديل | الاستخدام | الصورة | حدود المربع |
| --- | --- | --- | --- | --- |
| `person` (افتراضي) | `yolov8n.pt`, class 0 | webcam أمامي / لابتوب | كاملة، من غير تصغير | area 0.02–0.85، ratio 0.4–3.0 |
| `head` | `head240.pt`, class 0 `head` | كاميرا من فوق / ESP32-CAM 240px | يتصغّر لـ 240 | area 0.0002–0.10، ratio 0.5–2.5 |

كل قيم الجدول قابلة للتجاوز من متغيرات `CV_*` في `.env` (القيم الافتراضية موجودة في `.env.example`).
أي متغير `CV_*` مذكور صراحةً بيغيّر قيمة الـ preset.

## إيه اللي اتطوّر في `web_count3.py`
- **ByteTrack** لتتبّع كل شخص/رأس (ما يتحسبش أكتر من مرة).
- تأكيد بعد ظهورات متكررة، وتسامح مؤقت لفقدان اللحظة، و**وسيط** آخر قراءات عشان الرقم ما يرقصش.
- **مناطق تجاهل** (`ignore_zones.json`) تتعمل من `--calibrate` والأوضة فاضية عشان تشيل الأشباح الثابتة.
- سجل CSV (`counts.csv`) كل دقيقة، وبث مباشر `/video` (MJPEG).
- `/json` بيرجّع: `count`, `raw`, `candidates`, `status`, `infer_ms`, `fps`, `ts`, `log`, وكمان `detector`, `model`, `label`.

## التدفق (زي ما هو)
`كاميرا → web_count3.py → /json → mqtt_bridge.py → MQTT → CampusX Backend → SQL Server / SSE`

الـ bridge ما بيفتحش الكاميرا ولا بيشغّل YOLO. بيقرأ `/json` وينشر `people_count` على `smart-campus/telemetry` بمعرّف `message_id` جديد لكل رسالة. **عقد الـ MQTT نفسه ما اتغيرش.**

## الإعداد
انسخ `.env.example` إلى `.env` وعدّله:

```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
Copy-Item .env.example .env
notepad .env
```

أهم الإعدادات:
- `CV_DETECTOR=person` — سيبها كده للـ webcam. حط `head` لو الكاميرا فوق.
- `CV_SOURCE=0` = أول كاميرا متصلة. لو عندك أكتر من كاميرا جرّب `1` أو `2`؛ أو حط رابط ESP32-CAM زي `http://<IP>:81/stream` (أو `/capture`).
- `CV_WEB_HOST=127.0.0.1` و`CV_WEB_PORT=5000` — المعاينة **loopback فقط**.
- `CV_ALWAYS=true` يعني العدّ شغال طول اليوم. لو عايز 9-15 بس، حطه `false` واستخدم `CV_ACTIVE_FROM` / `CV_ACTIVE_TO`.
- `DEVICE_ID=people-counter-lab-01` لازم يطابق DeviceCode مسجّل في `dbo.Devices`.
- `CV_JSON_URL` لازم يشير لنفس الـ host/port بتاع الخدمة.

## تثبيت المكتبات
استخدم نفس الـ venv الموجود، وما تعملش بيئة ثانية:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## التشغيل من الداشبورد
زرارا **Start Computer Vision** و**Stop** في الداشبورد (`index.html` و`control-panel.html`) بيشغّلوا/
بيوقفوا `web_count3.py` و`mqtt_bridge.py` بس. السيرفر وMosquitto ما بيتوقفوش.

التشغيل اليدوي (3 نوافذ):
```powershell
# 1) Backend
npm start

# 2) كاميرا / عدّاد الأشخاص
.\.venv\Scripts\python.exe web_count3.py --always

# 3) الجسر
.\.venv\Scripts\python.exe mqtt_bridge.py
```

المعاينة: `http://127.0.0.1:5000/` والـ JSON: `http://127.0.0.1:5000/json`.

## اختبارات سريعة
```powershell
.\.venv\Scripts\python.exe cam_test.py
.\.venv\Scripts\python.exe test_image.py <صورة.jpg>
.\.venv\Scripts\python.exe web_count3.py --calibrate   # والأوضة فاضية
.\.venv\Scripts\python.exe web_count3.py --always
# للتجربة على كاميرا علوية:
$env:CV_DETECTOR='head'; .\.venv\Scripts\python.exe web_count3.py --always
```

> `web_count1.py`, `head_test.py`, `test_image.py`, `cam_test.py`, `voc_to_yolo.py`, `train_colab.ipynb`, `README.md` جايّة من الـ zip؛ أدوات اختبار/تدريب بس. **ما تشغّلش أي واحدة منها جنب `web_count3.py`** لأن الاتنين هيفتحوا الكاميرا.

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
- العدد هو **أشخاص/رؤوس مكتشفة في اللحظة الحالية**، مش إجمالي الداخلين طول اليوم.
- الصور ما بتروحش لـ MQTT أو SQL؛ العدد بس.
- لو المتصفح مش معاه `API_KEY` محفوظ، حقول الـ API هتظهر `—`؛ أدخل المفتاح مرة واحدة.
- بيانات تدريب موديل الرؤوس من SCUT-HEAD للبحث الأكاديمي بس — راجع الترخيص قبل استخدامها تجاريًا.

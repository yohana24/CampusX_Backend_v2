# دمج كاميرا CampusX مع العدّاد `head240.pt`

## الخلاصة
الخدمة النشطة هي `web_count3.py`. الافتراضي دلوقتي **`CV_DETECTOR=auto`**: عدد واحد بيغطّي **كل الاتجاهات** من أي كاميرا متصلة (`CV_SOURCE=0` أول webcam، أو `1`/`2`، أو رابط ESP32-CAM).

افتح المعاينة من هنا 👉 **http://127.0.0.1:5000/**
هتلاقي **صورة واحدة** فيها اللي الكاميرا شايفاه + مربعات الكشف مرسومة فوقه، وفوقها العدد الحي وحالة المصدر والـ FPS وزمن الاستنتاج.
نفس الصورة ظاهرة جوه **داشبورد CampusX** في بطاقة Computer Vision (`/video`).

## إزاي بيشتغل `auto` (كل الاتجاهات في عدد واحد)
بيجرّب بالترتيب، و_first hit_ يدخل الـ tracker:

1. **`head240.pt`** → رؤوس من **فوق** (كاميرا علوية / ESP32-CAM 240px).
2. **كاشف وجوه Haar** → وجوه من **قدّام** لو الموديل ما لقى رأس.
3. **`yolov8n.pt` class 0** → جسم كامل من **الجنب / الخلف / أي زاوية** لو ما لقى وجه كمان.

في `/json` هتلاقي `source` بيقولك أنهي مصدر استُخدم في اللحظة دي (`head` / `face` / `person`)، و`face_fallback` بيقول لو اتخطّى الموديل الأساسي. الداشبورد بيعرض نفس المعلومة.

### ليه `head240.pt` لوحده ما يقدرش "من أي جهة"؟
لأنه **متدرّب على رؤوس من فوق بس** (SCUT-HEAD، صور 240px مقصوصة من كاميرات علوية). يعني:
- شكل الرأس من فوق (بيضاوي + شعر) هو اللي الموديل عارفه.
- الوجه الأمامي / الجنبي / الخلفي شكله مختلف تمامًا عن "رأس من فوق"، فالموديل ما اتدربش عليه → بيرجّع 0 أو كشف عشوائي.
- تغيير `imgsz` أو التدوير أو الـ CLAHE بيطلّع كشف عشوائي مش موثوق (جرّبناده — النتائج كانت 0 في الأوضاع الطبيعية).

**الحلين:**
1. **اللي مطبّق دلوقتي (عملي):** ندمج `head240.pt` مع كاشف وجوه + كاشف أشخاص (`auto`). كل زاوية ليها كاشف، وال عدد واحد.
2. **الحل الجذري لموديل واحد:** تعمل **fine-tune / retrain** على داتا **متعددة الزوايا (360°)** مع rotation augmentations، أو تدرّب موديلYOLO على (head + face + person) ككلاسات. ده محتاج داتا وتدريب — مش ممكن يتعمل من أوزان `head240.pt` الحالية لوحدها.

لو عايز تجرّب موديل بس:
```env
CV_DETECTOR=head      # head240.pt فقط (من فوق)
CV_FACE_FALLBACK=false
CV_PERSON_FALLBACK=false
```
أو:
```env
CV_DETECTOR=person    # yolov8n.pt فقط (أي زاوية)
```

## إيه اللي اتطوّر في `web_count3.py`
- **ByteTrack** لتتبّع كل رأس/وجه/شخص (ما يتحسبش أكتر من مرة).
- تأكيد بعد ظهورات متكررة، وتسامح مؤقت لفقدان اللحظة، و**وسيط** آخر قراءات عشان الرقم ما يرقصش.
- **مناطق تجاهل** (`ignore_zones.json`) تتعمل من `--calibrate` والأوضة فاضية عشان تشيل الأشباح الثابتة.
- سجل CSV (`counts.csv`) كل دقيقة، وبث MJPEG لصورة الكشف (`/video` و`/frame`). `/raw` و`/rawstream` لسه متاحين للتشخيص.
- `/json` بيرجّع: `count`, `raw`, `candidates`, `status`, `infer_ms`, `fps`, `ts`, `log`, `detector`, `model`, `label`, `face_fallback`, `source`.

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
- `CV_DETECTOR=auto` و`CV_MODEL_PATH=head240.pt` — الافتراضي (كل الاتجاهات).
- `CV_FACE_FALLBACK=true` و`CV_PERSON_FALLBACK=true` — تغطية قدّام/جنب/خلف.
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
بعد Start هتشوف الصورة جوه الداشبورد، أو افتح `http://127.0.0.1:5000/`.

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
- العدد هو **رؤوس/وجوه/أشخاص مكتشفة في اللحظة الحالية**، مش إجمالي الداخلين طول اليوم.
- الصور ما بتروحش لـ MQTT أو SQL؛ العدد بس.
- لو المتصفح مش معاه `API_KEY` محفوظ، حقول الـ API هتظهر `—`؛ أدخل المفتاح مرة واحدة.
- بيانات تدريب موديل الرؤوس من SCUT-HEAD للبحث الأكاديمي بس — راجع الترخيص قبل استخدامها تجاريًا.

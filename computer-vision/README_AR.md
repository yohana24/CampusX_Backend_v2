# دمج Headcount الجديد مع CampusX Backend v2

## إيه اللي اتغيّر؟
النسخة القديمة كانت بتستخدم `yolov8n.pt` (كشف **الأشخاص** كاملين، `classes=[0]`) مع عدّ بسيط لعدد المربعات في كل.frame.

النسخة الجديدة (من `headcount-main.zip`) بتستخدم:
- `head240.pt`: موديل **YOLOv8n مدرّب على الرؤوس** (فئة واحدة اسمها `head`)، بدقّة أعلى على كاميرا 240x240 زي ESP32-CAM.
- `web_count3.py`: الخدمة النشطة الجديدة. بتعمل **ByteTrack** لتتبّع كل رأس، وتأكيد بعد 6 ظهورات، وتجاهل مؤقت 10 فريمات، و**وسيط** آخر 10 قراءات عشان الرقم ما يرقصش.
- **مناطق تجاهل** (`ignore_zones.json`) تتعمل من `--calibrate` والأوضة فاضية عشان تشيل الأشباح الثابتة (شباك/مراية/بوستر).
- سجل CSV (`counts.csv`) كل 60 ثانية.
- endpoints: `/`, `/frame`, `/video` (بث MJPEG), `/json`, `/health`.

الملفات القديمة `web_count_campusx.py` و`yolov8n.pt` اتشالت. أدوات الاختبار والتدريب من الـ zip موجودة جنب الخدمة:
`test_image.py`, `cam_test.py`, `head_test.py`, `voc_to_yolo.py`, `train_colab.ipynb`, `web_count1.py`, `README.md`.

> `web_count1.py` نسخة تجريبية قديمة من نفس المشروع (بتستخدم `yolov8n.pt`). **ما تشغّلش جنب `web_count3.py`** لأن الاتنين هيفتحوا الكاميرا.

## التدفق (زي ما هو)
`كاميرا / ESP32-CAM → web_count3.py → /json → mqtt_bridge.py → MQTT → CampusX Backend → SQL Server / SSE`

الـ bridge ما بيفتحش الكاميرا ولا بيشغّل YOLO. بيقرأ `/json` وينشر `people_count` على `smart-campus/telemetry` بمعرّف `message_id` جديد لكل رسالة. عقد الـ MQTT نفسه ما اتغيرش.

## الإعداد
انسخ `.env.example` إلى `.env` وعدّله:

```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
Copy-Item .env.example .env
notepad .env
```

أهم الإعدادات:
- `DEVICE_ID=people-counter-lab-01` لازم يطابق DeviceCode مسجّل في `dbo.Devices`.
- `CV_SOURCE=0` = كاميرا اللابتوب. للـ ESP32-CAM حط رابط_stream (`http://<IP>:81/stream`) أو `/capture`.
- `CV_WEB_HOST=127.0.0.1` و`CV_WEB_PORT=5000` — المعاينة **loopback فقط**؛ ما تفتحش الـ 0.0.0.0 من غير firewall وحماية.
- `CV_ALWAYS=true` يعني العدّ شغال طول اليوم. لو عايز وقت العمل 9-15 بس، حطه `false` واستخدم `CV_ACTIVE_FROM` / `CV_ACTIVE_TO`.
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

# 2) كاميرا / كشف الرؤوس
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
```

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
- العدد هو **رؤوس مكتشفة في اللحظة الحالية**، مش إجمالي الداخلين طول اليوم.
- الصور ما بتروحش لـ MQTT أو SQL؛ العدد بس.
- دقّة الموديل على 240px حوالي mAP50 0.862 في مجموعة التحقق، والخطأ المتوسط ~2 رأس لكل صورة. لازم تتأكد في أوضتك الحقيقية.
- البيانات من SCUT-HEAD للبحث الأكاديمي بس — راجع الترخيص قبل استخدامها تجاريًا.

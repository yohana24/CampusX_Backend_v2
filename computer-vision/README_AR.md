# دمج مشروع Headcount الأصلي مع CampusX Backend v2

## الحفاظ على شغل صاحبة الـ Computer Vision

المجلد `headcount_original/headcount/` يحتوي الملفات الثلاثة الأصلية كما وصلت من `headcount.zip` بدون تعديل:

- `cam_test.py`
- `head_test.py`
- `web_count.py`

ملف التشغيل `web_count_campusx.py` هو نسخة من `web_count.py` مع تغيير إعداد واحد فقط: Flask يستمع على `127.0.0.1` بدل `0.0.0.0` حتى لا يتم فتح بث الكاميرا على كل واجهات الشبكة. خوارزمية الكشف كما هي: YOLOv8، فئة `person` (`classes=[0]`)، `conf=0.3`، العدد `len(res.boxes)`، ورسم مربعات الثقة فوق الصورة.

**لا تشغّل `camera_service.py` القديم بالتوازي مع `web_count_campusx.py`**؛ كلاهما يفتح الكاميرا ويشغّل YOLO. في هذا الربط نستخدم كود زميلتك، وليس نسخة الكشف البديلة.

## شكل التشغيل

1. `web_count_campusx.py` يفتح الكاميرا ويشغّل كود YOLO الأصلي ويوفر `/json` و`/frame` ومعاينة `/` محليًا.
2. `mqtt_bridge.py` لا يفتح الكاميرا ولا يشغّل YOLO. يقرأ نتيجة `/json` التي ينتجها برنامج زميلتك ويرسل العدد إلى MQTT.
3. CampusX Backend يستقبل MQTT ويحفظ `people_count` في SQL Server ويبث الحدث للـ Dashboard.

التدفق:

`Camera → teammate web_count_campusx.py → local HTTP /json → mqtt_bridge.py → MQTT → CampusX Backend → SQL Server / SSE`

## الإعداد

انسخ `.env.example` إلى `.env`:

```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
Copy-Item .env.example .env
notepad .env
```

تأكد أن `DEVICE_ID=people-counter-lab-01` هو DeviceCode النشط الذي سجلته بالفعل في CampusX، وأن MQTT يشير إلى Mosquitto.

## تثبيت المكتبات

استخدم نفس Python virtual environment الذي نجح معك، ولا تنشئ بيئة ثانية داخل هذا المجلد إذا كانت `.venv` الموجودة تعمل.

من مجلد `computer-vision`:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## التشغيل — ثلاث نوافذ

### Terminal 1 — CampusX Backend

```powershell
cd D:\important\me\server\CampusX_Backend_v2
npm start
```

### Terminal 2 — كود زميلتك الأصلي مع إعداد استضافة محلي

```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
.\.venv\Scripts\python.exe web_count_campusx.py
```

افتح المعاينة محليًا:

- `http://127.0.0.1:5000/`
- `http://127.0.0.1:5000/json`
- `http://127.0.0.1:5000/health`

### Terminal 3 — MQTT bridge

```powershell
cd D:\important\me\server\CampusX_Backend_v2\computer-vision
.\.venv\Scripts\python.exe mqtt_bridge.py
```

ستظهر رسائل مثل:

```text
[CampusX-CV-Bridge] Connected to MQTT broker 127.0.0.1:1883
[CampusX-CV-Bridge] Published people_count=2 for people-counter-lab-01
```

أوقف الـ bridge أو CV بـ `Ctrl+C` في نافذته الخاصة. اترك Backend يعمل.

## رسالة MQTT الناتجة

الـ bridge يرسل رسالة بالشكل التالي، وكل رسالة لها `message_id` جديد حتى لا يعتبرها Backend مكررة:

```json
{
  "device_id": "people-counter-lab-01",
  "message_id": "people-counter-lab-01-UNIQUE_ID",
  "recorded_at": "2026-10-30T20:00:00.000Z",
  "readings": [
    {"metric": "people_count", "value": 2, "unit": "persons"}
  ]
}
```

## التحقق في SQL Server

```sql
SELECT TOP (20)
    d.DeviceCode,
    m.MetricCode,
    t.ValueNumeric,
    t.RecordedAt,
    t.ReceivedAt
FROM dbo.Telemetry t
JOIN dbo.Devices d ON d.DeviceId = t.DeviceId
JOIN dbo.Metrics m ON m.MetricId = t.MetricId
WHERE d.DeviceCode = 'people-counter-lab-01'
ORDER BY t.TelemetryId DESC;
```

## ملاحظات الدقة والأمان

- هذا يحافظ على منطق زميلتك الأصلي: عدّ الأشخاص المكتشفين في كل frame، وليس tracking للأشخاص الفريدين أو حساب دخول/خروج.
- الـ bridge يرسل `raw` count الذي يرجعه endpoint الأصلي `/json`، ولا يغير نموذج الكشف أو الصناديق.
- الصور لا تُرسل إلى MQTT أو SQL Server؛ الذي يُرسل هو العدد فقط.
- معاينة Flask مربوطة على loopback (`127.0.0.1`) في نسخة CampusX. لا تغيّرها إلى `0.0.0.0` قبل إضافة حماية ووضع سياسة Firewall مناسبة.
- لا تشغّل `web_count.py` و`web_count_campusx.py` معًا، ولا تشغّل `camera_service.py` في نفس الوقت؛ كل واحدة ستحاول فتح الكاميرا.

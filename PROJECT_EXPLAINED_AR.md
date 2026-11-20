# CampusX Backend v2 — شرح المشروع ملف بملف (عربي)

> هذا الملف كُتب عشان تفهم المشروع كامل بدون ما تضيع بين الملفات.  
> اقرأ القسم 1First (الصورة الكاملة)، وبعدين القسم 2 (خريطة الحركة)، وبعدين شرح الملفات حسب المجلد.  
> اتشالت نسخ `.bak` والسكربتات القديمة والنسخ الاحتياطية المحلية لأنها كانت تاريخ تغييرات وليست جزءًا من التشغيل الحالي.

---

## 1. الصورة الكاملة في كلمتين

المشروع **Backend IoT** لمبنى ذكي (CampusX). عندك 4 أطراف:

| الطرف | دوره | أين يعيش |
| --- | --- | --- |
| **SQL Server** | المصدر الوحيد للحقيقة: غرف، عُقد، أجهزة، قراءات، أوامر، تنبيهات، حسابات، إعدادات الأتمتة | `sql\*.sql` + `src\db\sqlserver.js` |
| **Backend Node/Express** | يستقبل أوامر الداشبورد، يستقبل MQTT، يحفظ في SQL، يبث أحداث SSE | `src\*` |
| **الأجهزة / Firmware (ESP32 وريليهات)** | ترسل قياسات وتستقبل أوامر عبر MQTT | `MQTT_CONTRACT.md` + `FIRMWARE_API_REFERENCE.md` |
| **Computer Vision** | كاميرا + YOLO تحسب عدد الأشخاص وترسل `people_count` عبر MQTT | `computer-vision\*` |
| **Dashboard (متصفح)** | واجهات HTML/JS تعرض البيانات وترسل الأوامر | `public\*` |

القاعدة الذهبية: **MQTT هو uplink للأجهزة، HTTP/SSE هو جانب الداشبورد، وSQL هو الحقيقة.**

---

## 2. خريطة الحركة (How things move)

### 2.1 بدء التشغيل

```text
node app.js  (أو npm start)
   └─> src/server.js
         ├─> dotenv -> .env
         ├─> src/app.js          (يبني Express app)
         ├─> SQL pool            (src/db/sqlserver.js)
         ├─> MQTT service        (يشترك في topics)
         ├─> device health       (sweeps للOffline والـ timeout)
         ├─> initializeDashboardAuth()  (من dbo.DashboardAccounts)
         └─> listen(host, port)
```

### 2.2 قراءة telemetry (مثال: حرارة أو عدد أشخاص)

```text
ESP32 / mqtt_bridge.py
   └─> MQTT smart-campus/telemetry  (QoS 1)
        └─> src/services/mqttService.js
             └─> telemetryService.js
                  ├─> تحقق من الجهاز/المترية/الوقت/القيمة
                  ├─> dedupe بـ (DeviceId, MetricId, MessageId)
                  ├─> INSERT dbo.Telemetry (transaction)
                  ├─> alertEngine.js       (قواعد التنبيه)
                  ├─> تحديث Device Status = online
                  └─> eventHub -> SSE -> الداشبورد
```

### 2.3 أمر من الداشبورد للريليه

```text
POST /api/v1/commands  (session + X-API-Key)
   └─> INSERT dbo.Commands (CommandId بيتولد هنا)
   └─> INSERT dbo.Audit_Logs(command_sent)
   └─> MQTT smart-campus/devices/{deviceCode}/commands
        { "command_id": "42", "type": "set_state", "payload": { "state": "on" } }
   └─> UPDATE Status = sent
   └─> SSE 'command'

الجهاز يرد:
   └─> MQTT .../command-response
        { "command_id": "42", "success": true, "status": "completed", "result": { "state": "on" } }
   └─> commandResponseService.js
        ├─> UPDLOCK,HOLDLOCK على صف الأمر
        ├─> تجاهل الرد المكرر بعد حالة نهائية
        ├─> UPDATE dbo.Commands
        ├─> INSERT dbo.Audit_Logs(command_response)
        ├─> INSERT dbo.Device_States (relay_state = on)
        └─> SSE 'command' + 'device.state'
```

### 2.4 Computer Vision → إشغال → أمر تلقائي

```text
كاميرا -> web_count_campusx.py (YOLO) -> HTTP /json
   -> mqtt_bridge.py -> MQTT people_count
   -> backend -> dbo.Telemetry
   -> occupancyAutomationService.evaluateOccupancyAutomation()
        ├─> هل العدد <= threshold لمدة offDelaySeconds؟ -> أرسل off
        ├─> هل العدد > threshold وrestore مفعّل؟ -> أرسل on
        └─> قبل الإرسال: تأكد من relay_state المؤكد في SQL عشان ما يكررش أمر
   -> MQTT command -> ريليه -> command-response -> SQL -> SSE
```

---

## 3. الملفات في الجذر (Root)

| الملف | الشرح |
| --- | --- |
| `package.json` | تعريف المشروع `campusx-backend-v2`. فيه الـ entry point `src/server.js`،nodemon للـ dev، والأوامر: `start`, `dev`, `check`, `check:syntax`, `check:connections`, `smoke`, `verify`. Dependencies: `express`, `mqtt`, `mssql`, `msnodesqlv8`, `dotenv`. |
| `package-lock.json` | قفل إصدارات npm. يُولّد تلقائيًا، لا تعدّله يدويًا. |
| `app.js` | مجرد compatibility shim: `require('./src/server')`. عشان لو حد كتب `node app.js` يشتغل. |
| `.env` | **سري — لا يرفع ولا يشارك.** فيه كل إعدادات التشغيل الفعلية: HOST/PORT، SQL، MQTT، مفاتيح الداشبورد، SMTP. شرح الأقسام في `.env.example`. |
| `.env.example` | القالب immortal: كل المتغيرات مع قيم توضيحية (placeholders). هذا المرجع الذي تقرأه. |
| `.env.dashboard-auth.example` | قالب مصغّر لقسم الداشبورد فقط: `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_SESSION_SECRET`, إلخ. |
| `.env.smtp.example` | قالب مصغّر للـ SMTP الاختياري. قيم وهمية فقط. |
| `.gitignore` | يمنع رفع `node_modules`, `.venv`, `__pycache__`, `*.log`, `.env`, `.env.*` عدا examples، و`*.bak*`. |
| `README.md` | الدليل الإنجليزي الرئيسي: معمارية، quick start، متغيرات البيئة، endpoints، الأمان، جداول SQL. |
| `API_CONTRACT.md` | العقد الرسمي لـ HTTP API: auth، response shape، كل الـ endpoints، SSE، idempotency. |
| `MQTT_CONTRACT.md` | عقد MQTT: topics، QoS، payloads، دورة الأمر، idempotency. |
| `FIRMWARE_INTEGRATION.md` | دليل مطوّل لمهندس الـ firmware: قواعد، payloads، Arduino sketch، اختبارات. |
| `FIRMWARE_API_REFERENCE.md` | المرجع السريع اللي عملناه لصاحبك: HTTP endpoints + MQTT + curl + checklist. |
| `fake-actuator.js` | ريليه وهمي يشتغل على MQTT ويستقبل `set_state` ويرد بـ `command-response`. أداة اختبار. |
| `fake-esp32.js` | مستشعر وهمي يرسل 4 سيناريوهات حرارة/رطوبة (normal/warning/critical/recovered) على MQTT. أداة اختبار. |
| `co2-test.json`, `co2-alert-test.json`, `live-test.json` | ملفات telemetry جاهزة للحقن اليدوي في `smart-campus/telemetry` لاختبار الاستقبال والتكرار والتنبيهات. ليست ملفات كود. |

---

## 4. مجلد `src/` — قلب الـ Backend

### 4.1 الإعداد والخادم

| الملف | الشرح |
| --- | --- |
| `src/server.js` | نقطة الدخول الحقيقية. يبدأ HTTP، MQTT، device health، ويعيد محاولة تهيئة الـ auth من SQL. فيه كمان graceful shutdown: بيغلق SSE ثم HTTP ثم MQTT ثم SQL مع timeouts. |
| `src/app.js` | يبني Express app: security headers، JSON parser، session middleware، صفحات الداشبورد، docs، mounting للـ routes، error handler. **ما بيناديش `listen()`**. |
| `src/config/env.js` | يقرأ `.env`، يحول الأرقام/البووليانات للقوائم، يتحقق من المدى، ويرجّع object مجمد فيه كل الإعدادات. كل الملفات التانية تقرأ منه. |
| `src/db/sqlserver.js` | يبني connection string، يدير الـ pool، ويعمل reconnect. بيوفّر `getPool()`, `closePool()`, و `poolPromise` للتوافق مع الكود القديم. |

### 4.2 الـ Middleware

| الملف | الشرح |
| --- | --- |
| `src/middleware/security.js` | security headers + CORS حسب `CORS_ORIGINS` و`PUBLIC_ORIGIN` + `X-API-Key` للعمليات الكتابية + استثناء لـ `/stream?apiKey=`. |
| `src/middleware/errors.js` | `HttpError`, `asyncHandler` لتغليف الـ async routes، و `errorHandler` اللي يرجّع `{status:'error', error:{code,message}}`. |
| `src/middleware/dashboardAuth.js` | **الحالي**: تسجيل دخول وتسجيل حسابات من `dbo.DashboardAccounts`، أدوار `user`/`admin`، كوكي `campusx_session` موقّع HttpOnly SameSite=Strict، scrypt للباسورد، `SessionVersion` لإبطال الجلسات القديمة، تحديد محاولات الدخول والتسجيل، وإدارة الحسابات من الأدمن. |

### 4.3 الـ Routes

| الملف | الشرح |
| --- | --- |
| `src/routes/api.js` | أكبر ملف. كل endpoints `/api/v1/*`: health، db-check، dashboard summary، rooms/labs، nodes، device types، devices، metrics، capabilities، alert rules، telemetry، alerts، commands، states، occupancy، SSE stream. فيه كمان `closeStreams()` للـ shutdown. |
| `src/routes/computerVision.js` | `GET /status`, `POST /start`, `POST /stop` تحت `/api/v1/computer-vision`. |
| `src/routes/dashboardAccount.js` | `GET /account`, `PATCH /account/credentials` تحت `/auth`، و`GET/PATCH/DELETE /auth/admin/accounts[/:id]` للأدمن. |
| `src/routes/occupancyAutomation.js` | `GET /`, `PUT /` تحت `/api/v1/occupancy-automation`. يضبط إعدادات الأتمتة لكل غرفة. |

### 4.4 الـ Services

| الملف | الشرح |
| --- | --- |
| `src/services/mqttClient.js` |client MQTT مشترك، `publish()`, `waitUntilConnected()`, `endClient()`، logging للاتصال/الانقطاع. |
| `src/services/mqttService.js` | يشترك في الـ topics ويوزّع الرسائل: telemetry → `telemetryService`، command-response → `commandResponseService`، و `people_count` → `occupancyAutomationService`. |
| `src/services/telemetryService.js` | يتحقق من حجم الرسالة وصحة الـ readings والمترية والوقت ونوع القيمة، يعمل dedupe، يحفظ في SQL داخل transaction ويطلق التنبيهات. |
| `src/services/commandResponseService.js` | يستقبل رد الجهاز، يقفل صف الأمر بـ `UPDLOCK,HOLDLOCK`، يتجاهل التكرار، يكتب audit و `relay_state`. |
| `src/services/alertEngine.js` | يقيّم قواعد التنبيه المخزنة في SQL (`>`, `>=`, `<`, `<=`, `=`, `!=`, `changed`) وينشئ/يغلق الـ alerts. |
| `src/services/deviceHealthService.js` | دورات تنظيف: الأجهزة اللي ما بعتتش تُعتبر offline، والأوامر المعلّقة تُعتبر timeout. |
| `src/services/eventHub.js` | EventEmitter داخلي يوزّع الأحداث على SSE. مش مصدر حقيقة — مجرد ناقل. |
| `src/services/occupancyAutomationService.js` | يقرأ/يحفظ إعدادات الأتمتة، يقرر تشغيل/إيقاف المراوح والأنوار بعد ثبات الشرط، ويتجنب الأوامر الزائدة بالاعتماد على `relay_state` المؤكد في SQL. |
| `src/services/computerVisionManager.js` | يتحكم في سكربتات PowerShell الخاصة بالكاميرا/الـ bridge، يقرأ الـ PID files، يجمّع فحص WMI، يسرّع Start/Stop بـ stdio file-backed و يمنع تزامن عمليتين. |

### 4.5 أدوات مساعدة وعقود

| الملف | الشرح |
| --- | --- |
| `src/utils/mqttTopics.js` | يترجم topic templates من `.env` (بما فيها `+` و `#`) إلى matchers، يستخرج `deviceCode` ويبني topic الجهاز. |
| `src/docs/contract.js` | العقد القابل للقراءة آليًا اللي يظهر في `/docs/contract.json`. بيعكس الإعدادات الحقيقية (topics، QoS، endpoints). |

### 4.6 سكربتات الفحص داخل `scripts/` (الجزء النشط)

| الملف | الشرح |
| --- | --- |
| `scripts/check-all.js` | يشغّل syntax check + يتحقق من config و topics و contract. ده `npm run check`. |
| `scripts/check-connections.js` | يختبر الاتصال بـ SQL و MQTT فعليًا. ده `npm run check:connections`. |
| `scripts/smoke.js` | يختبر سيرفر شغال: health، docs، login، ثم عدة endpoints بكوكي. ده `npm run smoke`. |
| `scripts/syntax-check.js` | `node --check` على كل ملفات `.js` النشطة. |
| `scripts/create-dashboard-credentials.js` | يولّد salt + scrypt hash + session secret للـ `.env` بدون ما يطبع الباسورد. |
| `scripts/setup-dashboard-auth.ps1` | يستلم الباسورد بأمان ويستدعي السكربت اللي فوقه. |
| `scripts/dashboard-login-smoke.ps1` | اختبار login/logout كامل من PowerShell بـ `Get-Credential`. |
| `scripts/smoke-test.ps1` | اختبار HTTP خفيف لعدة endpoints. |

---

## 5. مجلد `public/` — الداشبورد (واجهات المتصفح)

### 5.1 الصفحات (الصفحات النشطة)

| الملف | الشرح |
| --- | --- |
| `public/login.html` | صفحة الدخول: form، إظهار/إخفاء الباسورد، رسائل خطأ. |
| `public/index.html` | الداشبورد الرئيسي: KPIs، رسم حرارة، تنبيهات، ملخصNodes، اختيار المعمل، وCV manager خاص بالصفحة (`cx-cv-*`). |
| `public/labs.html` | صفحة المعامل: إنشاء معمل، بطاقات، تفاصيل، وإدارة Nodes. |
| `public/devices.html` | إدارة الأجهزة: بحث، فلترة، إضافة، تصدير CSV. |
| `public/alerts.html` | التنبيهات: فلترة، إقرار، تصدير. |
| `public/control-panel.html` | لوحة التحكم: ريليهات، قواعد، سجل أوامر، إشغال، أتمتة، وCV manager (`control-cv-*`). البانر دلوقتي فيه **Refresh Data** فقط واختيار الغرفة من `lab-select-dropdown`. |
| `public/command-history.html` | سجل الأوامر كامل مع pagination وفلترة حالة. |
| `public/settings.html` | الحساب، تغيير البيانات، حالة الخدمات، الجلسة، SSE. |
| `public/admin-accounts.html` | صفحة الأدمن لعرض كل الحسابات وتعديلها وحذفها (`admin-accounts.js` + `admin-accounts.css`). |
| `public/README.md` | ملف تعريف صغير (place holder). |
| `public/WhatsApp Image 2026-10-30 at 6.02.52 PM.jpeg` | صورة خلفية لصفحةLogin (مستخدمة من `style.css`). |

### 5.2 JavaScript نشط

| الملف | الشرح |
| --- | --- |
| `public/auth-client.js` | يتأكد إن الجلسة سارية في كل صفحة (`GET /auth/session`)، يحط زر logout، ويحوّل لـ login لو مفيش session. |
| `public/login.js` | بيتعامل مع submit بتاع_login، الـ `next` الآمن، والـ password toggle. |
| `public/dashboard-app.js` | سكربت مشترك لـ index/devices/alerts/settings: يحمل البيانات، يرسم، يرسل أوامر، ويستقبل SSE بـ debounce 500ms. |
| `public/labs.js` | يحمل rooms/devices/telemetry/alerts/health، يحسب الإشغال، ينشئ معامل جديدة. |
| `public/labs-nodes.js` | يحقن لوحة إضافة Node داخل تفاصيل المعمل ويستخدم `/nodes` و`/node-types`. |
| `public/control-panel-live.js` | **أهم سكربت تشغيلي**: تحميل كل بيانات اللوحة، تبديل الريليه، أتمتة الإشغال، Start/Stop لـ CV، سجل الأوامر، SSE بـ debounce 350ms، و polling للـ CV كل 5 ثواني. |
| `public/command-history.js` | يحمل `/commands` بـ limit/offset/status ويرسم الجدول والـ pagination (حجم الصفحة 25). |
| `public/settings-account.js` | يملك صفحة الإعدادات: الحساب، بيانات الاعتماد، حالة API/DB/MQTT/CV، وSSEpecial. |

### 5.3 CSS نشط

| الملف | الشرح |
| --- | --- |
| `public/style.css` | التصميم الأساسي: ألوان، sidebar، كروت، جداول،login background. |
| `public/auth-login.css` | تصحيحات شكل login وزرLogout. |
| `public/dashboard-live.css` | طبقة الـ toast/modal/stream/CV manager على الداشبورد. |
| `public/dashboard-ui-refresh.css` | تحديث بصري موحّد للقائمة والكروت والجداول على كل الصفحات. |
| `public/labs.css` | تصميم صفحة المعامل + Create Lab form. |
| `public/labs-nodes.css` | تصميم لوحة إدارة الـ Nodes. |
| `public/command-audit.css` | جداول وحالات الأوامر في اللوحة والسجل. |
| `public/command-history.css` | تصميم صفحة سجل الأوامر والـ pagination. |
| `public/settings-account.css` | تصميم حالة الحساب/الخدمات في الإعدادات. |
| `public/control-panel-compact.css` | تضييق كروت لوحة التحكم. |
| `public/control-panel-occupancy.css` | كرت الإشغال (عدد، سعة، شريط تقدم). |
| `public/control-panel-automation.css` | لوحة الأتمتة (toggle، selects، زر حفظ). |
| `public/control-panel-cv-control.css` | كرت إدارة عملية الـ CV (RUNNING/STOPPED إلخ). |

### 5.4 النسخ القديمة

اتشالت ملفات `public/script.js` و`legacy-settings-control.js` و`control-settings.*` و`labs-navbar.css` وكل ملفات `.bak` لأنها كانت نماذج أو لقطات قديمة استُبدلت بالملفات النشطة المذكورة فوق.

### 5.6 التسجيل (Signup) — صفحات `register.*`

| الملف | الشرح |
| --- | --- |
| `public/register.html` | صفحة "Create Your Account" بتصميم مطابق لصفحةLogin (hero + form). فيها حقول `fullName`, `universityEmail`, `password`, `confirmPassword` ورسالة `formMessage`. |
| `public/register.js` | يتحقق من الحقول في المتصفح، ثم يبعث `POST /auth/register` بـ JSON و `credentials: 'same-origin'`. يعطّل زر الإرسال أثناء الطلب، يعرض رسائل الخطأ من السيرفر، ويعيد التوجيه لـ `/dashboard` بعد النجاح. **ما بيستخدمش `localStorage` خالص دلوقتي.** |
| `public/register.css` | تنسيق الصفحة (خلفية + neon corners + glass card). |

الجانب Server:
- `src/app.js` يقدّم `/register.html` و `/register` كصفحات عامة (مش داخل `pageFiles` اللي محمية).
- `src/routes/dashboardAccount.js` يعرّف `POST /auth/register`.
- `src/middleware/dashboardAuth.js` دلوقتي بيدعم **كذا حساب**: خريطة account معمولة من `dbo.DashboardAccounts`، تسجيل الدخول بيقبل username أو الإيميل، وكل جلسة بتتعرف على حسابها عبر `AccountId` + `SessionVersion`.
- كلمة المرور بتتخزن كـ scrypt `<salt>:<hash>`، والباسورد لازم 12-128 حرف.
- التسجيل بيحط كوكي الجلسة فورًا ويرجّع `redirectTo: '/dashboard'`.
- `DASHBOARD_REGISTRATION_ENABLED=false` في `.env` بيقفل التسجيل العام مع ترك الحسابات القديمة شغالة.

---

## 6. مجلد `computer-vision/` — الكاميرا والعدّاد

| الملف | الشرح |
| --- | --- |
| `computer-vision/web_count_campusx.py` | **الخدمة النشطة**: Flask على `127.0.0.1:5000`، يفتح الكاميرا بـ `CAP_DSHOW`، يحمّل YOLO بكسول، يحسب عدد الأشخاص (`classes=[0]`, `conf=0.3`), ويعرض `/`, `/frame`, `/json`, `/health`. فيه تحسينات الأداء: `torch.set_num_threads(1)`, `workers=0`, لا reloader. |
| `computer-vision/mqtt_bridge.py` | **الجسر النشط**: ما بيفتح كاميرا ولا YOLO. بيقرأ `/json` كل فترة وينشر `people_count` على MQTT بصيغة telemetry مع `message_id` فريد. |
| `computer-vision/start-computer-vision.ps1` | سكربت الـ Start: يشوف الكاميرا والجسر شغالين ولا لا (PID files + WMI محقّن)، يبدأهم كـ hidden processes، يكتب logs، وينتظر `/health`. |
| `computer-vision/stop-computer-vision.ps1` | سكربت الـ Stop: يوقف **ملفات Python فقط** (`mqtt_bridge.py` و `web_count_campusx.py`) بالـ PID والـ command line. ما بيوقفش السيرفر ولا Mosquitto. |
| `computer-vision/run-mqtt-bridge.ps1` | مساعد يدوي لتشغيل الجسر في المقدمة (foreground) بـ venv Python. |
| `computer-vision/requirements.txt` | Flask + opencv-python + ultralytics + paho-mqtt + python-dotenv. |
| `computer-vision/.env.example` | قالب إعدادات الجسر: `DEVICE_ID`, `MQTT_HOST`, `MQTT_TOPIC`, `CV_JSON_URL`, `PUBLISH_INTERVAL_SECONDS` إلخ. |
| `computer-vision/README_AR.md` | شرح عربي للتكامل: الكاميرا → `/json` → الجسر → MQTT → SQL، مع تحذيرات (ما تشغّلش كاميرتين مع بعض). |
| `computer-vision/yolov8n.pt` | أوزان موديل YOLOv8 nano (ملف ثنائي مش كود). |

**مجلدات مولّدة مش في Git:** `computer-vision/.venv/` (بيئة بايثون)، `computer-vision/logs/`، و`computer-vision/.run/` (فيه `camera.pid`, `bridge.pid`, و `last-start/last-stop logs`). اتشالت نسخ `.bak-cv-speed-*` والمصدر القديم في `headcount_original/` لأن النسخة الحالية هي `web_count_campusx.py`.

---

## 7. مجلد `sql/` — قاعدة البيانات

| الملف | الشرح |
| --- | --- |
| `sql/CampusX_CreateDatabase.sql` | الـ baseline: ينشئ قاعدة `CampusX` والجداول الأساسية `Rooms`, `Node_Types`, `Nodes`, `Device_Types`, `Devices`, `Metrics`, `Device_Capabilities`, `Telemetry`, `Device_States`, `Users`, `Commands`, `Alert_Rules`, `Alerts`, `Audit_Logs` + seed للأنواع والمترية. |
| `sql/DashboardAccounts.sql` | ينشئ `dbo.DashboardAccounts` (يومًا ما كان بيعمله Node تلقائيًا). فيه `PasswordHash`, `SessionVersion`, وحقول الـ email verification. |
| `sql/20261031_AddCommandRequestedBy.sql` | يضيف `Commands.RequestedBy` ويعبّيه من `Users` القديم عشان سجل الأوامر. |
| `sql/20261031_Occupancy_Automation.sql` | يضيف إعدادات الأتمتة لكل غرفة: `PersonThreshold`, `OffDelaySeconds`, `FanDeviceCode`, `LightDeviceCode`, وحالة المرشّح. |
| `sql/seed-default-alert-rules.sql` | يزرع قاعدتين للحرارة: تحذير `>30` وحرج `>40`. |

---

## 8. مجلد `scripts/` — الأدوات والاختبارات

اتشالت سكربتات `apply-*.ps1` لأنها كانت برامج تركيب لمرة واحدة ونتيجتها مدمجة في الكود الحالي. المتبقّي أدوات فعّالة زي `setup-dashboard-auth.ps1`, `register-smoke.js`, `admin-smoke.js`, `smoke.js`, و`syntax-check.js`.

---

## 9. الثوابت اللي ما تتغيرمش بالغلط

1. SQL هو المصدر الوحيد للحقيقة — الـ eventHub/SSE مجرد عرض.
2. topics الافتراضية: `smart-campus/telemetry`, `smart-campus/devices/+/telemetry`, `smart-campus/devices/+/command-response`, و command على `smart-campus/devices/{deviceCode}/commands`.
3. كل حاجة QoS 1، والـ commands `retain=false`.
4. `command_id` **نص رقمي** (`"42"`) مش رقم JSON.
5. الـ telemetry dedupe بـ `(DeviceId, MetricId, MessageId)`.
6. الردود النهائية (`completed`, `failed`, `timeout`, `cancelled`) تتجاهل التكرار بـ `UPDLOCK,HOLDLOCK`.
7. تغيير بيانات الداشبورد بيزود `SessionVersion` وبيدخل كل الجلسات القديمة.
8. مسار CV: `web_count_campusx.py` → `/json` → `mqtt_bridge.py` → MQTT. ما تشغّلش `web_count.py` الأصلي معاه.

---

## 10. أوامر تستخدمها كل يوم

```powershell
cd D:\important\me\server\CampusX_Backend_v2

npm run check              # syntax + config + contract
npm run check:connections  # SQL + MQTT
npm start                  # تشغيل السيرفر
npm run smoke              # اختبار شامل لسيرفر شغال

# CV (غالبًا من الداشبورد، أو يدويًا):
powershell -File computer-vision\start-computer-vision.ps1
powershell -File computer-vision\stop-computer-vision.ps1
```

الـ health: `http://127.0.0.1:3000/api/v1/health`  
العقد الحي: `http://127.0.0.1:3000/docs` و `/docs/contract.json`

---

## 11. خلاصة ليا يا يسطا

لو حابب تبدأ تقرأ من غير ما تضيع:

1. `README.md` → الصورة العامة.
2. `src/server.js` → إيه اللي بيحصل عند التشغيل.
3. `src/app.js` → إيه الـ routes والصفحات.
4. `src/routes/api.js` → كل الـ endpoints.
5. `src/services/mqttService.js` و `telemetryService.js` و `commandResponseService.js` → قلب اللوجيك.
6. `public/control-panel-live.js` → كل اللي المستخدم شايفه.
7. `computer-vision/web_count_campusx.py` و `mqtt_bridge.py` → عدّاد الأشخاص.
8. `FIRMWARE_API_REFERENCE.md` → اللي تبعته لصاحبك.

والباقي ملفات نشطة أو أدوات اختبار؛ اقرأ `.env.example` و`API_CONTRACT.md` و`MQTT_CONTRACT.md` لو محتاج تفاصيل التشغيل.

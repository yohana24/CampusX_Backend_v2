# CampusX Dashboard — Login + Live Dashboard Patch

هذه الحزمة تجعل صفحة Login تظهر قبل لوحة التحكم، وتضيف مصادقة فعلية من جهة الخادم باستخدام حساب Operator واحد مضبوط من ملف `.env`، وكوكي جلسة موقّع `HttpOnly` و`SameSite=Strict`. صفحات Dashboard والـ API وSSE محمية بالجلسة. يظل `API_KEY` طبقة إضافية اختيارية لحماية API.

## ما الذي تتضمنه الحزمة؟

- `public/login.html` + `public/login.js`: نموذج تسجيل الدخول الأصلي، أصبح يرسل بيانات الاعتماد إلى `/auth/login` ولا يفتح Dashboard بمجرد الضغط.
- `public/auth-client.js`: يتحقق من الجلسة ويضيف زر Sign out لكل صفحة Dashboard.
- `public/dashboard-app.js`: يعيد توجيه المستخدم إلى صفحة Login عند انتهاء الجلسة بدل طلب API key عند كل 401.
- `src/middleware/dashboardAuth.js`: إنشاء والتحقق من جلسة موقعة، انتهاء صلاحية الجلسة، وتحديد محاولات تسجيل الدخول.
- `src/app.js`: يقدّم Login علنًا، ويحمي صفحات Dashboard وجميع API routes عدا `/api/v1/health`.
- `scripts/setup-dashboard-auth.ps1`: إعداد اسم المستخدم وكلمة المرور وإنشاء hash آمن باستخدام scrypt.

## مهم قبل التركيب

1. أوقف `npm start` باستخدام `Ctrl+C`.
2. من مجلد المشروع الرئيسي خذ نسخة احتياطية:

   ```powershell
   Copy-Item .\src\app.js .\src\app.js.before-login.bak
   Copy-Item .\public .\public.before-login -Recurse
   ```

3. فك محتويات ZIP في جذر `CampusX_Backend_v2` مع دمج مجلد `public` واستبدال `src/app.js` و`src/server.js`، وإضافة `src/middleware/dashboardAuth.js` وملفات `scripts`. لا تستبدل `src/routes` أو `src/services` أو `src/db`.
4. لا تستبدل `.env` أو `node_modules` أو `computer-vision/.venv` أو ملفات Computer Vision وFirmware.

## إنشاء حساب Dashboard

من PowerShell في جذر المشروع:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-dashboard-auth.ps1
```

أدخل اسم مستخدم، ثم كلمة مرور قوية لا تقل عن 12 حرفًا. سيطبع السكريبت ثلاثة أسطر إعدادات، تتضمن hash لكلمة المرور وليس كلمة المرور نفسها. انسخ الأسطر المطبوعة إلى نهاية ملف `.env` الرئيسي.

الإعدادات بالشكل التالي (القيم الفعلية سيولّدها السكريبت؛ لا تستخدم هذه القيم الوهمية):

```env
DASHBOARD_USERNAME=your-operator-name
DASHBOARD_PASSWORD_HASH=<salt-hex>:<scrypt-hash-hex>
DASHBOARD_SESSION_SECRET=<random-secret-generated-by-script>
DASHBOARD_SESSION_HOURS=8
DASHBOARD_COOKIE_SECURE=false
```

- `DASHBOARD_COOKIE_SECURE=false` مناسب للاختبار المحلي على `http://127.0.0.1`. عند النشر خلف HTTPS اضبطه إلى `true`.
- لا تضع كلمة المرور الخام في `.env` ولا تشارك `.env`.
- هذه مصادقة حساب Operator واحد، وليست نظام Users/Roles متعدد المستخدمين أو University SSO.
- كلمة المرور لا تُحفظ في SQL Server؛ يتم التحقق منها باستخدام scrypt hash في إعدادات الخادم.

## التشغيل

```powershell
npm start
```

افتح:

`http://127.0.0.1:3000/`

سيحوّلك السيرفر إلى `/login.html` إذا لم تكن مسجل الدخول. بعد نجاح تسجيل الدخول يفتح `/dashboard`، وهو Dashboard التصميم الأصلي. زر `Sign out` يظهر في شريط أعلى الصفحات.

## مسارات المصادقة

- `GET /login.html`: صفحة الدخول العامة.
- `POST /auth/login`: تسجيل الدخول وإنشاء Cookie جلسة HttpOnly.
- `GET /auth/session`: فحص الجلسة.
- `POST /auth/logout`: إلغاء الجلسة من المتصفح.
- `GET /` و`/dashboard` وصفحات HTML الداخلية: تتطلب جلسة صحيحة.
- `/api/v1/health`: فحص عام محدود.
- بقية `/api/v1/*` بما فيها SSE `/api/v1/stream`: تتطلب جلسة صحيحة، ثم يطبق `API_KEY` أيضًا إذا كان مضبوطًا.

## اختبار سريع

بعد تشغيل السيرفر:

```powershell
Invoke-WebRequest http://127.0.0.1:3000/login.html -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3000/auth/session -UseBasicParsing
```

الأمر الثاني يجب أن يرجع 401 قبل تسجيل الدخول. افتح `/` في المتصفح، سجل الدخول، ثم يجب أن يفتح Dashboard. بعد ذلك جرّب `Sign out`؛ يجب أن يعود `/` إلى صفحة Login.

## ملاحظات أمان

- أبقِ `HOST=127.0.0.1` أثناء التطوير المحلي.
- لا تفتح السيرفر على LAN/Internet قبل إعداد HTTPS، و`DASHBOARD_COOKIE_SECURE=true`، و`API_KEY`، ومراجعة CORS وMQTT firewall/authentication.
- الجلسة موقعة وموقّتة، وليست مخزنة في قاعدة بيانات؛ إلغاء كل الجلسات يتم بتغيير `DASHBOARD_SESSION_SECRET`.
- لا توجد ميزة استعادة كلمة المرور أو إدارة أدوار في هذا الإصدار.

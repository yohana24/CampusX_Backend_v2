import os
import sys
import cv2
from ultralytics import YOLO

# ============ الإعدادات ============
IMAGE = sys.argv[1] if len(sys.argv) > 1 else "test.webp"   # الاسم من الـ cmd أو الافتراضي
SIMULATE_240 = True      # True = يصغّر الصورة لـ 240 بكسل الأول عشان يحاكي الكاميرا
IMGSZ = 640
CONF = 0.20
MIN_AREA, MAX_AREA = 0.0008, 0.45
MIN_RATIO, MAX_RATIO = 0.6, 5.0
# ===================================

img = cv2.imread(IMAGE)
if img is None:
    raise SystemExit(f"مش لاقية الصورة '{IMAGE}' في الفولدر ده. اتأكدي من الاسم والامتداد.")

h, w = img.shape[:2]
if SIMULATE_240:
    s = 240 / max(h, w)
    img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    print("الصورة اتصغّرت لـ", img.shape[1], "x", img.shape[0])

# تكبير قبل الموديل (زي web_count)
h, w = img.shape[:2]
s = IMGSZ / max(h, w)
if s > 1:
    img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
h, w = img.shape[:2]

model = YOLO("head240.pt")
res = model.predict(img, conf=0.20, imgsz=IMGSZ, verbose=False)[0]

count = 0
for b, c in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist()):
    x1, y1, x2, y2 = b
    bw, bh = x2 - x1, y2 - y1
    area = bw * bh / (w * h)
    ok = (c >= CONF and MIN_AREA <= area <= MAX_AREA
          and bw > 0 and MIN_RATIO <= bh / bw <= MAX_RATIO)
    col = (0, 255, 0) if ok else (130, 130, 130)   # أخضر = اتحسب، رمادي = اتتجاهل
    count += ok
    cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), col, 2)
    cv2.putText(img, f"{c:.2f}", (int(x1), max(int(y1) - 6, 12)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1)

cv2.putText(img, f"count {count}", (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
cv2.imwrite("result.jpg", img)
print("عدد الأشخاص:", count)
print("النتيجة اتحفظت في result.jpg")
try:
    os.startfile("result.jpg")
except Exception:
    pass

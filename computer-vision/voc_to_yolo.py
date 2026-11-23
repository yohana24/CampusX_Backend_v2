import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

# Put this file inside the SCUT_HEAD_Part_A folder and run it from there.
ROOT = Path(__file__).resolve().parent
IMG_DIR = ROOT / "JPEGImages"
ANN_DIR = ROOT / "Annotations"
OUT = ROOT / "yolo_data"
EXTS = (".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG")


def find_list(*names):
    for n in names:
        hits = sorted(ROOT.glob(f"ImageSets/**/{n}.txt"))
        if hits:
            return hits[0]
    return None


def find_image(stem):
    for e in EXTS:
        p = IMG_DIR / f"{stem}{e}"
        if p.exists():
            return p
    return None


def convert_one(xml_path):
    root = ET.parse(xml_path).getroot()
    size = root.find("size")
    W, H = float(size.find("width").text), float(size.find("height").text)
    lines = []
    for obj in root.findall("object"):
        bb = obj.find("bndbox")
        x1, y1 = float(bb.find("xmin").text), float(bb.find("ymin").text)
        x2, y2 = float(bb.find("xmax").text), float(bb.find("ymax").text)
        x1, x2 = max(0.0, x1), min(W, x2)
        y1, y2 = max(0.0, y1), min(H, y2)
        if x2 <= x1 or y2 <= y1:
            continue
        cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
        bw, bh = (x2 - x1) / W, (y2 - y1) / H
        lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")   # class 0 = head
    return lines


splits = {"train": find_list("train"), "val": find_list("test", "val")}
for name, lst in splits.items():
    if lst is None:
        raise SystemExit(f"Could not find the list file for '{name}' inside ImageSets.")

for split, lst in splits.items():
    (OUT / "images" / split).mkdir(parents=True, exist_ok=True)
    (OUT / "labels" / split).mkdir(parents=True, exist_ok=True)
    ids = [l.split()[0] for l in lst.read_text().splitlines() if l.strip()]
    n_img = n_heads = skipped = 0
    for stem in ids:
        img = find_image(stem)
        xml = ANN_DIR / f"{stem}.xml"
        if img is None or not xml.exists():
            skipped += 1
            continue
        lines = convert_one(xml)
        shutil.copy2(img, OUT / "images" / split / img.name)
        (OUT / "labels" / split / f"{stem}.txt").write_text("\n".join(lines))
        n_img += 1
        n_heads += len(lines)
    print(f"{split}: {n_img} images, {n_heads} heads, {skipped} skipped  (list: {lst.name})")

(OUT / "data.yaml").write_text(
    f"path: {OUT.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: head\n",
    encoding="utf-8",
)
print("Done. Output folder:", OUT)

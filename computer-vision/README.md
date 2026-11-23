# Head Counter (ESP32-CAM + YOLOv8)

Counts how many people are in a room from a 240x240 camera image, with a live web page.

## Files
| File | What it does |
|---|---|
| `web_count3.py` | Final live counter (web page at http://localhost:5000, CSV log) |
| `voc_to_yolo.py` | Converts SCUT-HEAD (Pascal VOC XML) labels to YOLO format |
| `test_image.py` | Test the model on one image: `python test_image.py image.jpg` |
| `cam_test.py` | Check that the laptop webcam works |
| `head240.pt` | Trained model (YOLOv8n, one class: head) |
| `train_colab.ipynb` | Colab notebook: training and evaluation (full record of the results below) |

## Run
```
pip install -r requirements.txt
python web_count3.py --always        # test any time of day
python web_count3.py                 # normal run (counts only 09:00-15:00)
```
Open http://localhost:5000. Green box = confirmed head, gray = candidate, yellow = briefly lost, red = ignored zone.

## Use the ESP32-CAM
In `web_count3.py` set `SOURCE = "http://<ESP32_IP>:81/stream"` (or `.../capture`).
On the ESP32 set the frame size to 240x240 (`FRAMESIZE_240X240`).

## Remove fixed false detections ("ghosts")
With the room EMPTY run once: `python web_count3.py --calibrate`.
It saves `ignore_zones.json`; those spots are ignored afterwards. Delete the file to reset.

## Training (Google Colab, T4 GPU)
1. `python voc_to_yolo.py` inside the SCUT-HEAD Part A folder (1100 train / 500 val images), zip `yolo_data`.
2. Baseline: train YOLOv8n for 30 epochs at 640 px.
3. Preprocessing for the camera: downscale the images to 240 px (like the ESP32-CAM) and fine-tune 20 more epochs.
4. Pick the confidence threshold by measuring the count error per image.

## Results (SCUT-HEAD Part A, 500 validation images, 17,217 heads)
| Model / test images | mAP50 | Precision | Recall |
|---|---|---|---|
| Baseline, original resolution | 0.918 | 0.915 | 0.869 |
| Baseline, images downscaled to 240 px (imgsz 640) | 0.786 | 0.830 | 0.703 |
| Baseline, images downscaled to 240 px (imgsz 320) | 0.407 | 0.569 | 0.421 |
| **Fine-tuned on 240 px images (`head240.pt`), 240 px test** | **0.862** | 0.874 | 0.788 |

Count error per image on the 240 px validation set (average true count 34.4 heads):

| conf | 0.15 | **0.20** | 0.25 | 0.30 | 0.40 |
|---|---|---|---|---|---|
| Mean absolute error (heads) | 3.45 | **2.07** | 2.17 | 3.11 | 6.21 |

Notes: the validation set was also used to choose the best epoch and the confidence, so the numbers are slightly optimistic. Real-room performance (lighting, camera angle) must be checked with the live counter. Use imgsz 640, not 320.

Dataset: SCUT-HEAD (academic research use only) https://github.com/HCIILAB/SCUT-HEAD-Dataset-Release .

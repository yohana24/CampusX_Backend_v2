# CampusX Firmware Integration Guide

This guide is written for the person who owns the ESP32/relay firmware. The backend has already been configured to match the existing CampusX contract — **do not rename topics or change `command_id` format**.

## 0. The five rules

1. Subscribe to `smart-campus/devices/{DEVICE_CODE}/commands` with **QoS 1**.
2. Publish telemetry to `smart-campus/telemetry` (or `.../{DEVICE_CODE}/telemetry`) with **QoS 1**.
3. `command_id` is a **numeric string**: `"42"`, not `42`.
4. Always answer every command on `.../{DEVICE_CODE}/command-response` with **QoS 1** and the same `command_id`.
5. Include a stable `message_id` in telemetry so QoS-1 duplicates are ignored by the server.

## 1. What you need from the server owner

| Value | Example | Environment key |
| --- | --- | --- |
| Broker host | `192.168.1.50` | `MQTT_URL` |
| Broker port | `1883` | `MQTT_URL` |
| MQTT username/password | optional | `MQTT_USERNAME`, `MQTT_PASSWORD` |
| Your device code | `relay-lab-01` | registered in `dbo.Devices.DeviceCode` |
| Your node code | `node-lab-01` | registered in `dbo.Nodes.NodeCode` |
| Metric codes | `temperature`, `humidity`, `people_count` | registered in `dbo.Metrics.MetricCode` |

The device, node and room must all be `IsActive = 1` in SQL Server, otherwise telemetry is rejected and rolled back.

## 2. Telemetry — publish

Topic:

```text
smart-campus/telemetry
```

Payload:

```json
{
  "device_id": "esp32-lab-01",
  "node_code": "node-lab-01",
  "message_id": "esp32-lab-01-000123-1700000000000",
  "recorded_at": "2026-11-18T12:00:00.000Z",
  "readings": [
    { "metric": "temperature", "value": 25.5, "unit": "C" },
    { "metric": "humidity", "value": 55.2, "unit": "%" }
  ]
}
```

### How to build `message_id`

Use a monotonically increasing sequence kept in RTC/flash:

```text
message_id = DEVICE_CODE + "-" + pad(counter, 6) + "-" + millis_since_boot
```

Retrying the same physical reading must reuse the same `message_id`. A new reading gets a new one. This is what makes QoS-1 redelivery harmless.

### Timestamp

`recorded_at` is optional. If you send it, use ISO-8601 UTC. The server rejects timestamps more than `TELEMETRY_MAX_FUTURE_SECONDS` ahead or `TELEMETRY_MAX_PAST_SECONDS` behind server time. Sync your RTC/NTP.

### Value type

The `value` type must match the metric's SQL `DataType`:

| DataType | Valid JSON value |
| --- | --- |
| `numeric` | number, e.g. `25.5` |
| `text` | string |
| `boolean` | `true` / `false` |
| `json` | object or array |

## 3. Commands — subscribe and answer

Subscription:

```text
smart-campus/devices/{DEVICE_CODE}/commands    QoS 1
```

Incoming message:

```json
{
  "command_id": "42",
  "type": "set_state",
  "payload": { "state": "on" }
}
```

Response topic:

```text
smart-campus/devices/{DEVICE_CODE}/command-response
```

Response payload:

```json
{
  "command_id": "42",
  "success": true,
  "status": "completed",
  "result": { "state": "on" }
}
```

Failure example:

```json
{
  "command_id": "43",
  "success": false,
  "status": "failed",
  "result": { "error": "relay driver timeout" }
}
```

`result.state` may be `on` or `off`. The backend also accepts top-level `state`, but `result.state` is preferred.

### Command handling rules

- Parse `command_id` as a string; echo it unchanged.
- Execute idempotently: applying `set_state:on` twice must produce the same physical state.
- Publish the response even if execution fails; otherwise the dashboard shows the command as `sent` forever.
- QoS 1 may deliver the same command twice. If you already executed `command_id`, just resend the same response — the backend will ignore the duplicate safely.

## 4. Minimal Arduino/PubSubClient sketch

```cpp
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "...";
const char* WIFI_PASS = "...";
const char* MQTT_HOST = "192.168.1.50";
const uint16_t MQTT_PORT = 1883;
const char* DEVICE_CODE = "relay-lab-01";
const char* NODE_CODE  = "node-lab-01";

String cmdTopic, respTopic;
unsigned long telemetryCounter = 0;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

void publishTelemetry(float temperature, float humidity) {
  String messageId = String(DEVICE_CODE) + "-" +
                     String(telemetryCounter++) + "-" + String(millis());

  // Keep this compact if your device has little RAM; avoid String in production
  // by using snprintf into a fixed char buffer.
  String payload = "{";
  payload += "\"device_id\":\"" + String(DEVICE_CODE) + "\",";
  payload += "\"node_code\":\"" + String(NODE_CODE) + "\",";
  payload += "\"message_id\":\"" + messageId + "\",";
  payload += "\"readings\":[";
  payload += "{\"metric\":\"temperature\",\"value\":" + String(temperature, 2) + ",\"unit\":\"C\"},";
  payload += "{\"metric\":\"humidity\",\"value\":" + String(humidity, 2) + ",\"unit\":\"%\"}";
  payload += "]}";

  mqtt.publish("smart-campus/telemetry", payload.c_str(), true); // retained=false, QoS 1
}

void answerCommand(const String& commandId, bool success, const String& state) {
  String payload = "{\"command_id\":\"" + commandId + "\",";
  payload += "\"success\":" + String(success ? "true" : "false") + ",";
  payload += "\"status\":\"" + String(success ? "completed" : "failed") + "\",";
  payload += "\"result\":{";
  if (success) payload += "\"state\":\"" + state + "\"";
  else payload += "\"error\":\"command rejected\"";
  payload += "}}";

  mqtt.publish(respTopic.c_str(), payload.c_str(), true); // QoS 1
}

void onMqttMessage(char* topic, byte* raw, unsigned int length) {
  String body;
  body.reserve(length);
  for (unsigned int i = 0; i < length; i++) body += (char)raw[i];

  // Minimal parser example: extract command_id and desired state.
  int idStart = body.indexOf("\"command_id\":\"");
  if (idStart < 0) return;
  idStart += 14;
  int idEnd = body.indexOf('"', idStart);
  if (idEnd < 0) return;
  String commandId = body.substring(idStart, idEnd);

  String desired = "on";
  int statePos = body.indexOf("\"state\":\"");
  if (statePos >= 0) {
    statePos += 9;
    int stateEnd = body.indexOf('"', statePos);
    if (stateEnd > statePos) desired = body.substring(statePos, stateEnd);
  }

  bool ok = (desired == "on" || desired == "off");
  if (ok) {
    // TODO: drive the real relay here.
    digitalWrite(2, desired == "on" ? HIGH : LOW);
  }
  answerCommand(commandId, ok, desired);
}

void reconnect() {
  while (!mqtt.connected()) {
    String clientId = String("firmware-") + String(DEVICE_CODE) + "-" + String(random(0xffff), HEX);
    if (mqtt.connect(clientId.c_str())) {
      mqtt.subscribe(cmdTopic.c_str(), 1);
    } else {
      delay(2000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  cmdTopic  = String("smart-campus/devices/") + DEVICE_CODE + "/commands";
  respTopic = String("smart-campus/devices/") + DEVICE_CODE + "/command-response";

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1024);
}

void loop() {
  if (!mqtt.connected()) reconnect();
  mqtt.loop();

  static unsigned long last = 0;
  if (millis() - last > 5000) {
    last = millis();
    publishTelemetry(25.5, 55.2);
  }
}
```

> The sketch uses `String` for clarity. On a constrained device, replace it with `snprintf` into a fixed buffer.

## 5. Verification checklist

From the server machine:

```powershell
cd D:\important\me\server\CampusX_Backend_v2
npm run check:connections
npm start
```

In another terminal:

```powershell
node fake-actuator.js
```

Then from the dashboard (or `POST /api/v1/commands`):

```json
{ "deviceCode": "relay-lab-01", "commandType": "set_state", "payload": { "state": "on" } }
```

Expected:

1. `fake-actuator.js` prints `command_id=...` and `result.state=on`.
2. Backend logs `[Command] <id> -> completed`.
3. `GET /api/v1/commands/<id>` shows `status: completed`.
4. `GET /api/v1/states/latest?deviceId=...` shows `relay_state = on`.
5. Publishing the same response a second time does **not** add another audit row or state row.

Telemetry check:

```powershell
node fake-esp32.js
```

Then:

```text
GET /api/v1/telemetry/latest?metric=temperature
```

## 6. FAQ

**Do I need to retain command topics?** No. Commands are `retain=false`. Retained stale commands are dangerous.

**Can I send a number for `command_id`?** No. It must be a numeric string, e.g. `"42"`. This avoids precision/format issues across C, Python and JavaScript.

**What if the broker delivers my command twice?** Execute the state change idempotently and resend the same response. The backend ignores duplicates after the first terminal response.

**What if `people_count` automation sends a command my firmware doesn't know?** It is just `set_state`. If your device is a relay, it is already supported.

**Where do I read the live contract?** Open `http://<server>:3000/docs` or fetch `/docs/contract.json`.

# CampusX v2 — Firmware API & Endpoint Quick Reference

For the person writing the ESP32/relay firmware.

**Read this first:** the device talks to the backend over **MQTT**, not HTTP. The HTTP endpoints below are for provisioning, checking your device, and debugging from a PC. Nothing in this file may be changed unilaterally: topic names and `command_id` format are a fixed contract shared by firmware and backend.

- Deep MQTT guide: `MQTT_CONTRACT.md`
- Full firmware walkthrough + Arduino sketch: `FIRMWARE_INTEGRATION.md`
- Complete HTTP API: `API_CONTRACT.md`
- Live contract from the running server: `GET /docs` / `GET /docs/contract.json`

---

## 0. Ask the server owner for these values

| Value | Placeholder used below | Notes |
| --- | --- | --- |
| Server IP / hostname | `<SERVER_IP>` | Backend HTTP + MQTT broker host |
| HTTP port | `3000` | Base URL: `http://<SERVER_IP>:3000` |
| MQTT URL | `<MQTT_URL>` | e.g. `mqtt://<SERVER_IP>:1883` |
| MQTT username/password | `<MQTT_USER>` / `<MQTT_PASS>` | Optional; leave out if broker is anonymous |
| Your device code | `relay-lab-01` | Must equal `dbo.Devices.DeviceCode` exactly |
| Your node code | `node-lab-01` | Optional in payload; must match `dbo.Nodes.NodeCode` |
| Metric codes | `temperature`, `humidity`, `people_count` | Must exist in `dbo.Metrics` |
| Dashboard login + API key | `<USERNAME>` / `<PASSWORD>` / `<API_KEY>` | Needed only for the HTTP calls below, not for firmware MQTT |

The device, its node and its room must all be `IsActive = 1` in SQL Server. If not, the whole telemetry batch is rejected and rolled back.

---

## 1. HTTP API at a glance

Base path: `/api/v1`  
Example base URL: `http://127.0.0.1:3000`

### Authentication

| Request | Requirement |
| --- | --- |
| `GET /api/v1/health` | Public |
| `GET /docs`, `GET /docs/contract.json` | Public |
| Every other `/api/v1/*` | Signed dashboard cookie `campusx_session` from `POST /auth/login` |
| Write operations (`POST`/`PUT`/`PATCH`) | Also require header `X-API-Key: <API_KEY>` when the server has `API_KEY` configured |

Cookie flags: `HttpOnly`, `SameSite=Strict`, optionally `Secure`.

### Standard response shape

```json
{
  "status": "ok",
  "data": [],
  "count": 0,
  "limit": 100,
  "offset": 0
}
```

Errors:

```json
{
  "status": "error",
  "error": { "code": "VALIDATION_ERROR", "message": "..." }
}
```

Common codes: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `AUTH_NOT_CONFIGURED`, `API_KEY_REQUIRED`, `NOT_FOUND`, `MQTT_PUBLISH_FAILED`, `INVALID_COMMAND_TYPE`, `ROUTE_NOT_FOUND`.

Pagination for commands/alerts/states: `limit=1..500` (default `100`), `offset>=0` (default `0`).

---

## 2. Endpoints you will actually use

### Login (once per debugging session)

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/auth/login` | `{ "username": "<USERNAME>", "password": "<PASSWORD>" }` → sets `campusx_session` |
| GET | `/auth/session` | Check the cookie is still valid |
| POST | `/auth/logout` | End session |
| GET | `/auth/account` | Current account |
| POST | `/auth/account/credentials` | Change dashboard credentials (server owner only) |

### Provisioning / discovery

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/health` | Public. `db`, `mqtt`, `auth` checks; `?strict=1` → 503 if degraded |
| GET | `/api/v1/devices` | Filters `roomId` (alias `labId`), `nodeId`, `active`, `status`. Returns `deviceId`, `deviceCode`, `nodeCode`, `roomId`, `status`. |
| GET | `/api/v1/metrics` | Returns every `metricCode` with its `dataType` (`numeric`, `text`, `boolean`, `json`) and `defaultUnit`. |
| GET | `/api/v1/device-capabilities?deviceTypeId=<id>` | Which metrics a device type can read/write/event. |
| GET | `/api/v1/rooms` | Rooms/labs; `?active=true`, `?search=`. |

### Verify telemetry and commands

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/telemetry/latest?deviceId=<id>&metric=temperature` | Latest point per `(DeviceId, Metric)`. Also accepts `roomId`, `from`, `to`. |
| GET | `/api/v1/telemetry?deviceId=<id>&metric=temperature&limit=20` | Raw history; compat fields `device_id`, `metric`, `value`, `recorded_at`. |
| GET | `/api/v1/commands?deviceId=<id>&status=sent&limit=20` | Commands waiting for your device. Statuses: `pending`, `sent`, `completed`, `failed`, `timeout`, `cancelled`. |
| GET | `/api/v1/commands/<commandId>` | Final status and parsed `payload`. This is the HTTP mirror of your MQTT response. |
| GET | `/api/v1/states/latest?deviceId=<id>` | Confirmed `relay_state = on|off` written after your acknowledgement. |
| GET | `/api/v1/states?deviceId=<id>&limit=20` | State history. |

### Send a command (normally from the dashboard/backend, not from firmware)

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/commands` | Creates SQL row first, allocates `CommandId`, publishes MQTT QoS 1, then marks `sent`. |

```json
POST /api/v1/commands
{
  "deviceCode": "relay-lab-01",
  "commandType": "set_state",
  "payload": { "state": "on" }
}
```

Response:

```json
{
  "status": "ok",
  "message": "Command published; awaiting device response",
  "data": {
    "commandId": 42,
    "deviceCode": "relay-lab-01",
    "commandType": "set_state",
    "status": "sent",
    "topic": "smart-campus/devices/relay-lab-01/commands"
  }
}
```

Rules: `deviceId` **or** `deviceCode` is required; device and node must be active; requester comes from the signed session, never from JSON; `set_state` needs `state: "on"|"off"` or a boolean; the MQTT `command_id` is `String(commandId)` — a **numeric string**.

Optional manual state record:

```json
POST /api/v1/states
{ "deviceCode": "relay-lab-01", "stateCode": "relay_state", "stateValue": "on" }
```

### Live events for the dashboard (not needed by firmware)

```text
GET /api/v1/stream?types=telemetry,alert,command,device.state
```

SSE events: `ready`, `server.shutdown`, `telemetry`, `alert`, `command`, `device.state`, `device.status`, `room.created`, `room.updated`, `node.created`, `node.updated`, `metric.created`, `metric.updated`, `alert-rule.created`, `alert-rule.updated`, `occupancy.automation`. Heartbeat every 20s.

---

## 3. Copy-paste curl examples

```bash
BASE=http://<SERVER_IP>:3000

# 1) login -> save cookie
curl -c cookies.txt -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{ "username": "<USERNAME>", "password": "<PASSWORD>" }'

# 2) find your device and its numeric id
curl -b cookies.txt "$BASE/api/v1/devices?active=true"

# 3) check which metric codes/types are registered
curl -b cookies.txt "$BASE/api/v1/metrics"

# 4) send a command (write => needs API key)
curl -b cookies.txt -X POST "$BASE/api/v1/commands" \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <API_KEY>' \
  -d '{ "deviceCode": "relay-lab-01", "commandType": "set_state", "payload": { "state": "on" } }'

# 5) check whether the device acknowledged it
curl -b cookies.txt "$BASE/api/v1/commands/42"

# 6) confirm the stored relay state
curl -b cookies.txt "$BASE/api/v1/states/latest?deviceId=<DEVICE_ID>"

# 7) confirm telemetry arrived
curl -b cookies.txt "$BASE/api/v1/telemetry/latest?deviceId=<DEVICE_ID>&metric=temperature"
```

Public checks need no cookie:

```bash
curl "http://<SERVER_IP>:3000/api/v1/health"
curl "http://<SERVER_IP>:3000/docs"
curl "http://<SERVER_IP>:3000/docs/contract.json"
```

---

## 4. MQTT contract (the actual firmware link)

Broker: `<MQTT_URL>` · QoS **1** everywhere · `retain=false` for commands · UTF-8 JSON only.

| Direction | Topic | Purpose |
| --- | --- | --- |
| Device → Server | `smart-campus/telemetry` | Batched readings; device id in payload |
| Device → Server | `smart-campus/devices/{DEVICE_CODE}/telemetry` | Same payload; device id may come from topic |
| Device → Server | `smart-campus/devices/{DEVICE_CODE}/command-response` | Terminal acknowledgement |
| Server → Device | `smart-campus/devices/{DEVICE_CODE}/commands` | Command delivery |

`{DEVICE_CODE}` is URL-encoded on publish and URL-decoded on receive. Topic segments are configurable via `MQTT_TELEMETRY_TOPIC`, `MQTT_DEVICE_TELEMETRY_TOPIC`, `MQTT_COMMAND_RESPONSE_TOPIC`, `MQTT_COMMAND_TOPIC_PREFIX` — do not change them without changing the backend too.

### The five rules

1. Subscribe to `.../commands` with **QoS 1**.
2. Publish telemetry with **QoS 1**.
3. `command_id` is a **numeric string**: `"42"`, never `42`.
4. Always answer on `.../command-response` with **QoS 1** and the same `command_id`.
5. Include a stable `message_id` in telemetry so QoS-1 duplicates are ignored.

### Telemetry publish

Topic: `smart-campus/telemetry`

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

| Field | Required | Rule |
| --- | --- | --- |
| `device_id` / `deviceCode` / `device_code` | Conditional | Top-level or per-reading; topic wildcard also counts |
| `node_code` | No | If present, must match registered node |
| `message_id` | Strongly recommended | String, max 100 chars; dedupe key |
| `recorded_at` / `timestamp` | No | ISO-8601 UTC; bounded by server config |
| `readings` | Yes | 1..`MAX_READINGS_PER_MESSAGE` objects |
| `readings[].metric` | Yes | Registered `MetricCode`; `[A-Za-z0-9_.:-]{1,100}` |
| `readings[].value` | Yes | Must match metric `DataType` |
| `readings[].unit` | No | Informational only |
| `readings[].device_id` | Conditional | Overrides top-level device for that reading |

Build `message_id` as `DEVICE_CODE + "-" + pad(counter,6) + "-" + millis_since_boot` and **reuse it when retrying the same physical reading**. Dedupe key on the server is `(DeviceId, MetricId, MessageId)`.

### Command received by firmware

Topic: `smart-campus/devices/relay-lab-01/commands` · QoS 1 · retain false

```json
{
  "command_id": "42",
  "type": "set_state",
  "payload": { "state": "on" }
}
```

### Response firmware must publish

Topic: `smart-campus/devices/relay-lab-01/command-response` · QoS 1

```json
{
  "command_id": "42",
  "success": true,
  "status": "completed",
  "result": { "state": "on" }
}
```

Failure:

```json
{
  "command_id": "43",
  "success": false,
  "status": "failed",
  "result": { "error": "relay driver timeout" }
}
```

`success` may be omitted: `status:"completed"` → true, `status:"failed"` → false. `result.state` may be `on`/`off`; top-level `state` is also accepted. On success with `on`/`off`, the backend writes one `Device_States` row (`StateCode = relay_state`) and emits SSE `device.state`.

**Idempotency:** the backend locks the command row (`UPDLOCK, HOLDLOCK`). After the first terminal response (`completed`, `failed`, `timeout`, `cancelled`), duplicates are ignored: no second update, no extra audit row, no extra state row, no duplicate SSE. So on a repeated QoS-1 command, just execute idempotently and resend the same response.

---

## 5. Integration checklist

1. Get `<SERVER_IP>`, `<MQTT_URL>`, `DEVICE_CODE`, `NODE_CODE`, metric codes from the server owner.
2. Confirm `GET /api/v1/devices` lists your device with `isActive: true`.
3. Confirm `GET /api/v1/metrics` contains every metric you plan to publish.
4. Firmware: connect MQTT, subscribe `.../commands` QoS 1, set `setBufferSize(1024)`.
5. Publish one telemetry message with a stable `message_id`; verify `GET /api/v1/telemetry/latest`.
6. From the dashboard (or `POST /api/v1/commands`), send `set_state:on`.
7. Firmware receives `command_id:"..."`, drives the relay, publishes `command-response` QoS 1.
8. Verify `GET /api/v1/commands/<id>` → `status: completed` and `GET /api/v1/states/latest` → `relay_state = on`.
9. Republish the same response once more: nothing should duplicate.
10. Power-cycle/reboot firmware: reconnect, resubscribe, keep the sequence counter in flash/RTC.

---

## 6. Simulation tools on the server

```powershell
cd D:\important\me\server\CampusX_Backend_v2
npm run check                 # config + contract validation only
npm run check:connections     # probe SQL Server + MQTT broker
node fake-esp32.js            # simulated telemetry publisher
node fake-actuator.js         # simulated relay that answers commands
```

`fake-actuator.js` implements the exact response shape above; use it as a reference implementation.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Telemetry rejected / nothing in SQL | Device, node or room inactive | Ask owner to set `IsActive = 1` in SQL |
| `Metric ... is not registered` | Wrong `MetricCode` | Use a code from `GET /api/v1/metrics` |
| `recorded_at is too far in the future/past` | Device clock drift | Sync RTC/NTP or widen server bounds |
| Command stays `sent` forever | No `command-response` published | Always answer, even on failure |
| `command_id must match the numeric Commands.CommandId` | Sent `42` as JSON number | Echo the string `"42"` verbatim |
| `Command ... not found for device ...` | Wrong device code in response topic | Use exact `deviceCode` from the command topic |
| `MQTT publish timed out` | Broker/network issue | Check broker, `MQTT_PUBLISH_TIMEOUT_MS` |
| `API_KEY_REQUIRED` / `AUTH_REQUIRED` on HTTP | Missing cookie or API key | Log in first and send `X-API-Key` for writes |
| Duplicated state rows | `message_id` reused for new readings, or non-idempotent relay code | New reading → new `message_id`; make `set_state` idempotent |

---

## 8. Reminders

- Commands are **never** retained. A retained stale `on` is dangerous.
- `people_count` automation just sends ordinary `set_state` — no extra firmware feature needed.
- The dashboard never talks MQTT directly; MQTT is the device uplink, HTTP/SSE is the dashboard side.
- Live, always-current contract: `http://<SERVER_IP>:3000/docs` and `/docs/contract.json`.

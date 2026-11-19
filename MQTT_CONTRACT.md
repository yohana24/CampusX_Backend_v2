# CampusX Backend v2 — MQTT Contract

Broker: configured by `MQTT_URL` (default `mqtt://localhost:1883`)  
QoS: `MQTT_QOS` (default **1**) for every subscription and publish  
Retain: **false** for commands  
Payload: UTF-8 JSON objects only  

All topic names are configurable. The defaults below are the firmware contract and must stay unchanged unless both firmware and backend are updated together.

## 1. Topics

| Direction | Topic | Purpose |
| --- | --- | --- |
| Device → Server | `smart-campus/telemetry` | Batched readings; device id may be in the payload. |
| Device → Server | `smart-campus/devices/{deviceCode}/telemetry` | Same payload; device id may come from topic. |
| Device → Server | `smart-campus/devices/{deviceCode}/command-response` | Terminal acknowledgement of a command. |
| Server → Device | `smart-campus/devices/{deviceCode}/commands` | Command delivery. |

`{deviceCode}` is URL-encoded by the server when publishing, and URL-decoded when receiving.

The backend derives its matchers from:

```text
MQTT_TELEMETRY_TOPIC
MQTT_DEVICE_TELEMETRY_TOPIC
MQTT_COMMAND_RESPONSE_TOPIC
MQTT_COMMAND_TOPIC_PREFIX
```

`+` and `#` wildcards are supported in configured subscriptions. The **first** wildcard in a device topic is treated as `deviceCode`.

## 2. Client identity

The backend client id is generated from `MQTT_CLIENT_ID`:

```text
campusx-backend-${process.pid}-${random}
```

Supported placeholders:

- `${process.pid}` — current Node process id
- `${hostname}` — sanitised machine hostname
- `${random}` — random hex

If you configure a fixed id without a placeholder, the server appends pid + random bytes automatically. This prevents one backend instance from silently kicking another off the broker.

Optional credentials: `MQTT_USERNAME`, `MQTT_PASSWORD`.

## 3. Telemetry payload

```json
{
  "device_id": "esp32-lab-01",
  "node_code": "node-lab-01",
  "message_id": "esp32-lab-01-1700000000000-1",
  "recorded_at": "2026-11-18T12:00:00.000Z",
  "readings": [
    { "metric": "temperature", "value": 25.5, "unit": "C" },
    { "metric": "humidity", "value": 55.2, "unit": "%" },
    { "metric": "people_count", "value": 2,
      "device_id": "cv-camera-lab-01" }
  ]
}
```

### Field rules

| Field | Required | Rule |
| --- | --- | --- |
| `device_id` / `deviceCode` / `device_code` | Conditional | Required globally or per reading; topic wildcard also counts. |
| `node_code` | No | If present, must match the registered node. |
| `message_id` | Strongly recommended | String, max 100 chars. Needed for QoS-1 dedupe. |
| `recorded_at` / `timestamp` | No | ISO date/time. Bounded by `TELEMETRY_MAX_FUTURE_SECONDS` and `TELEMETRY_MAX_PAST_SECONDS`. |
| `readings` | Yes | 1..`MAX_READINGS_PER_MESSAGE` objects. |
| `readings[].metric` | Yes | Registered `dbo.Metrics.MetricCode`; pattern `^[A-Za-z0-9_.:-]{1,100}$`. |
| `readings[].value` | Yes | Must match the metric `DataType`: numeric / text / boolean / json object. |
| `readings[].unit` | No | String; informational. |
| `readings[].device_id` | Conditional | Overrides the top-level device for that reading. |

### Device discovery

The device must exist in SQL Server as active, its node must be active, and its room must be active. Unknown devices reject the whole batch (transaction rollback) and the error is logged.

### Duplicate handling

The backend ignores a reading when this tuple already exists:

```text
(DeviceId, MetricId, MessageId)
```

With QoS 1, the broker may deliver the same publish more than once. Always include a stable `message_id` derived from device + boot sequence + timestamp, and reuse it on retry of the same physical message.

`people_count` readings that are actually inserted trigger occupancy-automation evaluation.

## 4. Command payload (server → device)

```json
{
  "command_id": "42",
  "type": "set_state",
  "payload": { "state": "on" }
}
```

| Field | Rule |
| --- | --- |
| `command_id` | **Numeric string**, e.g. `"42"`, never a JSON number. Maps to `dbo.Commands.CommandId`. |
| `type` | Command type. Optional allowlist via `COMMAND_TYPES`. |
| `payload` | JSON object. `set_state` expects `state: "on"|"off"` or a boolean. |

Published with:

```text
QoS = 1
retain = false
```

Do not treat an unknown `type` as an error at transport level; acknowledge with `success:false` and an error message if your firmware does not implement it.

## 5. Command response payload (device → server)

```json
{
  "command_id": "42",
  "success": true,
  "status": "completed",
  "result": { "state": "on" }
}
```

| Field | Rule |
| --- | --- |
| `command_id` | Same numeric string received in the command. |
| `success` | Boolean. If omitted, `status:"completed"` → true, `status:"failed"` → false. |
| `status` | `completed` or `failed`. |
| `result.state` | `on` or `off`. Top-level `state` is also accepted for compatibility. |
| `error` | Optional string when failed. Stored as part of the response in audit details. |

When `success` is true and the state is `on`/`off`, the backend writes one row to `dbo.Device_States`:

```text
StateCode  = relay_state
StateValue = on | off
```

An SSE `device.state` event is emitted.

### Idempotency guarantee

The command row is locked with `UPDLOCK, HOLDLOCK`. Once its status is terminal (`completed`, `failed`, `timeout`, `cancelled`), a duplicate response is ignored:

- no second `Commands` update
- no second `Audit_Logs` row
- no second `Device_States` row
- no duplicate SSE events

This makes QoS-1 redelivery safe without requiring the firmware to implement its own acknowledgement database.

## 6. Command lifecycle

```text
Dashboard POST /commands
        │
        ├─ INSERT dbo.Commands(status=pending)  ← command_id allocated here
        ├─ INSERT dbo.Audit_Logs(command_sent)
        ├─ MQTT publish QoS1 to .../commands
        ├─ UPDATE status=sent
        └─ SSE 'command'
                     │
                     ▼
              Device executes
                     │
        MQTT publish QoS1 to .../command-response
                     ▼
Backend transaction:
        ├─ lock command row
        ├─ status=completed|failed
        ├─ one audit row: command_response
        ├─ optional relay_state row
        └─ SSE 'command' + 'device.state'
```

## 7. Occupancy automation interaction

When a `people_count` reading is newly inserted:

1. Backend finds the device's room.
2. It reads `dbo.Occupancy_Automation_Settings`.
3. If enabled and the count condition remains stable for `offDelaySeconds`, it sends `set_state` to the configured fan/light actuators.
4. Before sending, it checks the latest confirmed state in SQL. If it already matches, the command is skipped with `already_set`.

The firmware does not need to know anything about this feature; it receives ordinary `set_state` commands.

## 8. Testing tools

```powershell
# Validate configuration and contract only
npm run check

# Probe SQL Server + MQTT broker
npm run check:connections

# Simulated telemetry publisher
node fake-esp32.js

# Simulated relay that answers commands
node fake-actuator.js
```

`fake-actuator.js` implements the exact response shape above, including `result.state`.

## 9. Common failure signals

| Log line | Meaning | Fix |
| --- | --- | --- |
| `MQTT publish timed out` | Broker accepted connection but no PUBACK | Check broker health/network and `MQTT_PUBLISH_TIMEOUT_MS`. |
| `MQTT broker is not connected` | Publish attempted while offline | Wait for reconnect; command remains `failed` if publish was attempted. |
| `command_id must match the numeric Commands.CommandId` | Firmware echoed a non-numeric id | Echo `command_id` verbatim as a numeric string. |
| `Command ... not found for device ...` | Wrong topic device code or stale command | Use the exact `deviceCode` from the command topic. |
| `recorded_at is too far in the future/past` | Device clock drift | Sync RTC/NTP or widen the configured bounds. |
| `Metric ... is not registered` | MetricCode typo | Add it via `POST /api/v1/metrics`. |

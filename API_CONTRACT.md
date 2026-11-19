# CampusX Backend v2 — HTTP API Contract

Base path: `/api/v1`  
Base URL example: `http://127.0.0.1:3000`

A live, configuration-aware version of this document is available at:

- `GET /docs` — readable page
- `GET /docs/contract.json` — JSON
- Firmware-focused quick reference (MQTT topics, HTTP endpoints, payloads): `FIRMWARE_API_REFERENCE.md`

## 1. Authentication

| Request | Requirement |
| --- | --- |
| `GET /api/v1/health` | Public |
| All other `/api/v1/*` | Signed dashboard cookie from `POST /auth/login` |
| Write operations | Also require `X-API-Key` when `API_KEY` is configured |
| `GET /api/v1/stream` | Cookie + (`X-API-Key` header or `?apiKey=` query, if `API_KEY` is configured) |

Authentication endpoints:

```text
GET  /login.html
POST /auth/login        { "username": "...", "password": "..." }
GET  /auth/session
POST /auth/logout
GET  /auth/account
POST /auth/account/credentials
```

The session cookie is `campusx_session`, `HttpOnly`, `SameSite=Strict`, and optionally `Secure`. Changing dashboard credentials increments `SessionVersion`, which invalidates previously issued cookies.

## 2. Response format

Success:

```json
{
  "status": "ok",
  "data": [],
  "count": 0,
  "limit": 100,
  "offset": 0
}
```

Some create/update endpoints return only `{ "status": "ok", "data": { ... } }`.

Error:

```json
{
  "status": "error",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "capacity must be an integer between 0 and 2147483647 or null"
  }
}
```

Common codes:

| Code | Meaning |
| --- | --- |
| `VALIDATION_ERROR` | Bad input shape/range |
| `AUTH_REQUIRED` | No valid dashboard session |
| `AUTH_NOT_CONFIGURED` | SQL/auth bootstrap not ready yet |
| `API_KEY_REQUIRED` | Missing/invalid `X-API-Key` |
| `ORIGIN_NOT_ALLOWED` | Origin not listed in `CORS_ORIGINS` |
| `NOT_FOUND` | Resource does not exist |
| `MQTT_PUBLISH_FAILED` | Command saved in SQL but broker publish failed |
| `INVALID_COMMAND_TYPE` | `COMMAND_TYPES` allowlist rejected the type |
| `ROUTE_NOT_FOUND` | Unknown route |

## 3. Filters and pagination

Telemetry accepts:

```text
roomId | labId, deviceId, metric, from, to, limit
```

Commands, alerts and states use:

```text
limit=1..500 (default 100)
offset>=0 (default 0)
```

Paginated responses include:

```text
count, limit, offset, total, page, totalPages
```

`from`/`to` must be valid dates, and `from <= to`.

## 4. Endpoint reference

### Health and diagnostics

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Public. `status` is `ok` or `degraded`. Includes DB/MQTT/auth checks, uptime, `startedAt`. `?strict=1` returns 503 when degraded (`STRICT_HEALTH=true` has the same effect). |
| GET | `/db-check` | SQL round trip, server time, device count, pool state, latency ms. |
| GET | `/sqlserver/health` | Database name and base-table count. |
| GET | `/dashboard/summary` | Active rooms/devices, online devices, open alerts, readings last 24h, 10 recent alerts. |

Example:

```bash
curl http://127.0.0.1:3000/api/v1/health
curl -b cookies.txt -H "X-API-Key: $API_KEY" http://127.0.0.1:3000/api/v1/db-check
```

### Rooms

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/rooms` | Filters: `active`, `search`. `GET /labs` is a legacy alias. |
| GET | `/rooms/:id` | Room plus `nodeCount` and `deviceCount`. |
| POST | `/rooms` | `{ roomCode, roomName, capacity?, locationDetails? }` |
| PATCH | `/rooms/:id` | Partial update. `capacity` and `locationDetails` may be `null`; `roomCode`/`roomName` may not. |

Example:

```bash
curl -X PATCH http://127.0.0.1:3000/api/v1/rooms/1 \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $API_KEY" \
  -b cookies.txt \
  -d '{ "capacity": 40, "locationDetails": null }'
```

### catalogue: node types, nodes, device types, devices, metrics, capabilities

| Method | Path | Notes |
| --- | --- | --- |
| GET, POST | `/node-types` | Node categories. |
| GET, POST, PATCH | `/nodes` | `?roomId=`, `?labId=` on GET. PATCH by id in body/route. |
| GET, POST, PATCH | `/device-types` | `category` ∈ `sensor`, `actuator`, `camera`, `other`. |
| GET, POST, PATCH | `/devices` | GET filters: `roomId`, `nodeId`, `active`, `status`. |
| GET, POST, PATCH | `/metrics` | `dataType` ∈ `numeric`, `text`, `json`, `boolean`. |
| GET, POST, PATCH | `/device-capabilities` | `capabilityType` ∈ `read`, `write`, `event`. |

JSON fields (`configJson`, `defaultConfigJson`, `metadataJson`, `payload`) accept either an object or a JSON-encoded string. Values are validated with SQL Server `ISJSON` constraints.

### Alert rules and alerts

| Method | Path | Notes |
| --- | --- | --- |
| GET, POST, PATCH | `/alert-rules` | Operators: `>`, `>=`, `<`, `<=`, `=`, `!=`, `changed`. |
| GET | `/alerts` | Filters: `status`, `severity`, `roomId`, `deviceId`, `limit`. |
| GET | `/alerts/:id` | Single alert. |
| PATCH | `/alerts/:id` | `{ "status": "open|acknowledged|resolved|closed" }` |
| POST | `/alerts/:id/acknowledge` | Alias for status `acknowledged`. |
| POST | `/alerts/:id/resolve` | Alias for status `resolved`. |

`ResolvedAt` is set once when status becomes `resolved` or `closed`, and cleared when moved back to `open`/`acknowledged`.

### Telemetry

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/telemetry` | Paginated history; filters described above. Compat fields include `id`, `device_id`, `lab_id`, `metric`, `value`, `recorded_at`. |
| GET | `/telemetry/latest` | Latest point per `(DeviceId, MetricId)`. |

```json
{
  "status": "ok",
  "count": 2,
  "data": [
    {
      "telemetryId": 912,
      "deviceId": 3,
      "deviceCode": "esp32-lab-01",
      "metricCode": "temperature",
      "valueNumeric": 25.5,
      "value": 25.5,
      "recordedAt": "2026-11-18T12:00:00.000Z"
    }
  ]
}
```

### Commands

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/commands` | Creates SQL row, publishes MQTT command, marks `sent` or `failed`. |
| GET | `/commands` | Paginated history. Filters: `deviceId`, `roomId`, `status`, `limit`, `offset`. |
| GET | `/commands/:id` | Command detail including parsed `payload`. |

Create command:

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

Rules:

- `deviceId` or `deviceCode` is required; the device and its node must be active.
- The requester comes from the signed session, never from request JSON.
- If `COMMAND_TYPES` is set, `commandType` must be in the allowlist.
- For `set_state`, `payload.state` must be `on`, `off`, or a boolean.
- `command_id` sent to MQTT is `String(commandId)`.
- A terminal device response updates `Commands.Status`; duplicate responses are ignored.

### States

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/states` | History. `?deviceId=`, `?limit=`. |
| GET | `/states/latest` | Latest row per `(DeviceId, StateCode)`. |
| POST | `/states` | Manual record by `deviceId` or `deviceCode`. |

Actuator confirmations from firmware are stored under `StateCode = relay_state` with `StateValue = on|off`.

### Occupancy automation

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/occupancy-automation?roomId=1` | Settings + discovered room actuators. |
| PUT | `/occupancy-automation` | Save settings. |

Body:

```json
{
  "roomId": 1,
  "isEnabled": true,
  "personThreshold": 3,
  "offDelaySeconds": 30,
  "restoreOnAboveThreshold": true,
  "fanDeviceCode": "fan-relay-lab-01",
  "lightDeviceCode": "light-relay-lab-01"
}
```

Automation triggers only from newly saved `people_count` readings. The condition must remain stable for `offDelaySeconds` before commands are sent.

### Computer Vision

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/computer-vision/status` | Camera/bridge process snapshot. |
| POST | `/computer-vision/start` | Runs configured PowerShell start script. |
| POST | `/computer-vision/stop` | Runs configured PowerShell stop script. |

Execution policy comes from `CAMPUSX_POWERSHELL_EXECUTION_POLICY` (default `RemoteSigned`), not from hardcoded `-ExecutionPolicy Bypass`.

### Live stream (SSE)

```text
GET /api/v1/stream?types=telemetry,alert,command,device.state
```

Event names:

- `ready`
- `server.shutdown` (sent immediately before the connection is closed during graceful shutdown)
- `telemetry`
- `alert`
- `command`
- `device.state`
- `device.status`
- `room.created`, `room.updated`
- `node.created`, `node.updated`
- `metric.created`, `metric.updated`
- `alert-rule.created`, `alert-rule.updated`
- `occupancy.automation`

Heartbeat lines are sent every 20 seconds. The connection is cleaned up on `close`, and server shutdown has a timeout fallback.

## 5. Idempotency contract

| Event | Key | Result on duplicate |
| --- | --- | --- |
| Telemetry | `(DeviceId, MetricId, MessageId)` | Reading skipped; `duplicateSkipped` increases. |
| Command response | `CommandId` + terminal status | Response ignored; no second audit row, no second state row. |
| Command send | SQL row created first | MQTT failure marks command `failed`; no orphan publish without history. |
| Automation command | Latest confirmed `relay_state` | Redundant command suppressed. |

## 6. Recommended client flow for command acknowledgement

```text
1. POST /commands                -> commandId 42, status=sent
2. MQTT command {command_id:"42"} delivered QoS 1
3. Device publishes command-response QoS 1
4. Backend sets Commands.Status=completed/failed, inserts one audit row,
   inserts relay_state when result.state is on/off, emits SSE 'command'.
5. Dashboard polls GET /commands/42 or listens to SSE.
```

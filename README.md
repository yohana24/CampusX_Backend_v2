# CampusX Backend v2

> SQL Server is the single source of truth. MQTT is the device uplink. SSE is the live dashboard downlink.
>
> ملاحظة ليوحنا: الـ firmware contract اتثبّت زي ما هو — نفس Topics، QoS 1، و`command_id` كنص رقمي.

CampusX Backend v2 is a hardened Node.js/Express service for an IoT lab. It ingests batched telemetry from ESP32-class devices, stores everything in SQL Server, evaluates configurable alert rules, drives actuators with idempotent MQTT commands, runs people-count automation, and streams live events to the dashboard over Server-Sent Events.

## Architecture

```text
ESP32 / Camera ──MQTT QoS1──> Mosquitto ──> CampusX Backend v2 ──> SQL Server (CampusX)
                                   │                  │                    │
                                   │                  ├─ Alert engine ─────┤
                                   │                  ├─ Occupancy automation
                                   │                  └─ HMAC session + API key
                                   │
                        Commands ───┘ (smart-campus/devices/{deviceCode}/commands)

Browser dashboard ──HTTPS/HTTP + signed cookie──> Express
                  └──SSE /api/v1/stream──<── eventHub (telemetry, alert, command, device.state)
```

### Why this design is friendly to firmware authors

1. **One contract, no guessing.** `GET /docs` renders a readable contract page; `GET /docs/contract.json` returns the same information as JSON.
2. **Topics are configuration, not source code.** Changing `MQTT_*_TOPIC` changes both subscriptions and dispatch matching.
3. **QoS 1 duplication is safe.** Repeated telemetry `message_id` values are ignored, and a repeated command response is ignored once the command is terminal.
4. **`command_id` is a numeric string** mapped directly to `dbo.Commands.CommandId` — no parsing ambiguity in C/C++.
5. **SQL Server confirms actuator state.** Occupancy automation will not spam a relay that is already in the requested state.
6. **Degraded startup is honest.** HTTP and MQTT start immediately; if SQL Server is late, `/api/v1/health` reports `degraded` and DB access reconnects automatically.

## Quick start (Windows / PowerShell)

```powershell
cd D:\important\me\server\CampusX_Backend_v2
Copy-Item .env.example .env   # skip if you already have a configured .env
npm install
npm run check
npm run check:connections
npm start
```

Open:

- Dashboard: <http://127.0.0.1:3000/>
- Login page: <http://127.0.0.1:3000/login.html>
- Human docs: <http://127.0.0.1:3000/docs>
- Runtime contract JSON: <http://127.0.0.1:3000/docs/contract.json>
- Public health: <http://127.0.0.1:3000/api/v1/health>

> `npm run check` validates syntax, environment values and the runtime contract without touching the network. `npm run check:connections` probes SQL Server and the MQTT broker.

## Configuration

All settings come from `.env` or process environment variables. There are no hardcoded hosts or credentials in code.

| Group | Key | Default | Purpose |
| --- | --- | --- | --- |
| HTTP | `HOST`, `PORT` | `127.0.0.1`, `3000` | Bind address. A non-loopback host requires `API_KEY`. |
| HTTP | `STRICT_HEALTH` | `false` | If true, `/health` returns 503 while degraded. |
| HTTP | `PUBLIC_ORIGIN` | empty | Public browser origin (for example `http://127.0.0.1:3000`) used for allowed same-origin/CORS requests and auth origin checks. |
| HTTP | `JSON_BODY_LIMIT` | `1mb` | Maximum JSON request body size. |
| SQL | `SQL_SERVER`, `SQL_DATABASE` | required | SQL Server host and database. `SQL_SERVER` accepts `host`, `host\instance`, `host,port` or `host\instance,port`. |
| SQL | `SQL_USERNAME`, `SQL_PASSWORD` | required (tedious) | SQL authentication credentials for the cross-platform default driver. |
| SQL | `SQL_PORT` | empty | Fixed TCP port. Recommended when connecting from Linux / Raspberry Pi. |
| SQL | `SQL_TRUSTED_CONNECTION` | `false` | `false` uses pure-JS **tedious** (Windows/Linux/Raspberry Pi). `true` is the Windows-only legacy `msnodesqlv8` fallback and requires ODBC Driver 18. |
| SQL | `SQL_DRIVER`, `SQL_ENCRYPT`, `SQL_TRUST_SERVER_CERTIFICATE` | ODBC Driver 18 / false / true | `SQL_DRIVER` is used only by the legacy Windows-auth path. `SQL_ENCRYPT` and `SQL_TRUST_SERVER_CERTIFICATE` apply to both drivers. |
| SQL | `SQL_POOL_MAX`, `SQL_POOL_MIN`, `SQL_POOL_IDLE_TIMEOUT_MS` | 10, 0, 30000 | Pool sizing. |
| SQL | `SQL_RETRY_COOLDOWN_MS` | 2000 | Backoff between failed connection attempts. |
| MQTT | `MQTT_URL` | `mqtt://localhost:1883` | Broker URL. |
| MQTT | `MQTT_USERNAME`, `MQTT_PASSWORD` | empty | Optional broker auth. |
| MQTT | `MQTT_TELEMETRY_TOPIC`, `MQTT_DEVICE_TELEMETRY_TOPIC`, `MQTT_COMMAND_RESPONSE_TOPIC`, `MQTT_COMMAND_TOPIC_PREFIX` | `smart-campus/...` | Firmware contract topics. |
| MQTT | `MQTT_CLIENT_ID` | `campusx-backend-${process.pid}-${random}` | Supports `${process.pid}`, `${hostname}`, `${random}`. Unique per process. |
| MQTT | `MQTT_QOS` | `1` | Subscription + publish QoS (0..2). |
| MQTT | `MQTT_PUBLISH_TIMEOUT_MS`, `MQTT_WAIT_FOR_CONNECT_MS` | 10000, 5000 | Prevents hanging command requests. |
| Telemetry | `MAX_READINGS_PER_MESSAGE`, `MAX_MQTT_PAYLOAD_BYTES` | 100, 65536 | Payload limits. |
| Telemetry | `TELEMETRY_MAX_FUTURE_SECONDS`, `TELEMETRY_MAX_PAST_SECONDS` | 300, 2592000 | Timestamp sanity window. |
| Commands | `COMMAND_TYPES` | empty | Optional allowlist, e.g. `set_state,get_state,reboot`. |
| Commands | `COMMAND_TIMEOUT_SECONDS`, `COMMAND_TIMEOUT_SWEEP_SECONDS` | 120, 30 | Unanswered `pending`/`sent` commands become `timeout` so automation cannot stay blocked. |
| Auth | `DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_SESSION_SECRET` | bootstrap only | Generate with `scripts/setup-dashboard-auth.ps1`. |
| Auth | `DASHBOARD_ADMIN_USERNAME`, `DASHBOARD_ADMIN_EMAIL` | empty | Explicitly promotes a matching account to `admin` (when both are set they must match the same account); if empty, the bootstrap/first account is promoted when no admin exists. |
| Auth | `DASHBOARD_REGISTRATION_ENABLED` | `true` | Allows `POST /auth/register` and `/register.html` for SQL-backed dashboard accounts. |
| Auth | `DASHBOARD_SESSION_HOURS` | `8` | Signed session lifetime, clamped to 1..24 hours. |
| Auth | `DASHBOARD_COOKIE_SECURE` | `false` | Set `true` behind HTTPS. |
| CV | `CAMPUSX_CV_DIR`, `CAMPUSX_POWERSHELL_EXECUTION_POLICY` | local folder, `RemoteSigned` | Windows-only camera controls. |
| CV | `CV_SCRIPT_TIMEOUT_MS`, `CV_OPERATION_WAIT_MS` | 120000, 150000 | Script timeout and how long a `stop` waits for an in-flight `start`. |

See `.env.example` for the complete annotated list.

> Windows note: the Computer Vision `.ps1` files must not carry the “downloaded from internet” mark. If you re-download them and `RemoteSigned` blocks them, run:
> `Get-ChildItem computer-vision -Filter *.ps1 | Unblock-File`
> This keeps execution policy safer than hardcoding `-ExecutionPolicy Bypass`.

## MQTT contract at a glance

```text
Device -> Server   smart-campus/telemetry
Device -> Server   smart-campus/devices/{deviceCode}/telemetry
Device -> Server   smart-campus/devices/{deviceCode}/command-response
Server -> Device   smart-campus/devices/{deviceCode}/commands
```

All four use **QoS 1**. Commands use `retain=false`.

Telemetry example:

```json
{
  "device_id": "esp32-lab-01",
  "message_id": "esp32-lab-01-1700000000000-1",
  "recorded_at": "2026-11-18T12:00:00.000Z",
  "readings": [
    { "metric": "temperature", "value": 25.5, "unit": "C" },
    { "metric": "humidity", "value": 55.2, "unit": "%" }
  ]
}
```

Command example:

```json
{
  "command_id": "42",
  "type": "set_state",
  "payload": { "state": "on" }
}
```

Response example:

```json
{
  "command_id": "42",
  "success": true,
  "status": "completed",
  "result": { "state": "on" }
}
```

Full details: [MQTT_CONTRACT.md](MQTT_CONTRACT.md) and [FIRMWARE_INTEGRATION.md](FIRMWARE_INTEGRATION.md).

## HTTP API at a glance

```text
GET   /register.html                 public signup page (SQL-backed account)
POST  /auth/register                 create account, sign in, redirect to /dashboard
POST  /auth/login                    username or email + password
GET   /auth/session                  current signed-in user
POST  /auth/logout                   clear the session cookie
GET   /auth/admin/accounts           admin only: list dashboard accounts
PATCH /auth/admin/accounts/:id       admin only: edit account/role/password
DELETE /auth/admin/accounts/:id      admin only: delete account
GET   /api/v1/health                 public liveness + dependency status
GET   /api/v1/db-check               SQL round-trip and pool state
GET   /api/v1/dashboard/summary      dashboard counters + recent alerts
GET   /api/v1/rooms                  (alias: /labs)
GET   /api/v1/devices
GET   /api/v1/telemetry/latest
GET   /api/v1/commands               paginated command history
GET   /api/v1/commands/:id           command detail
POST  /api/v1/commands               publish a command (session required)
POST  /api/v1/alerts/:id/acknowledge
POST  /api/v1/alerts/:id/resolve
GET   /api/v1/stream                 Server-Sent Events
GET   /api/v1/occupancy-automation   ?roomId=...
GET   /api/v1/computer-vision/status
```

Auth is rate-limited per IP: 5 failed logins block for 15 minutes, and 5 signup attempts per hour block for 60 minutes. Both return `429` with `Retry-After`. Full details are in [API_CONTRACT.md](API_CONTRACT.md) and `/docs/contract.json`.

All API responses use a consistent envelope:

```json
{ "status": "ok", "data": [], "count": 0, "limit": 100, "offset": 0 }
```

Errors use:

```json
{ "status": "error", "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

Full endpoint table: [API_CONTRACT.md](API_CONTRACT.md).

## Reliability details

| Concern | Behaviour |
| --- | --- |
| SQL Server down at boot | HTTP + MQTT still start; auth retries in background; health = `degraded`. |
| SQL connection dies later | Pool resets and reconnects on the next call with a short cooldown. |
| Duplicate telemetry | Ignored per `(DeviceId, MetricId, MessageId)`. |
| Duplicate command response | Ignored once the command is `completed`/`failed`/`timeout`/`cancelled`; no extra audit/state row. |
| MQTT publish hang | Bounded by `MQTT_PUBLISH_TIMEOUT_MS`. |
| MQTT client collision | Unique client id per process; no silent session stealing. |
| SSE shutdown hang | Open streams receive `event: server.shutdown` and are closed immediately; `server.close()` still has a timeout + `closeAllConnections()` fallback. |
| Relay command storms | Latest confirmed `relay_state` in SQL suppresses redundant commands. |
| Patch semantics | Explicit `null` clears nullable fields; invalid capacity/type is rejected. |

## Security posture

- Signed HMAC session cookie (`HttpOnly`, `SameSite=Strict`, optional `Secure`).
- scrypt password hashes stored in `dbo.DashboardAccounts`; `SessionVersion` revokes old sessions on credential change.
- Login rate limiting and cross-site/origin checks.
- Optional `X-API-Key`; constant-time comparison.
- CORS allowlist; unknown origins receive 403.
- HTML pages are explicitly routed; arbitrary `.html` files are not served by `express.static`.
- Security headers: `nosniff`, `DENY` framing, `no-referrer`, permissions policy.
- MQTT credentials and SQL credentials are injected from environment only.
- Computer Vision PowerShell scripts no longer hardcode `-ExecutionPolicy Bypass`; configure via `CAMPUSX_POWERSHELL_EXECUTION_POLICY`.

> Before exposing to a LAN: set `HOST` to the interface, set a strong `API_KEY`, set `DASHBOARD_COOKIE_SECURE=true` behind HTTPS, enable MQTT authentication, and narrow `CORS_ORIGINS`.

## Operations

```powershell
# Static + config + contract checks
npm run check

# Live dependency probes
npm run check:connections

# HTTP smoke test (optionally authenticated)
npm run smoke

# Signup end-to-end test (creates and deletes a unique test account)
npm run test:register

# Admin account governance test (creates and deletes temporary accounts)
npm run test:admin

# Full sequence
npm run verify
```

Authenticated smoke test:

```powershell
$env:CAMPUSX_SMOKE_USERNAME = 'your-operator'
$env:CAMPUSX_SMOKE_PASSWORD = 'your-password'
npm run smoke
```

Manual firmware round-trip:

```powershell
node fake-esp32.js
node fake-actuator.js
```

## Database

SQL Server is authoritative. The canonical schema lives in `sql/CampusX_CreateDatabase.sql`; optional automation tables are created on demand by `src/services/occupancyAutomationService.js`. Important tables:

`Rooms`, `Node_Types`, `Nodes`, `Device_Types`, `Devices`, `Metrics`, `Device_Capabilities`, `Telemetry`, `Device_States`, `Users`, `Commands`, `Alert_Rules`, `Alerts`, `Audit_Logs`, `DashboardAccounts`, `Occupancy_Automation_Settings`.

## Documentation map

| File | Purpose |
| --- | --- |
| `README.md` | This overview and operations guide. |
| `API_CONTRACT.md` | HTTP endpoints, auth, envelopes, filters, pagination, examples. |
| `MQTT_CONTRACT.md` | Topics, QoS, payload schemas, idempotency, command lifecycle. |
| `FIRMWARE_INTEGRATION.md` | Copy-paste checklist for the firmware author. |
| `FIRMWARE_API_REFERENCE.md` | One-page firmware handbook: HTTP endpoints + MQTT contract. |
| `PROJECT_EXPLAINED_AR.md` | Arabic file-by-file walkthrough of the whole project. |
| `/docs` | Live in-server documentation page. |
| `/docs/contract.json` | Machine-readable runtime contract. |

## Change management

Obsolete patch scripts, duplicated sources, stale Arabic setup notes and `.bak` snapshots were removed from the working tree. The hardening, signup integration, firmware docs and project walkthrough are committed and pushed to `origin/main`. SQL Server remains the single source of truth.

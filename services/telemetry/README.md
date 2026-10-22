# GeoD Telemetry

Small self-hosted collector for GeoD's opt-in anonymous usage statistics.

Production uses the clean `geod-telemetry-v2.sqlite` database. After the
platform migration marker exists, GeoD imports only the legacy `events` table;
accounts, quotas, WeChat data, and web-product events remain outside GeoD.

## Run locally

```powershell
npm install
$env:TELEMETRY_DB_PATH = "$PWD/data/events.sqlite"
$env:TELEMETRY_ADMIN_TOKEN_FILE = "$PWD/data/admin-token.txt"
Set-Content $env:TELEMETRY_ADMIN_TOKEN_FILE "local-password"
npm start
```

- Ingest: `POST http://127.0.0.1:9091/v1/events`
- Health: `GET http://127.0.0.1:9091/health`
- Aggregate dashboard: `http://127.0.0.1:9091/admin/`

WeChat Toolbox accounts, export quotas and callbacks live in the independent
Laogao platform API. GeoD Studio / Agent accounts use GeoD's own identity store
and OAuth service; neither account system belongs in this anonymous collector.

`download_task_state` reports random attempt IDs, started/completed/
completed_with_gaps/failed/cancelled, elapsed duration ranges and error categories.
No task name, path, coordinates, source URL or raw diagnostic is accepted.
Starting with 3.6.17, an optional complete `diagnostic_version: 1` block adds
provider category, phase, stable final error category, HTTP status, current
configured token count, distinct tokens actually requested, switches,
recoveries, configuration updates, last rejection status and exhaustion flag.
No token value, fingerprint or raw response is accepted. Counts are integers
0–65535; categories are allowlisted. Legacy four-property events remain valid.
Recovery means a valid tile was downloaded after a switch, not that the task
completed. Used-token counts span settings updates within the same attempt.

Production uses the native SQLite WAL adapter in `database.mjs`, explicit
database identity and readiness health checks. The database must be initialized
or adopted explicitly with the offline tool before starting; local configuration
also requires `NODE_ENV` and `TELEMETRY_DATABASE_ID`. Do not point a local test at
the production database or use the historical sql.js whole-file writer.
The desktop consent notice is version 3 and requires renewed consent for this
scope. `telemetry_metadata.download_lifecycle_started_at` declares when the
server became able to accept these events; old clients remain uninstrumented.
The report counts observed attempts, not every download on every installation.

The service stores only allowlisted anonymous events in SQLite. Request IP
addresses are used in memory for rate limiting and are not written to the
database or application logs.

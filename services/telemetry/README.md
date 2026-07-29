# GeoD Telemetry

Small self-hosted collector for GeoD's opt-in anonymous usage statistics.

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

The service stores only allowlisted anonymous events in SQLite. Request IP
addresses are used in memory for rate limiting and are not written to the
database or application logs.

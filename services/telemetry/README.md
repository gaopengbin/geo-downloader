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

Accounts, export quotas, the WeChat callback, and web-product analytics live in
the independent Laogao platform API at `https://laogao.xyz/platform-api/`.
They are intentionally not part of the GeoD collector or its SQLite database.

The service stores only allowlisted anonymous events in SQLite. Request IP
addresses are used in memory for rate limiting and are not written to the
database or application logs.

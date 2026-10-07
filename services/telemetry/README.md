# GeoD Telemetry

Small self-hosted collector for GeoD's opt-in anonymous usage statistics.

Production uses Node **22.23 or later** and built-in `node:sqlite`: file-backed
SQLite, WAL, `synchronous=FULL`, 2-second lock timeout, and one atomic transaction
per accepted batch. A `202` response is sent only after commit. Event IDs are
idempotent; repeated IDs never overwrite an earlier record. No npm runtime
dependency or Linux compilation/download is required.

The service never creates a missing database, silently adopts an unknown file,
or imports another service's legacy database on startup. Every database must
have a matching `_service_identity` row (`service`, `database_id`, `environment`,
`schema_version`). Original events and unrelated tables remain intact.

## Run locally

```powershell
$env:TELEMETRY_DB_PATH = "$PWD/data/events.sqlite"
$env:TELEMETRY_DATABASE_ID = "geod-local-development"
$env:NODE_ENV = "development"
$env:TELEMETRY_ADMIN_TOKEN_FILE = "$PWD/data/admin-token.txt"
node initialize-database.mjs --db $env:TELEMETRY_DB_PATH --database-id $env:TELEMETRY_DATABASE_ID --environment development --create-new --offline-confirmed
Set-Content $env:TELEMETRY_ADMIN_TOKEN_FILE "local-password"
npm start
```

- Ingest: `POST http://127.0.0.1:9091/v1/events`
- Readiness: `GET http://127.0.0.1:9091/health` or `/ready` (503 on storage failure)
- Protected storage diagnostics: `GET /admin/health` (alias `/admin/storage`)
- Aggregate dashboard: `http://127.0.0.1:9091/admin/`

## First production upgrade: explicitly adopt the existing database

1. Gate **only GeoD 9091 routes**, including old-IP/private-origin forwarding;
   let requests drain, stop the existing sql.js writer, and verify it exited.
2. Create an offline verified backup of the actual runtime database. Record
   SHA256, all-table counts and the latest received timestamp. Do not use a
   stale same-named file from another directory.
3. With the service still stopped, initialize identity on that exact existing
   file (the command does not change any event column):

```sh
node initialize-database.mjs \
  --db /srv/laogao/data/geod-telemetry/geod-telemetry-v2.sqlite \
  --database-id geod-telemetry-production-20260907 \
  --environment production --offline-confirmed \
  --expected-sha256 <verified-offline-sha256> --expected-events <verified-count>
```

The command rejects absent files, existing identity, wrong source hash/count,
unexpected schema, and WAL/journal sidecars. For a fresh development database,
`--create-new` is a separate explicit operation and refuses existing files.
The offline flag is operator confirmation, not an automatic process detector.

4. Configure `TELEMETRY_DB_PATH` to that absolute path,
   `TELEMETRY_DATABASE_ID=geod-telemetry-production-20260907`,
   `NODE_ENV=production`, and the existing `TELEMETRY_ADMIN_TOKEN_FILE`.
   `LEGACY_TELEMETRY_DB_PATH` and `PLATFORM_MIGRATION_MARKER` are no longer read.
5. Package `server.mjs`, `database.mjs`, `initialize-database.mjs`, `package.json`
   and `package-lock.json`. No `node_modules` are needed. Run as the database
   owner, with parent-directory write permission for SQLite `-wal`/`-shm` files.
   Set PM2 `kill_timeout: 30000` for SIGTERM/SIGINT request draining.
6. Validate public readiness, authenticated `/admin/health` and `/admin/stats`,
   and exact pre-upgrade events/all-table row preservation before reopening.

Never copy only the main `.sqlite` file while the new writer is live: committed
records may be in WAL. Use the SQLite online backup API/CLI `.backup`, then
validate the resulting snapshot. Never restart the retired sql.js service
against an active WAL database. For a code rollback, gate traffic, stop/checkpoint
the new writer, take a fresh backup, then restart compatible code with the same
newest data; do not restore an old database over new production events.

## Time and measurement semantics

UTC `occurred_at` and `received_at` are retained. All history/new calendar-day
aggregation uses `date(occurred_at, '+8 hours')` (Asia/Shanghai), including first
observed day and active days. Historical `event_day` columns are deliberately
unchanged for exact preservation; do not use those legacy values for reports.
New `event_day` values are Beijing dates. An expression index supports the new
aggregation. The admin graph labels dates/times in Beijing regardless of the
viewer's timezone.

Installation IDs are anonymous installation instances, not natural persons.
`download_task_created` counts task creation, not completed downloads. `dau`
remains explicitly a rolling 24-hour window; `daily` is a Beijing calendar day.
First observed event time is not necessarily the installation date.

## Health and regression coverage

Public `/health` and `/ready` return storage availability, last successful write,
last received event, and consecutive write failures without database path/ID.
They check the file identity, metadata and a live query; a read success does not
clear failed-write status. Only a subsequent successful durable write resets it.
Authenticated `/admin/health` also exposes database path/ID, environment, event
count and a sanitized error code. No installation IDs appear in public health.

`npm test` covers missing/wrong databases, explicit legacy identity adoption,
full-row history and unrelated-table preservation, midnight/08:00 boundaries,
batch rollback/readiness recovery, HTTP permissions, event-ID replay, graceful
restart, and abrupt-process WAL recovery. Former sql.js file-replacement and
automatic legacy-import tests were replaced because those behaviors were
intentionally removed rather than retained behind a fallback.

Accounts, export quotas, the WeChat callback, and web-product analytics live in
the independent Laogao platform API at `https://laogao.xyz/platform-api/`.
They are intentionally not part of the GeoD collector or its SQLite database.

The service stores only allowlisted anonymous events in SQLite. Request IP
addresses are used in memory for rate limiting and are not written to the
database or application logs.

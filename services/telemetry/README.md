# GeoD Telemetry

Small self-hosted collector for GeoD's opt-in anonymous usage statistics.

## Run locally

```powershell
npm install
$env:TELEMETRY_DB_PATH = "$PWD/data/events.sqlite"
$env:TELEMETRY_ADMIN_TOKEN_FILE = "$PWD/data/admin-token.txt"
$env:WECHAT_CALLBACK_TOKEN = "replace-with-a-random-wechat-callback-token"
Set-Content $env:TELEMETRY_ADMIN_TOKEN_FILE "local-password"
npm start
```

- Ingest: `POST http://127.0.0.1:9091/v1/events`
- Health: `GET http://127.0.0.1:9091/health`
- Aggregate dashboard: `http://127.0.0.1:9091/admin/`

## WeChat follow reward

The account and quota API shares the same SQLite database. The public account
callback is available at:

```text
https://laogao.xyz/geod-telemetry/wechat/callback
```

Configure that URL and the same `WECHAT_CALLBACK_TOKEN` in WeChat Official
Account Platform. Select plaintext message mode for the first release. When a
follower replies with `额度`, the service returns a random code in the form
`LG-ABCD-2345`. It expires after 15 minutes, can be redeemed only once, and one
website account can claim the 20-export follow reward only once.

Only a SHA-256 digest of the follower OpenID is stored. Message content,
nickname, avatar, and WeChat ID are not persisted.

The service stores only allowlisted anonymous events in SQLite. Request IP
addresses are used in memory for rate limiting and are not written to the
database or application logs.

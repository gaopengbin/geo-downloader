# GeoD AI Gateway

A small OpenAI-compatible development gateway for testing the GeoD assistant in
a browser or experimenting with a future hosted service. The production desktop
client performs retrieval and model requests in its Rust backend and does not
require this process.

## Local test

```powershell
cd services/ai-gateway
npm start
```

Open `http://127.0.0.1:8787`. The repository-local `.env` starts in mock mode
and uses `geod-local-test` as the gateway token.

## Connect a real model

The gateway always owns the upstream base URL and model. A server key is
optional when the desktop sends its own key through `x-geod-provider-key`.

```dotenv
MOCK_MODE=false
UPSTREAM_BASE_URL=https://api.deepseek.com/v1
UPSTREAM_API_KEY=
UPSTREAM_MODEL=deepseek-v4-flash
GATEWAY_TOKEN=replace-with-a-long-random-value
```

The upstream must expose an OpenAI-compatible
`POST /chat/completions` endpoint below `UPSTREAM_BASE_URL`.

## API

- `GET /health`
- `POST /v1/chat/completions`

`/health` reports the loaded knowledge-base version and article count.
Chat responses expose the matched article metadata through the
`x-geod-knowledge-sources` response header.

When `x-geod-provider-key` is present, the gateway uses it only for that
upstream request and does not persist or log it. BYOK requests do not consume
the server-owned key. Requests without a provider key continue to require
`GATEWAY_TOKEN` when one is configured.

## Knowledge retrieval

The curated source is `knowledge/articles.json`. The gateway retrieves the
most relevant articles for the latest user question and injects them into the
server-owned system message. Client-provided system messages are ignored.

The current retriever is deterministic lexical search. The client contract is
provider-independent, so a hybrid or embedding retriever can replace it later
without changing the desktop application.

## Agent actions

Knowledge articles may contain registered `geod://navigate/<action-id>` links.
The desktop validates every link against a hard-coded allowlist before changing
the visible mode or tab. The first release only permits navigation and opening
the source-management dialog. It cannot change settings, create downloads,
delete data, or execute arbitrary URLs.

Example:

```powershell
$headers = @{
  "X-GeoD-Provider-Key" = "your-deepseek-api-key"
  "Content-Type" = "application/json"
}
$body = @{
  messages = @(@{ role = "user"; content = "GeoTIFF 下载失败怎么办？" })
  stream = $false
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/v1/chat/completions `
  -Method Post `
  -Headers $headers `
  -Body $body
```

## Before public access

- Keep the gateway bound to localhost and put HTTPS reverse proxy in front.
- Replace `GATEWAY_TOKEN` and never commit `.env`.
- Never log or persist the `x-geod-provider-key` request header.
- Restrict the firewall to ports 80/443.
- Add persistent per-device quotas before distributing it to users.
- Keep provider-side spending alerts and a hard budget limit enabled.

The included rate limiter is process-local and intended only for a personal
test. It is not sufficient for multiple gateway instances or public billing.

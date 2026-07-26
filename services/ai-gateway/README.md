# GeoD AI Gateway

A small OpenAI-compatible gateway for testing the GeoD assistant without
putting the upstream model key in the desktop client.

## Local test

```powershell
cd services/ai-gateway
npm start
```

Open `http://127.0.0.1:8787`. The repository-local `.env` starts in mock mode
and uses `geod-local-test` as the gateway token.

## Connect a real model

Copy the relevant values into `.env`:

```dotenv
MOCK_MODE=false
UPSTREAM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
UPSTREAM_API_KEY=your-api-key
UPSTREAM_MODEL=qwen-plus
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
  Authorization = "Bearer geod-local-test"
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
- Restrict the firewall to ports 80/443.
- Add persistent per-device quotas before distributing it to users.
- Keep provider-side spending alerts and a hard budget limit enabled.

The included rate limiter is process-local and intended only for a personal
test. It is not sufficient for multiple gateway instances or public billing.

# GeoD CLI / MCP usage observations

## Scope and populations

This patch covers the native CLI, local stdio MCP and hosted HTTP MCP. It does
not change download permissions, source selection, authentication requirements,
task concurrency, pricing, output files or the MCP result contract.

Three independent stages are recorded:

1. **Authorization:** one completed OAuth authorization-code exchange. Token
   refresh is a separate operation, never a new authorization or active tool use.
   New official clients declare CLI or MCP at registration. Older/unidentified
   client registrations retain an unknown product classification.
2. **Tool execution:** entry and outcome of a CLI command or a registered MCP
   tool handler. MCP handshake, keepalive and `tools/list` are not tool calls.
   SDK schema rejection before a registered handler is not included in this
   execution metric. The hosted high-zoom authentication challenge is recorded
   as a rejected `geod_fetch` tool call, without inventing a download task.
3. **Download:** actual fetch start and its verified complete/partial, failed or
   cancelled outcome. Successfully returning a background job ID is only tool
   acceptance, not successful download. A hard-killed process with no terminal
   report remains `unknown`, even after time passes. Polling never creates new
   download attempts. MCP subprocesses carry `GEOD_USAGE_PARENT=mcp` to suppress
   duplicate native CLI observations.

The read-only report resolves identities only against GeoD's account store.
It excludes `1804287165@qq.com`, `pengbingao@gmail.com`, `analyticsAudience=internal`,
`isTestAccount=true`, server internal-token traffic and `GEOD_USAGE_TEST=1` events.
Known owner/internal installation IDs are also conservatively excluded across
anonymous observations. Remaining account activity is labelled
`non_owner_non_test_accounts`, not manually verified external users.

Anonymous/unlinked observations are a separate population. An installation ID
is not a person; an unknown account mapping cannot be counted as an external
user. If the account store is unavailable, identity stays unknown. When the
collector metadata is absent, the report returns `not_instrumented` with
`counts: null`. Zero observed events does not imply zero real use. No historical
OAuth state, HTTP access count or package download is backfilled into task use.

## Local consent and privacy

Local reporting is **off by default**, sharing one configuration between CLI and
MCP: `GEOD_CLI_HOME`, or `%APPDATA%/GeoD CLI` / `$HOME/.geod-cli`.

```text
geod telemetry status
geod telemetry enable
geod telemetry disable

geod-mcp telemetry status
geod-mcp telemetry enable
geod-mcp telemetry disable
```

`GEOD_TELEMETRY=0|1` is an explicit process override. `GEOD_USAGE_TEST=1` marks
test observations without enabling reporting. The outbox has a 2,000-event
bound; expired/malformed pending events are discarded rather than blocking
later reports. Disabling clears pending events. No command parameters, task
names, file paths, source URLs, coordinates, raw errors, email addresses or
credentials are stored in observations. Only fixed operations, states, reason
categories, versions, random event/attempt/installation IDs and times are sent.

If a valid existing CLI OAuth session is available, the collector derives its
account from the token; clients cannot supply account IDs. A local hash of the
OAuth client ID binds queued observations to the original login session. It is
never uploaded. After switching accounts, old queued observations are sent as
unlinked, never attributed to the newly logged-in account. Credentials are not
copied into the outbox. Statistics never open login or refresh a token.

Delivery goes only to `https://laogao.xyz/geod-mcp/usage`. A loopback HTTP
`GEOD_USAGE_ENDPOINT` override supports isolated verification. Redirects are
rejected. Network sends run in the background with a 1-second timeout; normal
shutdown waits at most 200 ms. Atomic outbox files survive a failed send.
The next command/call can replay them. Duplicate IDs are deduplicated again in
the report, including across collector restarts. Statistics failures never
change command exit codes, authentication or task results.

## Hosted collection and report

Set `GEOD_USAGE_DIR=/srv/laogao/data/geod-mcp/usage` on the hosted MCP service to
enable collection after deploying this patch. The directory and daily JSONL
journals are private. `metadata.json` records the actual instrumentation start.
The journal is separate from the OAuth state and job records. Missing or
unwritable storage degrades statistics only. The server derives account identity
from OAuth and marks the internal bearer token as internal. The endpoint rejects
private/unknown fields, forged authorization events and cloud-tool claims from
local clients; request IPs are only used in an in-memory rate limiter.

Daily journals are append-only; this patch does not delete existing server
history. Client ingestion accepts at most the preceding 90 days. Set disk
retention deliberately when deploying; missing retained history is incomplete
coverage, not absence of use. The `/geod-mcp/usage` path must reach this service
under the existing proxy prefix. No new public dashboard or unauthenticated
read endpoint is introduced.

```text
python scripts/get_tools_usage.py --remote --days 7 --output artifacts/tools-usage.json
python scripts/get_tools_usage.py --directory LOCAL_USAGE_DIR --accounts LOCAL_ACCOUNT_FIXTURE --include-excluded
```

`--include-excluded` adds a separate `excludedDiagnostics` section for QA. It
never adds those records back into the normal `counts` array. The report keeps
authorization, tool and download stages separate by product/transport/population;
it reports unknown outcomes and terminal outcomes without an observed start
explicitly. It does not export account or installation identifiers.

## Verification

```text
cargo test -p geod-cli
cargo build -p geod-cli
python scripts/test-tools-usage.py
python -m unittest discover -s services/tools-analytics -v
node packages/geod-mcp/scripts/verify-usage-live.mjs
```

The live verifier uses real binaries and official MCP transports with three
real public DataV downloads. Its OAuth account service is an isolated fixture;
no production account or ledger is modified. It verifies PKCE and refresh,
local and HTTP execution, actual output inspection, a deliberate source error,
hard interruption, collector outage and outbox replay. Every observation is
test-marked. Receipts, manifests and the separate test journal remain under
`artifacts/tools-usage-live-*` for inspection. Unit tests additionally cover
owner/internal exclusion, missing account data, missing instrumentation,
deduplication, privacy validation and account switching.

**Release boundary:** implementation and local runtime verification do not
enable collection for already installed versions. Hosted deployment and new
CLI/MCP package publication are separate release actions.

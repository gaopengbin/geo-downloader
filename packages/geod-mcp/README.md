# GeoD MCP 0.1.0

Local stdio MCP for acquiring real geographic data with GeoD CLI 0.1.1 and rendering it with GeoStyle/OpenStyle. Node.js 22+ is required. Data acquisition runs independently of the desktop UI. Rendering also needs a running GeoStyle server and Chrome/Edge.

## Install in one command

On Windows x64 with Node.js 22+, run one of these commands in the workspace GeoD may access:

```powershell
npx --yes geod-mcp@0.1.0 install codex
npx --yes geod-mcp@0.1.0 install workbuddy
```

The same package is also available from the GitHub Release tarball:

```powershell
$pkg = 'https://github.com/gaopengbin/geo-downloader/releases/download/geod-mcp-v0.1.0/geod-mcp-0.1.0.tgz'
npx --yes --package $pkg geod-mcp install codex --package $pkg
npx --yes --package $pkg geod-mcp install workbuddy --package $pkg
```

Use `--workspace C:\path\to\your\workspace` to choose another folder. The command installs the package under `%LOCALAPPDATA%\GeoD\Agent`, starts it, verifies `geod_capabilities` and `geod_plan`, and writes the selected client's configuration. Codex also receives a `geod-agent` skill. Restart a client session if it does not discover a newly registered MCP server.

WorkBuddy's configuration is verified on disk and the MCP tools are called independently; a WorkBuddy client session has not yet been tested. This npm package is a local Windows stdio server. A hosted endpoint is also available below.

## Ask an agent to install it

Copy this prompt into Codex or WorkBuddy on the computer where you want GeoD to run:

> Connect GeoD MCP to this client for my current workspace. First check that this computer is Windows x64 with Node.js 22 or newer. Run `npx --yes geod-mcp@0.1.0 install codex --workspace "<absolute path of my current workspace>"`; if you are WorkBuddy, replace `codex` with `workbuddy`. Refresh the client session if needed, then actually call `geod_capabilities` and `geod_plan` to verify the connection. Report the tool results or the exact blocker. Do not claim success from a configuration file alone.

This prompt uses the public npm package on the recipient's own computer. It does not require access to the publisher's machine or credentials. Clients without a Windows terminal need a remote MCP connection instead.

## Hosted HTTPS MCP

The hosted Streamable HTTP endpoint is `https://laogao.xyz/geod-mcp/mcp`. Users authorize their own account through the browser when the MCP client starts OAuth. The login page supports email/password and email-verified registration. The server issues GeoD-specific tokens; the user never needs the site owner's token or access to the owner's computer. It listens on loopback behind HTTPS Nginx.

Copy this prompt into a cloud agent such as Doubao Work, or another client that supports remote Streamable HTTP MCP and OAuth:

> Add a remote MCP server named `geod` at `https://laogao.xyz/geod-mcp/mcp` using Streamable HTTP. Let me complete the GeoD account login/authorization in the browser; do not ask me to paste a password or token into chat. Then call `geod_capabilities` and `geod_plan` with one of the provided examples, and report the actual tool results. If this client cannot complete OAuth, tell me the exact client limitation instead of claiming the server is connected.

The hosted server restricts users to their own jobs and files. Public accounts can use NASA GIBS imagery and DataV administrative GeoJSON with at most 64 tiles, 4 million pixels, 180 seconds and three fetch jobs per day; the server permits one active public fetch at a time. Other sources and larger workloads require the local Windows package or a separate approved deployment.

For a client accepting the `mcpServers` JSON format with OAuth discovery:

```json
{
  "mcpServers": {
    "geod": {
      "type": "http",
      "url": "https://laogao.xyz/geod-mcp/mcp"
    }
  }
}
```

The hosted service currently exposes planning, acquisition, job status/cancellation, bundle inspection, and registered artifact reading. It does not expose `geod_render`: the server has no production GeoStyle renderer or browser. The local stdio package still offers rendering when GeoStyle and a browser are available. Small JSON/GeoJSON artifacts are readable through `geod_get_artifact`. For a large GeoTIFF or other file, call hosted-only `geod_artifact_link` with its `jobId` and `artifactId`; it returns a signed HTTPS download link valid for ten minutes. Remote client integration in Doubao Work still needs an in-product test.

The owner can verify the legacy owner access without printing the token, using the owner-only token file on the deployment workstation:

```powershell
node packages/geod-mcp/scripts/verify-http.mjs https://laogao.xyz/geod-mcp/mcp C:\path\to\your-private-token.txt --fetch
```

## Build from this source checkout

Build a portable npm tarball and install it into Codex without using the npm registry:

```powershell
$built = powershell -NoProfile -File .\scripts\package-geod-mcp-npm.ps1 | ConvertFrom-Json
powershell -NoProfile -File .\scripts\install-geod-codex.ps1 -PackageSpec $built.tarball -Workspace (Get-Location).Path
```

The installer uses a fixed per-user directory under `%LOCALAPPDATA%\GeoD\Agent`, installs the already published `geod-cli@0.1.1` as a package dependency, registers a `geod` stdio server with `codex mcp add`, and installs the `geod-agent` skill. Before registration it starts the installed MCP process and calls `geod_capabilities` and `geod_plan` through JSON-RPC. It refuses to overwrite a different `geod` registration or skill. Set `-Workspace` to the folder that GeoD should be allowed to read and write.

GeoStyle rendering requires its separate server and browser; the installer's plan check does not claim a working render.

The same installed stdio entrypoint can be registered in [WorkBuddy's user or project `mcp.json`](https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide):

```powershell
powershell -NoProfile -File "$env:LOCALAPPDATA\GeoD\Agent\node_modules\geod-mcp\scripts\install-workbuddy.ps1" -Workspace (Get-Location).Path
```

The script verifies real MCP tool calls, preserves other JSON servers, refuses to replace a different `geod` entry, and backs up an existing configuration before writing. WorkBuddy is not installed on this verification machine, so client discovery and tool invocation there remain unverified. Cloud-hosted agents need Streamable HTTP MCP and OAuth support for the hosted HTTPS endpoint above.

## Run from this checkout

```powershell
cd C:\path\to\geo-downloader\packages\geod-mcp
npm ci --ignore-scripts
$env:GEOD_WORKSPACE = 'C:\path\to\your\workspace'
node src/index.mjs
```

The process waits for an MCP client on stdin. It emits only MCP protocol messages on stdout; it is not an interactive CLI prompt. The source checkout includes `mcp.config.json` as an editable template for clients that accept the `mcpServers` format. Replace its example absolute paths before using it. The Codex installer above writes a global Codex registration; running the server directly does not change client configuration.

```json
{
  "mcpServers": {
    "geod": {
      "command": "node",
      "args": ["C:/absolute/path/to/geo-downloader/packages/geod-mcp/src/index.mjs"],
      "env": {
        "GEOD_WORKSPACE": "C:/path/to/your/workspace",
        "GEOD_BIN": "C:/absolute/path/to/geod.exe",
        "GEOSTYLE_URL": "http://127.0.0.1:3100"
      }
    }
  }
}
```

For the Windows ZIP, extract it and change `args` to the extracted `src/index.mjs`; omit `GEOD_BIN` to use the bundled executable. Production Node dependencies are included in the ZIP. Node, Chrome/Edge and the GeoStyle server are separate prerequisites. Set `GEOD_WORKSPACE` to the directory the AI should be able to read. Start one MCP server per output directory; use separate `GEOD_OUTPUT_DIR` values for independent clients.

## AI workflow

1. Call `geod_capabilities` or read `geod://examples/sichuan` / `geod://examples/henan`.
2. Call `geod_plan` with `{ "request": { ... } }`. It validates limits and returns the tile footprint without downloading.
3. Call `geod_fetch` with that request. It returns a `jobId` after local validation. Poll `geod_job_status` until `completed`, `failed` or `cancelled` (suggested interval 1 second).
4. Read `result.bundleDir`, `result.manifest` and `artifacts`. Check `quality` and warnings. `geod_get_artifact` takes `{ "jobId": "...", "artifactId": "imagery-preview" }` and returns a native PNG block. `vectors` returns GeoJSON text; `manifest` returns JSON.
5. Call `geod_render` with `{ "bundleDir": "...", "openStyle": { ... }, "renderer": "openlayers", "width": 1600, "height": 1200 }`. The OpenStyle object is optional; omitting it uses the data inspection style. Both `openlayers` and `maplibre` are supported. GeoStyle validates actual fields/layers.
6. Poll the render job. Read `preview` for a small native image, `map` for the full PNG, `openstyle` for the editable style, and `render-evidence` for actual rendering observations. These artifact IDs belong to the render job, separate from the download job.

Example instruction for an AI connected to this MCP:

> 用 geod 的四川示例先规划，再下载行政区和影像，按 boundary 裁剪。完成后用 GeoStyle 渲染 1600×1200 地图，展示图片并返回 GeoJSON、GeoTIFF、OpenStyle 和成果目录。根据质量字段如实说明数据范围。

The sample uses NASA Blue Marble overview imagery and DataV boundaries. It is not current high-resolution imagery and contains no verified attraction/POI dataset. The tool accepts parameters; it does not itself interpret place names or invoke an LLM. The calling AI selects boundaries, providers, layers and styles.

## Tools

| Tool | Purpose |
| --- | --- |
| `geod_capabilities` | Paths, prerequisites, limits, examples |
| `geod_plan` | Request validation and footprint/tile estimates |
| `geod_fetch` | Start a download/import job |
| `geod_job_status` | Progress, outcome, quality and artifact metadata |
| `geod_cancel_job` | Request cancellation; poll until terminal |
| `geod_inspect` | Validate a local bundle and file hashes |
| `geod_render` | Import to GeoStyle and capture real browser rendering |
| `geod_get_artifact` | Read registered image/data artifacts |
| `geod_artifact_link` | Hosted HTTP only: signed download URL for any registered artifact |

Completed artifacts also expose `geod://artifacts/{jobId}/{artifactId}` resources. Each includes a local path, media type, byte count and SHA-256. PNG/JPEG/WebP/GIF can be returned as native MCP images. GeoTIFF is intended for file-based analysis; it is not mislabeled as a display image. Inline file reads are capped at 8 MiB, with an additional 9,000,000-byte serialized MCP response limit to account for Base64 and JSON expansion. Oversized responses return an explicit error and the artifact path; the original file remains available for local processing. Use the small preview artifact when a full map is too large to display inline.

## Configuration and behavior

| Environment variable | Default / meaning |
| --- | --- |
| `GEOD_WORKSPACE` | Current working directory; existing local inputs/bundles must be inside this directory or the output directory |
| `GEOD_OUTPUT_DIR` | `<workspace>/output/geod-mcp`; one unique subdirectory per job |
| `GEOD_BIN` | Bundled ZIP `bin/geod.exe`, npm dependency `geod-cli/native/geod.exe`, or source checkout `target/release/geod.exe` |
| `GEOSTYLE_URL` | `http://127.0.0.1:3100`; the server used for imports and renders |
| `GEOSTYLE_GEOD_IMPORT_TOKEN` | Optional import token; required when the GeoStyle server enforces one |
| `GEOD_MAX_CONCURRENT_JOBS` | `2`, configurable from 1 to 4; additional jobs return `BUSY` |
| `GEOD_RENDER_SCRIPT` | Bundled or checkout `scripts/geod-render.mjs` |
| `CHROME_PATH` | Optional browser path, forwarded to the renderer |

Local input paths are resolved against `GEOD_WORKSPACE`, including symlink resolution. The server launches fixed subprocesses with argument arrays and no shell. Request limits and source validation remain in `geod-core`. `imagery.clipToLayer` masks PNG/GeoTIFF by polygon union, preserving holes; vector geometries are unchanged. JPEG cannot carry the clipped transparent result.

`geod_fetch` and `geod_render` are application-level background jobs, independent of any client's optional MCP Tasks support. They continue after the start-tool response as long as this server process remains alive. Cancellation transitions through `cancelling`, then `cancelled`. Renderer cancellation uses IPC so its temporary browser can close on Windows. Closing the stdio input cancels active work. Completed records and artifacts remain readable after restart; unfinished records become `failed` with `INTERRUPTED`. Downloads do not resume automatically, and cancelled jobs do not publish registered artifacts. Files are retained locally, including possible partial job files, until the user removes the relevant job directory while no job is running.

## Verification

```powershell
npm test
npm run test:live
```

Run these verification commands from the source checkout (tests and live-smoke are not distributed in the production ZIP). The test suite uses the official SDK client and real stdio processes, a local tile/GeoJSON server, transparent polygon-hole assertions, artifact/resource readback, cancellation, path boundaries and restart behavior. The live smoke script in the source checkout downloads the real Sichuan example, renders through GeoStyle, reads the native MCP image block back, and writes it to `output/geod-mcp-verification-*/sichuan-via-mcp.png`. It requires the release CLI, network sources, the GeoStyle server and Chrome/Edge.

Protocol integration uses the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) server/client packages, pinned to 2.0.0. The local server supports stdio negotiation and legacy opening mode. The hosted endpoint uses Streamable HTTP with OAuth authorization for each account; legacy owner Bearer access remains available for operations.

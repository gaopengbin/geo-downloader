# GeoD MCP 0.1.3

GeoD MCP wraps the GeoD CLI imagery download workflow for AI agents: plan a bounded download, start it, follow progress, inspect the actual result, and read or download verified files. The CLI can also acquire a prepared administrative GeoJSON boundary to clip imagery; this is part of the download request.

## Let an agent connect it

Copy this prompt into Codex, WorkBuddy, Doubao Work, or another MCP-capable agent:

> Connect the GeoD imagery download MCP to this agent and install its `geod-agent` Skill from https://geod.laogao.xyz/skills/geod-agent/SKILL.md into this client's supported Skills location. If you are running on my Windows x64 computer with Node.js 22+, use `npx --yes --package https://laogao.xyz/geod-mcp/geod-mcp-0.1.3.tgz geod-mcp install codex --package https://laogao.xyz/geod-mcp/geod-mcp-0.1.3.tgz` (replace `codex` with `workbuddy` for WorkBuddy); this local installer also installs the Skill. Otherwise add `https://laogao.xyz/geod-mcp/mcp` as a Streamable HTTP MCP server and let me authorize with my own GeoD account in the browser. Read the Skill before using the tools. Then call `geod_capabilities` and `geod_plan` to verify without starting a download. Report the Skill and MCP installation locations and the tool results or exact blocker.

The local package runs on the recipient's computer. The HTTPS endpoint runs on the hosted service and uses per-user OAuth authorization backed by the independent GeoD account at `geod.laogao.xyz`; email registration and password login use that same account. WeChat chat generator accounts and payment records are separate. A client must support remote Streamable HTTP MCP and OAuth to use that endpoint. Doubao Work client integration still needs an in-product test.

## Local install

Run on Windows x64 with Node.js 22+:

```powershell
$pkg = 'https://laogao.xyz/geod-mcp/geod-mcp-0.1.3.tgz'
npx --yes --package $pkg geod-mcp install codex --package $pkg
npx --yes --package $pkg geod-mcp install workbuddy --package $pkg
```

The installer places the package under `%LOCALAPPDATA%\GeoD\Agent`, creates `%LOCALAPPDATA%\GeoD\Workspace`, calls `geod_capabilities` and `geod_plan` through a real MCP process, then registers the selected client. An explicit `--workspace` path overrides that default. Reinstalling updates a GeoD registration made by this installer to the selected workspace after backing up client configuration; a different registration is preserved. Codex installs `geod-agent` under `$CODEX_HOME\skills` (or `%USERPROFILE%\.codex\skills`); WorkBuddy installs it under `%USERPROFILE%\.agents\skills`. Existing modified Skills are preserved. Restart the client session if it does not discover the new server or Skill. WorkBuddy configuration and MCP tool calls are checked independently; a WorkBuddy client session has not been tested on the release machine.

The installer refuses to overwrite a different `geod` registration. A copy and SHA-256 checksum are on the [GitHub Release](https://github.com/gaopengbin/geo-downloader/releases/tag/geod-mcp-v0.1.3).

## Hosted HTTPS MCP

Endpoint: `https://laogao.xyz/geod-mcp/mcp`

Install the public [GeoD Agent Skill](https://geod.laogao.xyz/skills/geod-agent/SKILL.md) into the client's supported Skills folder before using the remote tools. WorkBuddy also supports importing a [Skill ZIP](https://geod.laogao.xyz/skills/geod-agent.zip) in its Skills interface. If the client does not support Skills, read the Skill as the usage guide in the current conversation.

For clients accepting `mcpServers` JSON and supporting OAuth discovery:

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

Each user logs in or registers on the authorization page. The server issues a GeoD-specific token and keeps each user's jobs in a separate workspace. Public accounts can download from NASA GIBS imagery and use DataV administrative GeoJSON boundaries. Limits are 64 tiles, 4 million pixels, 180 seconds, and three fetch jobs per account per day, with one public fetch running at a time. For other sources or larger downloads, use the local package where the user controls the data source and machine.

The hosted server has eight tools because it adds `geod_artifact_link`, which issues a signed HTTPS download URL valid for ten minutes. The local package has seven tools and returns local artifact paths. Neither exposes `geod_render`.

## Download workflow

1. Call `geod_capabilities` or read `geod://examples/sichuan` or `geod://examples/henan` for a sample request. The examples use NASA Blue Marble overview imagery, not current high-resolution satellite imagery.
2. Call `geod_plan` with `{ "request": { ... } }`. It validates the request and estimates the image footprint without downloading data.
3. Call `geod_fetch` with that request. It returns a job ID immediately. Poll `geod_job_status` until `completed`, `failed`, or `cancelled`.
4. Check the manifest's source, bounds, quality, missing tiles, and warnings. Use `geod_get_artifact` for the preview PNG and small data files. On the hosted server, use `geod_artifact_link` for large files such as GeoTIFF.

Example request to an agent after connection:

> 用 GeoD 的河南示例先规划，再下载允许的概览影像和行政区边界。完成后展示实际下载得到的影像预览，返回 GeoTIFF、GeoJSON 和成果路径或下载链接，并根据 manifest 如实说明来源、范围、缺失瓦片和质量。

| Tool | Purpose |
| --- | --- |
| `geod_capabilities` | CLI availability, limits and examples |
| `geod_plan` | Validate and estimate a download |
| `geod_fetch` | Start an imagery download job |
| `geod_job_status` | Read progress, result and artifact metadata |
| `geod_cancel_job` | Cancel a running job |
| `geod_inspect` | Validate an existing GeoD bundle |
| `geod_get_artifact` | Read registered image or data artifacts |
| `geod_artifact_link` | Hosted only: signed URL for large artifacts |

## Run from source

```powershell
cd C:\path\to\geo-downloader\packages\geod-mcp
npm ci --ignore-scripts
$env:GEOD_WORKSPACE = 'C:\path\to\your\workspace'
node src/index.mjs
```

This starts a stdio MCP server. It emits protocol messages on stdout and waits for a client on stdin. `GEOD_WORKSPACE` confines local file inputs and bundle inspection. `GEOD_OUTPUT_DIR` can choose a separate output directory. Completed jobs and artifacts remain readable after a restart; interrupted jobs are marked failed and do not resume.

## Verification

From this source checkout, run `npm test` for local protocol, download, artifact, cancellation, OAuth and boundary tests. `npm run test:live` downloads real example imagery and reads its preview through MCP; it requires network access to the example sources.

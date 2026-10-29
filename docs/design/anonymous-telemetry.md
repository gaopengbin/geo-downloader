# Anonymous Telemetry

GeoD 3.6.22 and Agent 0.2.16 use disclosed default-on minimal diagnostics and
basic activity reporting. Acknowledging the notice is not an enable operation.
Users can turn reporting off; an existing explicit opt-out is retained.

## Client behavior

- Consent state: `pending`, `enabled`, or `disabled`.
- A random anonymous installation ID is generated for enabled GeoD clients.
- Reporting waits for saved preferences to hydrate, so an opt-out cannot leak a startup event.
- Legacy `pending` and absent choices migrate to enabled; the disclosure is acknowledged separately.
- Agent native preferences are authoritative. A missing browser preference must not write `false` on startup.
- Disabling telemetry clears queued events immediately.
- The installation ID can be reset from Settings.
- The event queue is capped at 50 events and never blocks application behavior.
- No network request is made when `VITE_TELEMETRY_ENDPOINT` is unset.
- Production endpoints must use HTTPS. Development builds may use localhost HTTP.

## Event allowlist

- `app_started`
- `mode_changed`
- `sidebar_tab_changed`
- `graticule_changed`
- `selection_changed`
- `region_imported`
- `bookmark_action`
- `download_task_created`
- `task_action`
- `measurement_used`
- `onboarding_event`
- `assistant_setting_changed`
- `assistant_panel_action`
- `assistant_request`
- `assistant_navigation`

The client does not accept arbitrary event names or properties. Do not add URLs,
file paths, filenames, search text, coordinates, selection bounds, tokens,
API keys, or downloaded content to this schema.

Assistant telemetry records only allowlisted feature actions and coarse result,
duration, diagnostic-attachment, source-count, and navigation-target buckets. It
never records prompts, responses, knowledge excerpts, model endpoints, API keys,
or raw error messages.

## Collector contract

`POST $VITE_TELEMETRY_ENDPOINT`

```json
{
  "schema_version": 1,
  "events": [
    {
      "event_id": "uuid",
      "event": "app_started",
      "occurred_at": "2026-07-29T00:00:00.000Z",
      "install_id": "uuid",
      "session_id": "uuid",
      "app_version": "3.6.6",
      "platform": "windows",
      "properties": {}
    }
  ]
}
```

The production collector is deployed at:

- Ingest: `https://laogao.xyz/geod-telemetry/v1/events`
- Aggregate dashboard: `https://laogao.xyz/geod-telemetry/admin/`

## First-party product events

Public website analytics are intentionally separated from GeoD desktop
telemetry and are owned by the Laogao platform API.

- Ingest: `https://laogao.xyz/platform-api/v1/product-events`
- Public aggregates: `https://laogao.xyz/platform-api/public/product-stats`

Web events use random browser-local visitor and session IDs. Only page paths,
referrer host names, UTM attribution, download platform/version, message-count
buckets, participant-count buckets, and export modes are accepted. Chat content,
avatars, generated images, URLs with query strings, coordinates, source URLs,
local paths, IP addresses, and downloaded content are never stored.

It validates this schema, rejects unknown fields, rate-limits requests,
deduplicates by `event_id`, and does not retain request IP addresses in the
database or application logs. The dashboard exposes installs, DAU, MAU,
version distribution, and event counts rather than raw event browsing.
# 3.6.17 下载诊断补充

在启用的匿名下载使用统计内，`download_task_state` 可附带版本为 1 的完整诊断块。字段仅含固定图源类别（天地图、其他、未知）、阶段、最终错误类别和 HTTP 状态，以及当前配置 Token 数、实际请求使用的不同 Token 数、切换次数、切换后首次成功取片次数、设置更新次数、最后一次凭证被拒绝的状态和是否全部不可用。

不同 Token 数仅在本机计算；不传 Token 本身、哈希、指纹、URL、图源自定义名称、路径、坐标、原始报错或响应体。计数为 0–65535 的整数。客户端逐字段构造，采集端拒绝额外字段、不完整诊断块、未知类别和越界计数。旧四字段事件仍然接受，历史缺失诊断不能推测为零。

诊断跟随随机下载尝试 ID，不新增永久标识；原有未同意不排队、不发送的边界不变。恢复仅代表备用切换后至少成功取得并校验一张瓦片，不能替代任务终态。最后拒绝状态与最终 HTTP 状态分开，以免把切换前的鉴权失败误报为后来存储失败的原因。401/403/429 不能单独证明 Token 具体权限或日额度状态。

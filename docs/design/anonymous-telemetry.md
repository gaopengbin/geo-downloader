# Anonymous Telemetry

GeoD telemetry is opt-in and disabled until the user explicitly chooses
`同意并开启`.

## Client behavior

- Consent state: `pending`, `enabled`, or `disabled`.
- A random installation ID is generated only after consent.
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

The client does not accept arbitrary event names or properties. Do not add URLs,
file paths, filenames, search text, coordinates, selection bounds, tokens,
API keys, or downloaded content to this schema.

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

It validates this schema, rejects unknown fields, rate-limits requests,
deduplicates by `event_id`, and does not retain request IP addresses in the
database or application logs. The dashboard exposes installs, DAU, MAU,
version distribution, and event counts rather than raw event browsing.

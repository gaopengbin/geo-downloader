# GeoD 3.6.25 release preparation — 2026-11-02

Authorized scope: publish the validated OSM result/output-location fix, configurable
raster overlays, native provider pacing/recovery, automatic installer failover and
canonical update manifests together; publish an in-app upgrade notice and complete
the matching minimal diagnostic events.

The native source recovery edits were reviewed in the shared checkout rather than
copied from the side conversation. The downloader and source-test path share
provider budgets; Tianditu 429 preserves the current credential, while 401/403 can
rotate configured fallbacks. Error bodies expose only bounded numeric service
codes. This is controlled recovery, not a claim that external continuous 403 is
eliminated. Core and CLI use the same modules.

Added telemetry uses three fixed schemas shared by client and collector:
overlay configuration, result-location actions and updater transitions. No paths,
source IDs/names, URLs, headers, coordinates or raw errors enter these events.
Update samples are deduplicated by phase/source/attempt, and installer handoff is
not counted as installation success. GeoJSON output and OSM storage errors have
explicit categories. Existing telemetry preferences and development suppression
are preserved. Collector rollout must precede desktop availability.

Local validation:

- Desktop native full library: 244 passed, 5 ignored, single-threaded.
- Core library: 149 passed, 2 ignored; CLI: 4 passed.
- Frontend: 84 passed; collector: 20 passed, including exact-schema parity and
  private-field rejection. TypeScript/Vite production build passed.
- Release validators: 17 passed; update-manifest validators: 5 passed.
- Changed feature telemetry/action files pass ESLint. Existing map/imagery baseline
  lint findings are documented in the preceding overlay work log.
- Prior actual Leaflet and source-editor fixtures exercised configuration, stacking,
  pan/zoom, removal and per-module restoration. OSM output/history fixtures and
  native filesystem tests are documented in the preceding OSM work log.

Release execution evidence, installer hashes, immutable GitHub source/run,
collector backup and activation, mirror rollback and notice readback are written
under `G:/code/tif-downloader/artifacts/geod-3.6.25-release/`. A source commit or CI
submission alone does not establish public availability or individual notice delivery.

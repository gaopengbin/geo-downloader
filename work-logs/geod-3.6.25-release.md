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

## Verified delivery

- Immutable desktop source: `8d2eded8f1a9cd63ac353ef6f15ae8971015edc4`, tag `v3.6.25`.
  Release workflow `41425774782` passed all four platform jobs, including both macOS
  signature checks. All five downloaded installers match GitHub SHA-256 digests;
  Windows embedded file/product version is 3.6.25.
- Public release: https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.25 .
  Mirror manifest and all five public download sizes verified. Windows exact URL
  follows its immutable accelerated copy and passes a full byte/hash readback.
  The existing reconciler's metadata check passes. Mirror rollback is
  `/srv/laogao/packages/v3.6.24`; original files remain available.
- Collector source is the same desktop commit. The database was backed up to
  `/srv/laogao/backups/geod-telemetry-3625-20261102/before.sqlite`; service identity,
  existing history and integrity were preserved. Four labeled test events were
  read back after public ingestion; duplicates deduplicate and private fields are
  rejected. No actual customer's new-version usage is inferred from this smoke test.
- Website source `c736f4835033c57cbb7b9c55553d5c94abe85f91` is live on all four
  desktop home/history routes. Forty unrelated documents, including Agent pages,
  were hash-preserved. Browser verified the displayed 3.6.25 links.
- Important public notice `geod-3-6-25-download-reliability`, revision 1, was
  published and read back for GeoD 3.6.11–3.6.24. Tests exclude 3.6.25+, older
  unsupported clients and GeoD Agent. The gateway ledger backup is
  `/srv/laogao/backups/geod-3625-notice-20261102-103416/agent-model-before.sqlite`.
  Individual client delivery/read and installation were not observed.
- The initial local artifact fetch through a specified proxy failed; normal
  network access and verified resumable ranges completed all downloads locally.
  The first probe immediately after graceful Nginx reload saw the old worker;
  fresh repeated probes verified the new exact redirect before mirror activation.
  No production host downloaded any GitHub resource.

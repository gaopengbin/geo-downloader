# Map/download layer selection synchronization — 2026-11-03

Local implementation, not published. One app-store ordered overlay selection
with visibility shared by sidebar/map and captured by raster download requests.
Ordinary and historical basemaps sync both ways. Selecting an overlay as base
removes the duplicate. Hidden entries remain configured but are not rendered or
downloaded. Existing auxiliary/reference-only layers are separate.

App persistence v2 migrates the old output composition first (explicit empty
lists preserved), then old preview preferences only as fallback. The legacy
parameter store no longer persists overlays. Save migration before unrelated
parameter writes; normalize rehydration and make repeated setters idempotent.

Normal, per-boundary batch, Esri single/batch, other historical imagery and Earth
request construction use the shared selection. Esri incremental remains base
changes only with a visible explanation. Floating control height is bounded and
scrollable; closing configuration returns keyboard focus to its layer toggle.

Validation: frontend 88 tests, tsc/Vite production build, 6 shared modules lint,
and diff check passed. Existing page lint signatures (11 errors, 2 warnings)
match the baseline with no new findings. Browser tested actual React/Leaflet
components against synthetic IPC/tiles: 18 receipts, bidirectional changes,
ordering, hidden-layer exclusion, modes, restart, dates and bulk request payloads.
1280x720 and 1024x640; Chinese light and English dark. No observed unhandled
runtime error, #185 maximum-depth error or uncached snapshot warning.

No real user settings, credentials, provider downloads, installed UI or exports
were used for these UI tests. QA tabs were closed after screenshots; no native
mouse operations. Evidence: G:/code/tif-downloader/artifacts/layer-sync-20261103

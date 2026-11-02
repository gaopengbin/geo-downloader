# User-configurable raster overlays — 2026-11-02

## Result

Map previews previously hardcoded two Tianditu annotation layers. Download output
offered only sources with particular label names/IDs. Both now offer registered
raster sources, including user-defined services, through a shared searchable picker.
Users can add/remove overlays, change their bottom-to-top ordering, and open the
existing source editor directly to configure URLs, XYZ/TMS, subdomains, zoom limits
and per-source request headers. There is no arbitrary layer-count or name limit.
MVT and encoded DEM sources remain outside the raster-compositing path.

Map configuration is available under Layers → Configure overlays, applies
immediately, and is remembered per module. Download overlays are selected
independently under output settings, preserving the existing separation between
preview and exported content. The picker explains that distinction. Old cia/cva
preferences resolve to the corresponding editable source IDs. No settings schema
or native request contract changed.

Overlay instances are independent from base layers and keyed by source ID/config.
Visibility changes remove unused layers, order changes update stacking without
re-fetching unchanged tiles, and source edits recreate only affected overlays.
Native-authenticated preview requests use the existing source-ID/coordinates path;
credentials are not put into map labels or stored in overlay selections. Download
requests preserve stacking order and remove stale, duplicate, base and non-raster
IDs before submission. Removed sources are marked unavailable and stop rendering.

The source-manager trigger explicitly uses type=button so opening it inside the
download form cannot submit a task. Nested instances do not subscribe to the global
assistant open-sources action.

## Verification

- 81 frontend tests passed, including arbitrary custom-source names, preservation
  of source options/headers, legacy preference mapping, ordered deduplication,
  unavailable-source filtering, and non-mutating reordering.
- TypeScript/Vite production build passed; existing bundle-size warning remains.
- New/changed source picker/editor/store/fixture files lint clean. MapCanvas and
  ImageryPage retain pre-existing lint findings; comparison with HEAD found no
  added findings and removed one unstable overlay-array dependency warning.
- Browser used real MapCanvas, OverlayPicker and SourcesDialog with isolated native
  commands and synthetic transparent tiles. Checked add/save/request headers,
  immediate source-list refresh, search, ordering, source deletion, unavailable
  indication, legacy restoration, per-module isolation and reopening persistence.
- Real Leaflet pan/zoom generated new source-ID/coordinate requests: 80 requests
  after initial setup, 96 after pan and 176 after zoom. All four rendered layers
  had 20 loaded images at the inspected view. Reordering kept the request count at
  176 and updated stacking. Switching to empty Wayback preferences left one base
  layer; returning to imagery restored the base plus two overlays.
- Output-order browser fixture recorded custom_grid then custom_roads using the
  production selection helper. No real download/export task, third-party provider,
  customer settings or credentials was used for this validation.
- The standalone development fixture emitted a createRoot warning during hot
  module replacement; ordinary fresh-load interaction had no console warnings or
  errors. This is retained in the evidence rather than attributed to a shipped app.

Fixture: `frontend/tests/custom-overlays.html`; `restore`, `dark`, `en` switches
exercise persisted selections and appearance. Evidence and lint baseline comparison:
`G:/code/tif-downloader/artifacts/custom-overlays-20261102/`.

## Delivery

Source implementation and local verification only. No installer, release or
in-app notification was published. Concurrent native tile-recovery/pacing changes
are preserved outside this change.

# OSM task results and output location — 2026-11-02

## Problem and behavior

OSM download errors had no durable history record, while the task panel hid failed
tasks. A failure could therefore disappear with no visible explanation or output.
Successful downloads also lacked an obvious full output path in the current task.

- Keep failed tasks visible until explicitly removed. Retain completed OSM tasks
  so that a history-write failure cannot hide the output.
- Persist OSM failures and successes with the task ID as history ID, the planned
  or actual absolute path, error, and existing log metadata. Hide duplicate history
  cards only when the corresponding current task is visible; unrelated jobs with
  the same output path remain distinct.
- Add a nullable history error column transactionally. Existing rows and legacy
  JSON remain readable; no history is replaced during migration.
- Show full wrapping, selectable paths, copy path, and successful-output open-folder
  buttons. Failure paths are clearly marked as planned/unconfirmed output.
- Write OSM GeoJSON to a unique same-directory temporary file, flush it, then
  replace the destination and check file type/size before marking completion.
  Cancellation before commit or a locked destination preserves existing content.
- A missing OSM file produces an explicit error instead of opening an unrelated
  ancestor directory. Existing raster/multi-zoom folder fallback is retained.
- History read errors are shown explicitly while current task results stay visible.

## Validation

- Native osm_output tests: 9 passed on Windows, including locked destination,
  cancellation, real write failure, file existence/size, failure history reopen,
  idempotent history identity, and verified successful output.
- History tests: 12 passed, including upgrade from a database without the new
  column and preservation of existing rows.
- History maintenance tests: 2 passed.
- Frontend tests: 77 passed. TypeScript/Vite production build passed (existing
  large-chunk warning). Changed UI/helper/fixture ESLint checks passed.
- Browser exercised the real TasksPanel and HistoryPanel against isolated Tauri
  fixtures: failed task stays, success path is fully shown, open/copy receives the
  exact full path, strict file checking is requested, removing a current task
  reveals its failure history, empty current cache shows archived results, missing
  output shows an error, and history read failure leaves both results visible.
  English/dark mode checked; no browser console warnings/errors in the normal path.
- Browser fixture does not open Explorer or use the physical clipboard/mouse.
  Native file/history tests use temporary directories, not customer data.

Evidence: `G:/code/tif-downloader/artifacts/osm-result-fix-20261102/` contains
`results-light.png`, `history-restart-dark.png`, `missing-file.png`, and
`history-unavailable.png`. Fixture entry: `frontend/tests/osm-results.html` with
optional `restart`, `missing`, `history-fail`, `dark`, and `en` query switches.

## Delivery boundary

Source fix and local verification only; no installer or release was published.
Old failures that never wrote a record cannot be reconstructed retrospectively.
The original customer's missing file/path has not been independently recovered.
Concurrent tile-request recovery and pacing edits are outside this change.

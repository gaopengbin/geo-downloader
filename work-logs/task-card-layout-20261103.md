# Task/history card layout — 2026-11-03

Local implementation, not published. Shared heading for current, interrupted
and history cards; two-line title, fixed status, separate source/zoom row.
Move task actions below content and pin delete independently. History numeric
facts and creation time are separated. Bulk controls are contextual and a
three-column grid, independent of select-all/invert controls.

Full paths remain selectable/copyable, bounded vertical scrolling for long
paths, fixed copy icon and full-width open-folder action. Planned/failed output
semantics, OSM strict-file behavior, retention, action handlers and confirmations
are preserved. Long errors and logs wrap/scroll without expanding card width.

Validation: frontend 88 tests; production TypeScript/Vite build; four component
ESLint; diff check. Actual React components in an isolated mock-native fixture:
280/320/400px, normal and 9-card stress cases, zh light/en dark; geometry,
expanded logs, full-path copy/open arguments, resume/pause, pyramid, delete cancel.
No real clipboard, Explorer, jobs or files touched. Running native GeoD window
read-only screenshot/AX verified hot update, no render-error screen. No mouse input.

Evidence: G:/code/tif-downloader/artifacts/task-card-layout-20261103/report.md

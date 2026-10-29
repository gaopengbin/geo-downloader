# Esri Wayback date synchronization regression

This fixture mounts the actual `WaybackPage`, `WaybackTimeline`, shared Select and Zustand stores with an isolated Tauri bridge and three synthetic dates. It never modifies user settings or downloads imagery.

Build a minified production fixture from `frontend`:

```
node tests/build-esri-date-switch.mjs <new-output-directory>
```

Serve that directory, open `tests/esri-date-switch.html`, and select another imagery date. Before the fix, the local sidebar date -> preview-store effect and preview-store -> local date effect overwrite each other on every render, causing React #185. The same loop can be triggered by the timeline.

After the fix, select dates in both directions, alternate timeline Home/End or previous/next controls, refresh versions, and switch single/batch/incremental modes. The sidebar, timeline and visible selected-ID receipt must converge with no error boundary or console errors. Re-selecting the same date should not publish another store update.

The first local production acceptance covered 30 dropdown changes and 30 timeline changes, refresh and all three modes. Real imagery transport is outside this fixture; it specifically exercises the previously crashing UI/state path.

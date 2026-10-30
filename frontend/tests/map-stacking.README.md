# Map workspace stacking regression

Run `npm run dev -- --port 1442` from `frontend`, then open
`http://127.0.0.1:1442/tests/map-stacking.html`.

This mounts the real App, SettingsPanel, Leaflet map, WaybackTimeline and shared
Dialog. Native commands use isolated synthetic settings and three dates; no real
settings or API keys are read or saved. Use a development server so the normal
runtime policy disables telemetry, update checks and automatic onboarding.
Theme and store preferences belong only to this localhost origin.

1. Enable the AI assistant switch to open the consent dialog, without accepting.
2. The timeline must be blurred beneath the overlay, including where it overlaps
   the checkbox and bottom buttons. The main map must compute `isolation: isolate`.
3. Cancel, then click timeline previous/next or use Home/End. Dates must change.
4. Confirm map zoom and attribution remain available after closing the dialog.
5. Repeat with the light theme and the About dialog. Its overlay must cover the
   timeline even outside the dialog's bounds.

Before the fix, the real App map had no stacking context: the timeline's z-index
450 escaped above the global dialog and overlay at 50. The fix contains all map
overlays in the workspace without changing their ordering within the map.
This checks UI stacking; it does not validate real imagery or native WebView input.

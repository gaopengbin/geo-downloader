# Update dialog automatic failover regression

Run `npm run dev -- --port 1443` in frontend, then open
`http://127.0.0.1:1443/tests/update-failover.html`.

This mounts the actual UpdateDialog/store, i18n and shared modal components.
The isolated Tauri bridge checks the SHA256/size IPC arguments and emits the native
transfer schema. It never launches an installer, exits the application or changes
system proxy settings. Native transport behavior has separate Rust tests.

- Default: click Update now; primary downloading → switching → backup downloading
  → verifying at 99% → installation launch message at 100%. Both event listeners
  must be removed when the command completes.
- `?hold=backup`: hold the backup phase for visual inspection and screenshot.
- `?fail&dark&en&hold=backup`: first invocation fails after automatically trying
  sources. Update now returns, active listeners reach zero. Retry succeeds through
  the backup phase with exactly two listeners, not duplicate subscriptions.
- Receipt output is QA-only; it also records that no installer was launched.

Theme/language state is scoped to this localhost origin. Production windows keep
their usual theme and language preferences.

# Tianditu scheduling recovery optimization — 2026-11-03

Local candidate, not published. Replaces the permanent post-limit slow recovery
mode with bounded isolated/repeated congestion observation, retains the 64/s and
16-in-flight ceiling, and adds a FIFO send clock plus rolling-window admission.
Normal timer oversleep is bounded and compensated; long stalls reset the clock.
No credentials or complete request URLs are stored by the scheduler.

Same 2048-tile, two-task, injected-429 native fixture: 108.807s
before, 40.330s after (62.9% less time), 2049 requests,
2048 files byte-verified, both tasks naturally completed, resume 0 requests.
Both measured builds use release optimization and multi-thread Tokio.

Live provider: 1024 imagery + 1024 annotation (2048 total), cold cache, task
concurrency 30, existing proxy and personal test Key. Completed in
38.904s, 2048 HTTP 200, no 429, all 2048 files fully decoded at
256x256 and byte-identical to the matching previous provider sample. This is a
smaller live task than the previous 4096 run; no live speed ratio is inferred.

Desktop 258 passed / 6 ignored; core 163 / 3; CLI 4 passed. Busy-runtime pacing,
rolling-window limits and lowered-rate admission, queue-front cancellation,
short-term recovery and repeated/broad congestion regressions pass.

Formal settings remained unchanged and the private handoff was removed. No
installed UI, whole-region export or publication tested/performed. Live 429
recovery was not observed this run; the recovery claim is socket-test evidence.

Evidence: G:/code/tif-downloader/artifacts/tianditu-recovery-v2-20261103/report.md
Frozen worker SHA-256: 7bf8b360f060bef0d10cea5c547ddc788d7d27500bc3f5c40b98f2b6268dd4a1

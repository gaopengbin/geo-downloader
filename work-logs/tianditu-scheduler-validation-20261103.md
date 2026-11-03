# Tianditu download scheduler validation — 2026-11-03

Status: bounded real-provider acceptance passed; local candidate, not published. Results are recorded in
`G:/code/tif-downloader/artifacts/tianditu-scheduler-20261103/live-4096/verified-result.json`.

## Implementation

- Smooth start: each Key/service begins at 16 requests/s and 4 in flight, rising
  by 4 requests/s and 1 in flight only after 16 successes and 2 stable seconds;
  client ceilings are 64 requests/s and 16 in flight. Task concurrency still applies.
- One shared process-local budget per actual credential and canonical WMTS
  service, across tasks, subdomains, preflight, source probes and retries. Image
  and annotation services learn separately. Credential changes while queued
  cause reselection. The registry retains digests only, with stable overflow.
- Congestion halves rate and concurrency, coalesces replies from one old request
  wave, and honors Retry-After. Missing headers use jittered exponential backoff.
  A service-wide streak prevents new tiles from resetting repeated cooldowns.
- Recovery after a limit requires 16 new successes and 5 stable seconds, then
  increases by only 1 request/s and 1 in flight. Subsequent tasks reuse the rate.
- No accumulated send credits or cooldown-end burst. Queued cancellation does
  not reserve a future start; dropping a request releases capacity.
- Progress exposes automatic cooling. 429 preserves the Key; bounded persistent
  rejection retains existing files. Recently progressing tasks defer isolated
  rate-limited tiles to the existing bounded repair rounds; repair uses x/y.png.

Client rates are not claims about the provider's quotas. The all-applications
quota screenshot does not prove a particular application's remaining quota.

## Validation

- Desktop native library: 252 passed, 6 opt-in ignored.
- Core library: 157 passed, 3 opt-in ignored. CLI: 4 passed.
- Opt-in socket integration: two concurrent tasks on t0/t7 share one test Key
  and service. 2048 files verified byte-for-byte, 2049 requests including one
  injected 429; both tasks completed naturally in 111.836 seconds. Resuming the
  first 1024-file task performed zero additional requests.
- Visible cooling/cancellation integration passed: only one 429 request, no
  extra requests after cancelling during a ten-second cooldown.
- Real-provider test: optimized native source harness, cold cache, 2048 image
  coordinates plus 2048 annotation tiles, configured task concurrency 30.
  Ordinary user settings are verified unchanged, credentials are runtime-only,
  and the one-use private handoff is removed before download begins.
- The real run checks native task termination, actual saved files and complete
  decoding of every 256x256 image. It does not run an installed desktop build,
  whole-region export or release/deployment. Source and worker hashes accompany
  the result. The cancelled 146022-coordinate test is never resumed.
- Real result: completed naturally, 4096/4096 saved and fully decoded at 256x256,
  no gaps, 4096 HTTP 200 responses, no 429, no credential rotation. Total download
  time 111.361 seconds (including layer preflight); imagery batch 55.373 seconds
  including preflight, annotation batch 55.987 seconds. This is a local measured
  result on the configured network, not an installed-build or all-users speed
  guarantee. Real-provider recovery after 429 was not observed in this run;
  recovery is established separately by the injected-429 socket test above.

See the verified result for the measured provider statuses, duration and saved
counts; a controller exiting zero alone is not download success.

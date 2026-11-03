# Tianditu adaptive candidate — not released

The published 3.6.25 process-wide 4-request/125ms starting budget was too
conservative for large jobs. Local candidate changes restore healthy traffic to
the configured task concurrency, with a shared maximum matching the downloader's
supported 100. Rate responses activate pacing and explicit cooldown; stable
post-limit success windows gradually restore speed. Late parallel replies cannot
multiply one wave of throttling or prematurely declare recovery.

Real optimized native-source tests exposed another issue: one rate-limited tile
could exhaust its per-tile attempts while many others still succeeded, terminating
the entire large job. The candidate queues that tile for the existing bounded
retry rounds while usable progress remains recent. Empty preflight, explicit
server waits above 60 seconds, or 90 seconds without usable progress remain
terminal. Retry writes now use canonical x/y paths and are reused on resume.

Validation: native library 252 passed / 5 ignored; Core 157 passed / 2 ignored.
A loopback integration test verifies an isolated 429 among usable tiles is filled
by the retry round and does not generate more requests on resume.

Real provider observations, using the user-authorized Key without changing saved
settings: old 3.6.24 stopped at 90 successful annotation tiles with HTTP 429 and
reported tokens exhausted; the candidate fetched 9673 despite 91 rate responses,
then stopped when no progress continued. Neither reached the cancelled 146022
target. A later standalone 4096-tile candidate task failed at preflight with three
429 / 302010 responses and zero output. This is NOT successful medium-size
acceptance. Do not publish this candidate as fully validated.

The diagnostic probe at an earlier point observed img 429 with message indicating
the token was limited, while cia returned 200. The final medium run also received
429 from cia. Do not extrapolate an earlier healthy layer to current availability
or label either status as proof of daily quota exhaustion.

Evidence and provenance: G:/code/tif-downloader/artifacts/tianditu-3624-vs-3625/ .
Read current-result.md and final-test-status.json for the latest result; the early
80/160-tile report and 4096 debug speed checkpoint are historical evidence, not
the final candidate's completed end-to-end acceptance. No credentials are included
in reports. User cancelled the full-size target and subsequent tests are bounded
to 2000–5000 tiles. Existing outputs are retained; no automatic test restarts.

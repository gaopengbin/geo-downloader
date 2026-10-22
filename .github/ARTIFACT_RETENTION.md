# Actions artifact retention

This policy manages temporary **Actions artifacts only**. It does not remove
GitHub Release assets, published packages, Actions caches, workflow runs/logs,
production directories, databases, or server rollback versions.

- Diagnostic transport fixtures: 1 day.
- GeoStyle deployment bundles: existing 3-day expiry; cleanup additionally keeps
  the latest two successful source runs per workflow/ref/event while available.
- Dashboard site handoff bundles: 1 day; Linux candidate/control bundles: 3 days.
  Portfolio bundles downloaded through the local relay: 7 days.
- GeoD release-job handoff bundles: 3 days; standalone MCP Linux builds: 7 days.
- GeoD Global evaluation installers: 7 days; Launch Deck installers: 7 days,
  portable verification builds: 3 days.
- Successful deployment/build families retain the latest two distinct successful
  runs (backup control keeps one); unrelated branches, tags, events, and services
  cannot displace one another.
- No artifact younger than 24 hours is deleted by the cleanup script. Failed
  builds keep the corresponding diagnostic window. Active runs/reruns, unknown
  artifact names, foreign sources, missing metadata, and identity mismatches are
  retained. API inventory failures stop deletion.
- Run `Maintain artifact storage` manually with `dry_run=true` (the default) to
  preview. Scheduled and completed-build runs apply the reviewed policy.
  Decisions and deletion byte counts go to logs and the job summary, not a new
  artifact. Jobs use the default branch, never upstream PR source.
- To exclude a run from **script-driven cleanup**, set repository Actions variable
  `ARTIFACT_RETENTION_PINNED_RUN_IDS` to comma-separated numeric run IDs.
  This does NOT override GitHub's native expiry. For long-term preservation,
  archive/checksum the accepted bundle outside Actions before it expires.
- Existing artifacts keep their original native expiry. They are only considered
  for earlier deletion if superseded and outside the grace period.
- Rollback must use the server's immutable release history or the accepted
  GitHub Release asset, not an indefinitely retained temporary CI file.
  GeoStyle's run-ID deployment helper requires a still-available source bundle:
  download/checksum/archive it within the 3-day window before planning deployment.
- Before shortening any new artifact family, inspect both producer and consumers.
  Unknown artifact types are intentionally not deleted automatically.
- New names/retention changes must update the allowlist, documentation, and tests.
  Run `node --test .github/scripts/artifact-retention.test.cjs`.

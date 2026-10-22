# Actions storage retention

Applies only to `gaopengbin/geo-downloader`. Updated 2026-10-22.

## Schedule and operation

`artifact-retention.yml` runs daily on GitHub-hosted runners, without a local PC,
and after the existing allowlisted build/deploy workflows complete. Manual dispatch
defaults to dry-run; set `dry_run=false` to apply. The first step runs all safety
tests. Decisions, actual deleted bytes, missing objects and remaining usage appear
in the job summary and logs. It does not upload another artifact for its own report.
Only trusted default-branch source is executed; no upstream PR checkout and no PAT.

## Artifacts

- Smoke/one-use site bundles: 1 day; build/deploy bundles: 3–7 days as configured by
  their upload step. The repository fallback for future uploads is 14 days.
- The cleanup script recognizes only reviewed names. It keeps the newest two
  successful builds per artifact family/workflow/ref/event, except one-use bundles.
  Failures keep their diagnostic window. Unknown names and missing/mismatched run
  records are retained for inspection, never force-deleted to meet a budget.
- Optional `ARTIFACT_RETENTION_PINNED_RUN_IDS` (comma-separated IDs) protects
  deployment inputs from this script. GitHub's own upload expiry still applies;
  long-lived release/rollback archives belong outside Actions artifacts.
- Active or queued/waiting consumers freeze deletion. IDs/source fingerprints and
  activity are checked again immediately before mutation. Already absent objects
  are not counted as reclaimed storage.
- Artifact warning threshold: 384 MiB.

## Caches

- GitHub native cache idle retention remains 7 days and its storage ceiling remains
  10 GB; paid cache expansion is not enabled.
- Reviewed npm/yarn/pnpm, pip, Rust and tiny transport-test keys only. Unknown keys
  are kept. Keep recently created/accessed (24 h), active-build and open/unknown-PR
  caches. Keep newest main key per OS/tool family until idle expiry.
- Remove superseded main keys, closed-PR keys and expired transport fixtures after
  the grace period; remove idle dependency caches after 7 days. Over the soft budget,
  evict eligible non-main branch/tag caches in least-recently-used order.
- Cache soft budget: 4 GiB. Protected/recent caches
  take precedence; exceeding either soft budget produces a workflow warning, never
  release deletion. Re-list identity/access time, PR state and activity before deletion.

## Protected boundary and limitations

The HTTP client permits DELETE only at `actions/artifacts/<id>` and
`actions/caches/<id>`. GitHub Releases and release assets, updater/CDN packages,
packages, source refs, workflow logs and server rollback files are never deleted by
this workflow. Repository fallback retention also governs future logs/check records;
it is not an instruction to delete workflow runs. New repository/unknown key types
must be reviewed before enabling cleanup. Daily scheduling can be delayed by GitHub;
public repositories without activity may have schedules disabled after 60 days.

## Verification

Run `node --test .github/scripts/artifact-retention.test.cjs .github/scripts/cache-retention.test.cjs`.
Then manually dispatch a dry-run, review the summary, dispatch apply mode and inspect
the readback. Formal published release assets are independent of Actions retention.

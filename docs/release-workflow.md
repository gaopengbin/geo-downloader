# Desktop release checks

The `Release` workflow validates the selected source before starting any platform build:

- The tag, Tauri version, Cargo package version and lockfile version must agree.
- Release notes must be non-empty. The canonical path is `docs/release-notes/release-notes-v<VERSION>.md`; the existing `docs/releases/<VERSION>.md` layout is also supported. The canonical file wins when both exist.
- Every build and the final release use the immutable commit checked by preflight, including manual dispatches.
- Manual dispatch requires an existing tag and defaults to **validation only**. Keep that option enabled when checking the workflow against a previously published release; it does not rebuild installers or modify the release.
- Builds continue to create a draft. Public activation still requires checksum verification and mirror preparation.

Local check: `python scripts/validate_release.py --tag v<VERSION>`.

The deployment control repository's reconciler verifies the public feed and all five installers. It can adopt an already published and verified mirror even if its local version ledger is stale. Synchronization uses permanent GitHub Release attachments and their SHA-256 digests, so a failed historical Actions run, expired build artifacts or a manual recovery publication do not prevent synchronization. New/changed releases receive full-byte validation; unchanged releases receive size/metadata checks and daily full-byte revalidation. Failed verification never advances the local ledger.

# GeoD AI Assistant and Agent Design

## Goals

- Answer GeoD product questions from maintained, attributable knowledge.
- Keep model-provider configuration outside the desktop client.
- Let answers guide users into the correct interface through controlled actions.
- Add operational tools gradually without allowing arbitrary model-side execution.

## Request flow

1. The desktop sends recent user/assistant messages and optional explicit diagnostics.
2. The gateway ignores client-provided system messages.
3. The gateway retrieves curated GeoD articles for the latest user question.
4. The gateway builds the server-owned system prompt from product policy, retrieved
   articles, allowed navigation links, and optional diagnostics.
5. The upstream model streams its answer through the gateway.
6. The gateway returns matched article metadata in
   `x-geod-knowledge-sources`.
7. The desktop renders citations and validates every `geod://` action against its
   local allowlist.

## Knowledge ownership

`services/ai-gateway/knowledge/articles.json` is the published source of truth.
Work logs, plans, issues, and model-generated text are not ingested automatically.
An editor must review released behavior, legal wording, and navigation actions
before updating the content version.

The first retriever is deterministic lexical search. The retrieval API is isolated
in `knowledge-base.mjs`, allowing later replacement with hybrid BM25 and embedding
search while preserving the client contract and source metadata.

## Action trust levels

### Level 0: navigation

Allowed without confirmation:

- Switch a product mode or sidebar tab.
- Scroll to a registered interface section.
- Open the source-management dialog.

These actions do not modify user data.

### Level 1: reversible draft changes

Future tools may fill a form or prepare a source configuration. They must show the
proposed values and require the user to save them.

### Level 2: consequential actions

Creating tasks, changing persisted settings, stopping downloads, clearing cache,
and deleting records require an explicit confirmation dialog describing the exact
effect. Destructive actions must never be encoded as clickable Markdown links.

## Production requirements

- Device or account authentication instead of a shared gateway token.
- Persistent per-user quotas, rate limits, audit events, and spending limits.
- HTTPS termination, secret rotation, request timeouts, and abuse monitoring.
- Knowledge publishing workflow with schema validation and content-version history.
- Tool execution logs containing action id, parameters, approval, result, and error,
  without storing provider keys or unnecessary user data.

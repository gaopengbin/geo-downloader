# GeoD AI Assistant and Agent Design

## Goals

- Answer GeoD product questions from maintained, attributable knowledge.
- Keep the feature developer-only and disabled by default.
- Let developers supply their own DeepSeek key and keep it in the operating
  system credential store.
- Require a second confirmation of the AI disclaimer and privacy statement before enabling.
- Let answers guide users into the correct interface through controlled actions.
- Add operational tools gradually without allowing arbitrary model-side execution.

## Request flow

1. After the developer explicitly enables the feature, the Rust desktop backend
   reads the configured key from the operating system credential store.
2. The desktop backend retrieves curated GeoD articles for the latest question.
3. The desktop backend builds the system prompt from product policy, retrieved
   articles, allowed navigation links, and optional explicit diagnostics.
4. The Rust HTTP client sends the request directly to the configured DeepSeek
   compatible API and streams events to the WebView through a Tauri channel.
5. The desktop renders matched sources and validates every `geod://` action against its
   local allowlist.

Legacy plaintext keys are migrated once from `settings.json` into the system
credential store and removed from subsequent settings serialization.

`services/ai-gateway` remains a development test harness for browser and gateway
experiments. It is not required by the production desktop request path.

## Knowledge ownership

`services/ai-gateway/knowledge/articles.json` is the published source of truth.
Work logs, plans, issues, and model-generated text are not ingested automatically.
An editor must review released behavior, legal wording, and navigation actions
before updating the content version.

The first retriever is deterministic lexical search. The production implementation
lives in the Rust assistant module; `knowledge-base.mjs` mirrors the same behavior
for the development gateway. This boundary allows later replacement with hybrid
BM25 and embedding search while preserving source metadata.

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

- Device or account authentication for any server-funded requests.
- Persistent per-user quotas, rate limits, audit events, and spending limits.
- HTTPS termination, secret rotation, request timeouts, and abuse monitoring.
- Knowledge publishing workflow with schema validation and content-version history.
- Tool execution logs containing action id, parameters, approval, result, and error,
  without storing provider keys or unnecessary user data.

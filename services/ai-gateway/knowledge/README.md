# GeoD Knowledge Base

`articles.json` is the curated product knowledge source used by the GeoD AI gateway.

Rules:

- Keep each article focused on one user intent.
- Describe released behavior only. Do not ingest work logs or plans directly.
- Give every article a stable `id`; answers cite it as `[知识库: id]`.
- Navigation actions must use an existing `geod://navigate/<action-id>` entry from the desktop action registry.
- Do not include API keys, private service URLs, user data, or third-party copyrighted content.
- Update `contentVersion` whenever published knowledge changes.

The gateway currently uses deterministic lexical retrieval. Its interface is intentionally independent of the model provider so an embedding or hybrid retriever can replace it later without changing the desktop client.

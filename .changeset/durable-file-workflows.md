---
'@nestm/storage': minor
---

Add framework-neutral durable file workflows with immutable integrity-checked
staged bodies, bounded UTF-8 reads/search, idempotent chunk appends, and explicit
host transaction ports for atomic multi-file head commits. Add protected catalog
and draft capabilities and generic tools in the existing optional AI SDK entrypoint.

Add a browser-safe bytes entrypoint for verified upload resumption and UTF-8
chunk boundaries. Preserve the default memory driver with native conditional
create/replace/read/delete, evaluated atomically after body consumption, and
canonical SHA-256 ETags. Memory remains volatile and process-local.

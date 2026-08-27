---
'@nestm/storage': minor
---

Add injectable, replica-safe workspace pagination cursors. The workspace now
binds versioned cursor payloads to stable store, mount, tenant/workspace, prefix,
operation, query, limit, and expiry context; authorizes non-consuming replay
before that expiry; and rejects altered or cross-context continuations.
Successful continuation still depends on the embedded provider cursor remaining
valid and available.

Export an AES-256-GCM key-ring codec for stateless multi-replica deployments and
an asynchronous byte-payload codec contract for shared durable opaque-token
stores. Cursor payloads and tokens are bounded, provider continuations remain
opaque, and pagination fails closed when no cursor mechanism is configured.
Compatible replicas rely on the universal driver contract for non-consuming,
instance-portable provider cursors whose position is independent of page size
while the provider token remains valid. Cursor expiry is not a provider-token
retention, snapshot-isolation, or uptime promise; provider invalidation remains
an operational list failure.

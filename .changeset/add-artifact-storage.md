---
'@nestm/storage': minor
---

Add byte-compatible encrypted artifact storage through the
`@nestm/storage/artifacts` and `@nestm/storage/artifacts/nest` entry points.

The framework-neutral facade stores self-contained CAE1 AES-256-GCM envelopes,
binds ciphertext to its tenant, artifact, version, and path context, supports
local and AWS KMS key providers, and preserves authenticated content types,
bounded reads, versioned bundles, legacy migration reads, and encrypted generic
objects. The Nest entry point composes artifact and object adapters over two
named storage clients and clears cached data keys on shutdown.

The public protocol keeps the deployed filesystem and object-provider layouts,
reserves configurable ObjectStore namespaces from artifact ids, validates all
artifact/version paths, and bounds ZIP entry count and expansion before any
write. CAE1 now rejects unauthenticated empty content types and writer-side
oversized headers, KMS verifies the stored key id, DEK cache lifetimes are
capped at five minutes, filesystem `.ct` collisions are rejected, and sweepers
skip objects without trustworthy timestamps.

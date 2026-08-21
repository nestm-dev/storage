# @nestm/storage

## 0.1.0-alpha.9

### Minor Changes

- aec25d6: Add explicit last-write-wins workspace write, copy, and unconditional-delete
  operations that traverse the ordinary Files SDK plugin, hook, and receipt
  pipeline while retaining the existing native conditional create, replace,
  copy, move, and delete variants. Unconditional delete requires both `write` and
  `delete`; move remains conditional-only because a non-atomic
  download/upload/delete sequence could delete a newer source generation. Add a
  separate `write` permission and an AI tool factory mutation-mode switch whose
  default remains conditional.

  Add bounded binary workspace reads through `readBytes`, alongside the existing
  UTF-8 `readText` API. `readBytes` is a required `StorageWorkspace` member, so
  custom interface implementations and typed test doubles must add it when
  upgrading; workspaces returned by `mountStorageWorkspace` need no changes.

### Patch Changes

- 37e0d8d: Fail conditional storage operations closed when caller-configured Files SDK
  plugins, hooks, or receipts would be bypassed by native adapter extensions.
  Ordinary operations continue through Files SDK while incompatible conditional
  capabilities are hidden until Files SDK exposes one shared interception boundary.

## 0.1.0-alpha.8

### Minor Changes

- d81c6f4: Add a typed `mapCreateConflict` hook to the AI SDK workspace adapter so
  applications can represent atomic create collisions as domain results without
  mutating generated tools. Keep replace/ETag conflicts fail-closed and sanitize
  mapper failures at the tool boundary.

  Mark workspace tools with optional inputs or a combined create/replace union as
  non-strict for provider schema generation while retaining strict Zod runtime
  validation.

- a0ea392: Add injectable, replica-safe workspace pagination cursors. The workspace now
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

- d996b92: Split the aggregate S3 conditional-mutation and copy declarations into exact
  create, replace, delete, read, source-copy, destination-copy, atomic-promotion,
  and multipart-completion capabilities. Add independent AWS S3, Cloudflare R2,
  and fail-closed custom-endpoint profiles that force unverified drivers
  read-only; enforce complete physical-key byte budgets; normalize provider
  errors without retaining raw provider payloads or causes; and publish a reusable
  provider conformance contract with gated filesystem, AWS, R2, and custom suites.

  Normalize every provider ETag to a canonical bare 1–1024-byte visible ASCII
  token and serialize exactly one HTTP quote pair at S3 request boundaries.
  Quoted, weak, wildcard, list-shaped, control-bearing, non-ASCII, and otherwise
  unsafe values now fail closed instead of being accepted as arbitrary non-empty
  strings. Applications that persisted quoted ETags must refresh them from
  provider metadata before conditional mutation; this prevents wildcard/list and
  header-ambiguity inputs from widening an exact-match precondition.

  Specify and test provider list cursors as non-consuming replayable tokens for
  unchanged provider state, so higher-level replayable pagination can fail closed
  when a provider cannot meet that contract.

  Exercise the complete advertised source-condition by destination-condition
  promotion matrix, including stale-state preservation and competing stale/valid
  requests. Provider documentation or audited implementation evidence remains
  required for the internal one-linearization-point claim.

  Ordinary and conditional provider failures now expose stable public messages
  and preserve only normalized codes and retry flags; raw provider bodies,
  request metadata, and nested causes are not retained in loggable error shapes.

  Raise the `@aws-sdk/client-s3` peer floor to 3.919.0, the first release that
  serializes destination conditions for `CopyObject`, and verify the real wire
  headers in the packed minimum-peer consumer. Native AWS construction now
  disables environment and shared-config endpoint URL overrides, while the public
  capability helper derives custom-endpoint provenance from the actual SDK client
  instead of a duplicated caller hint. Capability decoration is now single-use
  per raw S3 adapter, preventing broader operations from surviving a later
  narrower profile application.

  Bind S3 provider authority to package-private raw-client and adapter-method
  identity plus the exact surface snapshot installed by capability decoration.
  Structurally S3-backed raw adapters are rejected until they pass through the
  package helper, regardless of adapter name, proxying, or forged global symbols;
  same-client aliases cannot replace their raw client, ordinary methods, policies,
  or conditional operations. Unverified custom endpoints and noncanonical
  S3-backed provider slugs are forced read-only, while an explicit branded profile
  unlocks only its declared conditional operations. Endpoint and public-URL
  provenance now follows the adapter actually produced by the provider loader,
  including `configJson`.

  Retain `publicBaseUrl` construction policy in the package-owned `s3()` helper
  so omitted decorator hints cannot re-enable an expiring-download claim. Unknown
  foreign S3 construction conservatively disables that claim. Validate the exact
  physical adapter key without stripping leading slashes, and include configured
  separators plus list/search-derived prefixes in the provider byte budget before
  dispatch. Search uses files-sdk's own inferred glob-prefix and zero-result
  semantics instead of duplicating its matcher logic. The innermost dispatch guard
  repeats these checks after supported in-process plugins have transformed an
  operation; adapters and plugins remain trusted code rather than a sandbox
  boundary.

  Derive signed-upload policy claims from the branded provider profile instead
  of granting them to every S3-compatible endpoint. Native AWS proves content
  type and POST size-range enforcement; Cloudflare R2 proves content type but not
  POST form size ranges; omitted custom declarations normalize to false/false so
  the gateway fails closed. Profile authority is backed by a package-private
  WeakSet after deep freezing, so reflecting and copying the nominal brand symbol
  cannot forge conformance evidence.

  Treat the built-in AWS profile as an immutable ceiling for every SDK client
  with native endpoint provenance, independent of mutable adapter display names.
  Explicit profiles may narrow its operations, policy bits, and key limit but
  cannot raise the 1,024-byte physical-key budget or add unsupported claims.

  Enforce every requested signed-upload constraint at URL creation time.
  Content-type-constrained PUT URLs now sign the `content-type` header; bounded
  AWS uploads use exact POST MIME and byte-range conditions; unsupported profile
  constraints and lower-only S3 ranges fail before signing. Bounded POST uploads
  also reject physical keys ending in AWS's `${filename}` template so an exact
  authorized key cannot be widened into a prefix policy.

## 0.1.0-alpha.7

### Minor Changes

- 842ff34: Add a backend-neutral `StorageWorkspace` capability and optional AI SDK 7 tool
  adapter. Workspaces expose only canonical mount-relative paths, enforce
  permissions and resource limits, hide provider coordinates and cursors, and use
  atomic create/ETag mutation preconditions. S3 now advertises and implements the
  conditional mutation primitives used by writable workspaces.

  Harden local filesystem workspace reads and conditional mutations against
  symlink aliases. Moves retain their create-only destination whenever source
  deletion cannot be confirmed, avoiding data loss after provider or
  post-operation hook ambiguity.

  Fix cross-store sync so `destinationPrefix` is applied to uploaded keys as well
  as pruning, keeping every mutation inside the selected destination scope.

## 0.1.0-alpha.6

### Minor Changes

- 5bb646e: Remove the product-specific artifact protocol, encryption codec, and Nest composition entry
  points. `@nestm/storage` remains a generic storage library; applications should compose domain
  protocols over its clients and provider drivers in their own packages.

## 0.1.0-alpha.5

### Minor Changes

- 227df5b: Add byte-compatible encrypted artifact storage through the
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

## 0.1.0-alpha.4

### Minor Changes

- 79ad3af: Add runtime provider selection and a package-owned filesystem driver.

  `@nestm/storage/files-sdk/provider` builds a driver from a provider slug carried
  as data — `createProviderStorageDriver({ provider: 's3' | 'gcs' | 'azure' | 'r2'
| 'fs' | … })` — importing that provider's adapter, and only that one, on
  demand. A deployment now selects its store with an environment variable and
  installs a single native SDK instead of the application hard-coding a driver per
  backend. The same entry point exposes the provider catalog (`listStorageProviders`,
  `getStorageProvider`, `listStorageProviderEnvVars`,
  `listStorageProviderSecretEnvVars`, `isStorageProvider`) as pure data, so config
  validation and health checks can read a provider's env contract without loading
  an adapter. An unknown slug fails closed with `INVALID_ARGUMENT` before anything
  is imported.

  `@nestm/storage/files-sdk/fs` adds `createFsStorageDriver` for local filesystem
  storage, mirroring the S3 factory. Its adapter reaches only `node:fs`, so it adds
  no native SDK to an install.

  `@nestm/storage/files-sdk/s3` additionally exports `withS3Capabilities`, which
  applies S3's conditional-copy promotion and signed-policy declarations to an
  adapter built by `s3(...)`. The provider factory uses it so the `s3` slug keeps
  those capabilities without re-deriving `S3AdapterOptions` from flat config.
  `EnhancedS3Adapter` is now `S3StorageAdapter`; the type was not previously
  exported.

## 0.1.0-alpha.3

### Minor Changes

- b947634: Harden storage integration boundaries with cross-copy-safe `StorageError`
  detection, a package-owned S3 driver factory, conditional staged-object
  promotion, and a mandatory parsed key policy plus signed-transfer limits for
  the optional HTTP gateway.

### Patch Changes

- b947634: Map structurally branded `files-sdk` errors, including errors wrapped across
  duplicate package copies, so missing objects retain the `NOT_FOUND` storage
  error code.

## 0.1.0-alpha.2

### Minor Changes

- c4b54e7: Add a framework-neutral `@nestm/storage/core` entry point for the storage
  client, driver contract, errors, operation types, and upload controls. NestJS
  peers are now optional so non-Nest consumers can install and use the core API
  without pulling in the framework.

## 0.1.0-alpha.1

### Minor Changes

- 368aa2a: Add the initial NestJS 12 storage integration with named stores, streaming I/O,
  advanced cross-store operations, and an optional guarded HTTP gateway.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
after the initial experimental releases.

## [Unreleased]

## [0.1.0-alpha.0] - 2026-07-30

### Added

- NestJS 12 dynamic module with local-by-default root and feature registration.
- Default and named stores through `StorageService.use()` and `@InjectStorage()`.
- NestM-owned streaming, buffered, bulk, search, signing, resumable-upload, and
  error contracts backed by `files-sdk`.
- Cross-store streaming transfer and mirror/sync workflows.
- Optional guard-required Express/Fastify HTTP gateway.
- Node 22/24 CI and Changesets-based alpha publishing through npm OIDC.

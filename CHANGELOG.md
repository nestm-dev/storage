# @nestm/storage

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

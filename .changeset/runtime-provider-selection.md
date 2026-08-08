---
'@nestm/storage': minor
---

Add runtime provider selection and a package-owned filesystem driver.

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

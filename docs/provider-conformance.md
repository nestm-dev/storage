# Storage provider conformance

`@nestm/storage/testing` exports
`createStorageProviderConformanceCases()`, a runner-agnostic contract harness
for the conditional storage boundary. It verifies the exact declared
capability matrix, supported operations, fail-closed unsupported operations,
the complete physical-key byte budget, conflict normalization, and public
error sanitation.

The repository registers the harness with Vitest for four providers in
`test/provider-conformance.e2e-spec.ts`:

- filesystem, which always runs against a fresh temporary root;
- native AWS S3;
- Cloudflare R2;
- a custom S3-compatible or MinIO-style endpoint with an explicit candidate
  profile.

Run only these suites with:

```sh
pnpm exec vitest run --config ./vitest.config.e2e.ts \
  test/provider-conformance.e2e-spec.ts
```

## Live-suite safety and skips

Live object-store suites are opt-in. They are registered as explicitly skipped
Vitest suites, including the missing variable names in the suite title, unless
`STORAGE_CONFORMANCE_LIVE=true` and every required provider value is present.
Use dedicated disposable buckets and credentials, never a production bucket.
Grant only the operations exercised by the selected profile and configure a
short lifecycle for unfinished multipart uploads and leftover
`nestm-conformance/` objects.

The harness generates a unique prefix for every case and removes its objects.
AWS cleanup also removes object versions and delete markers. Version-specific
AWS read/copy cases are reported as skipped when the configured bucket does not
return version IDs; use a version-enabled bucket for complete coverage.

### AWS S3

```dotenv
STORAGE_CONFORMANCE_LIVE=true
STORAGE_CONFORMANCE_AWS_BUCKET=dedicated-conformance-bucket
STORAGE_CONFORMANCE_AWS_REGION=us-east-1
STORAGE_CONFORMANCE_AWS_ACCESS_KEY_ID=replace-with-test-access-key
STORAGE_CONFORMANCE_AWS_SECRET_ACCESS_KEY=replace-with-test-secret-key
# STORAGE_CONFORMANCE_AWS_SESSION_TOKEN=replace-with-temporary-token
```

The suite uses `AWS_S3_PROVIDER_PROFILE` and therefore exercises conditional
create, replace, delete, ETag/version reads, source- and
destination-conditioned promotion, atomic combined promotion, and conditional
multipart completion.

### Cloudflare R2

```dotenv
STORAGE_CONFORMANCE_LIVE=true
STORAGE_CONFORMANCE_R2_BUCKET=dedicated-conformance-bucket
STORAGE_CONFORMANCE_R2_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_CONFORMANCE_R2_ACCESS_KEY_ID=replace-with-test-access-key
STORAGE_CONFORMANCE_R2_SECRET_ACCESS_KEY=replace-with-test-secret-key
# STORAGE_CONFORMANCE_R2_SESSION_TOKEN=replace-with-temporary-token
```

The suite uses `CLOUDFLARE_R2_PROVIDER_PROFILE`. It verifies R2 independently
and asserts that unclaimed delete, destination-promotion, version, and
multipart-completion operations fail with `NOT_SUPPORTED` before mutation.

### Custom S3-compatible / MinIO-style endpoint

Custom endpoints have no inferred mutation support. Drivers created without an
explicit profile are forced read-only, including their ordinary upload, delete,
copy, move, and signed-upload surfaces. The live suite remains explicitly
skipped as unverified until both the endpoint configuration and a candidate
capability declaration are supplied:

```dotenv
STORAGE_CONFORMANCE_LIVE=true
STORAGE_CONFORMANCE_CUSTOM_BUCKET=dedicated-conformance-bucket
STORAGE_CONFORMANCE_CUSTOM_REGION=us-east-1
STORAGE_CONFORMANCE_CUSTOM_ENDPOINT=http://127.0.0.1:9000
STORAGE_CONFORMANCE_CUSTOM_FORCE_PATH_STYLE=true
STORAGE_CONFORMANCE_CUSTOM_ACCESS_KEY_ID=replace-with-test-access-key
STORAGE_CONFORMANCE_CUSTOM_SECRET_ACCESS_KEY=replace-with-test-secret-key
# STORAGE_CONFORMANCE_CUSTOM_SESSION_TOKEN=replace-with-temporary-token

STORAGE_CONFORMANCE_CUSTOM_MAX_KEY_BYTES=1024
STORAGE_CONFORMANCE_CUSTOM_CAPABILITIES=create,replace,read-etag
```

`STORAGE_CONFORMANCE_CUSTOM_CAPABILITIES` is a comma-separated list. Unknown
or duplicate tokens fail configuration instead of being ignored. Supported
tokens are:

- `create`
- `replace`
- `delete`
- `read-etag`
- `read-version`
- `copy-source-etag`
- `copy-source-version`
- `copy-destination-create`
- `copy-destination-replace`
- `atomic-promotion`
- `multipart-create`
- `multipart-replace`

`atomic-promotion` requires at least one `copy-source-*` token and one
`copy-destination-*` token. Destination-copy support may be declared on its
own. `multipart-create` requires `create`, and
`multipart-replace` requires `replace`. A passing suite verifies only the exact
declared profile. Promote that profile into application configuration
intentionally; do not treat generic S3 compatibility as proof of conditional
semantics.

## Embedding the harness

The harness does not import Vitest. Consumers provide a fixture factory and
register each returned case with their test runner. A case may return
`{ status: "skipped", reason }` for a provider prerequisite such as bucket
versioning; translate that result into the runner's native skip mechanism.

Fixtures can supply provider-aware cleanup and a version resolver:

```ts
import {
  createStorageProviderConformanceCases,
  type StorageProviderConformanceOptions,
} from '@nestm/storage/testing';

const options: StorageProviderConformanceOptions = {
  provider: 'my-provider',
  expected: verifiedCapabilities,
  createFixture: async () => ({
    client: await createDedicatedTestClient(),
    cleanup: deleteEveryTestObjectIdentity,
    resolveVersion: resolveCurrentProviderVersion,
  }),
};

for (const contract of createStorageProviderConformanceCases(options)) {
  test(contract.name, async (context) => {
    const result = await contract.run();
    if (result.status === 'skipped') context.skip(result.reason);
  });
}
```

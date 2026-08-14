# Storage provider conformance

`@nestm/storage/testing` exports
`createStorageProviderConformanceCases()`, a runner-agnostic contract harness
for the conditional storage boundary. It verifies the exact declared
capability matrix, supported operations, fail-closed unsupported operations,
the complete physical-key byte budget, conflict normalization, and public
error sanitation.

Every failure observed by the harness must be log-safe as a nested object, via
`util.inspect`, and via JSON serialization. Provider bodies, request/host IDs,
SDK metadata, credentials, and raw `cause` chains must not cross the storage
boundary. Adapters preserve normalized error codes plus aborted, timed-out, and
permanent flags while using stable public messages.

The repository registers the harness with Vitest for four providers in
`test/provider-conformance.e2e-spec.ts`:

- filesystem, which always runs against a fresh temporary root;
- native AWS S3;
- Cloudflare R2;
- a custom S3-compatible or MinIO-style endpoint with an explicit candidate
  profile.

## Canonical ETag contract

Provider fixtures must return ETags in the package's canonical bare form, not
as an HTTP field value. A canonical ETag is a case-sensitive opaque token of
1–1024 visible ASCII bytes. It excludes quotes, commas, backslashes,
whitespace, control characters, `DEL`, non-ASCII text, the `*` wildcard, and
case-insensitive `W/` weak-tag prefixes. The harness passes result ETags back to
conditional operations without altering them, so provider adapters must
normalize their output before it crosses the storage boundary.

An HTTP provider response may contain exactly one surrounding quote pair. The
adapter removes that pair only after validating the whole value as one strong
entity tag; it must not trim repeated quotes or accept an entity-tag list. When
an S3-compatible adapter sends a condition, it restores exactly one quote pair
for `If-Match` or the corresponding copy-source header. Bare values and HTTP
header values are separate representations; application and conformance code
must never quote or unquote ETags itself.

This restriction is intentionally narrower than the full HTTP `etagc` grammar.
It fails closed on legacy backslash handling and on values that could be
interpreted as a wildcard, weak validator, header injection, or a list matching
more than one object state. A provider that returns an unsafe ETag cannot claim
an exact ETag-conditioned capability until its adapter can normalize a verified
single strong value. Persisted quoted ETags from an older integration must be
discarded and refreshed from provider metadata before mutation tests run.

## List cursor replay contract

Provider list cursors are opaque and non-consuming. Reusing the same cursor
with the same prefix, delimiter, and page limit against unchanged provider
state must return an equivalent page and the same continuation state. The
conformance harness creates three objects, advances beyond a cursor-backed
page, then replays the original cursor and compares the full page metadata and
next cursor. A consuming or unstable provider cursor fails conformance; callers
must not advertise replayable higher-level cursors for that provider.

This is an idempotent-replay guarantee, not snapshot isolation. Results may
change when another actor mutates the provider namespace between list calls.

## Combined copy atomicity

A profile may claim `conditionalCopyDestination.atomicWithSource` only after
the harness passes every advertised source predicate (`etag` and/or `version`)
crossed with every advertised destination predicate (`create` and/or
`replace`). Each combination proves that a stale source with a valid
destination and a valid source with a stale destination leave the destination
unchanged. A controlled two-promotion race then pairs one stale source with one
valid source against the same destination condition: the stale attempt must
fail, the valid attempt must win, and the final bytes must be the valid source.
This detects adapters that serialize only one of the combined predicates.

The runner-agnostic harness cannot inject a mutation inside a remote provider's
private check/copy window, so this race does **not** by itself prove one internal
linearization point. A profile may set `atomicWithSource: true` only when the
provider API or an audited adapter implementation independently guarantees that
the combined predicates and copy execute as one atomic request. The harness
then verifies every observable predicate combination and fails profiles that
drop either side.

Profiles that advertise source and destination predicates but leave
`atomicWithSource` false run the same complete cross-product as negative cases:
every combined pair must fail before it can alter the destination.

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
multipart completion. AWS also declares provider-enforced content type and size
range constraints for signed POST uploads. An explicit profile applied to a
native AWS endpoint may narrow this built-in profile but cannot raise its
1,024-byte physical-key ceiling or add any operation/policy claim.

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
multipart-completion operations fail with `NOT_SUPPORTED` before mutation. R2
declares `{ contentType: true, sizeRange: false }` for signed uploads because
Cloudflare supports content-type-bound presigned PUT requests but explicitly
does not support POST form uploads. The storage gateway requires both claims
and therefore rejects R2 signed POST uploads before calling the driver.

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

The conformance test's custom profile omits `signedUploadPolicy`, which the
branded profile builder normalizes to `{ contentType: false, sizeRange: false }`.
Applications may declare either policy bit only after independently verifying
the endpoint's actual signed-upload implementation; the conditional-operation
token list does not attest signed POST policy behavior.

`atomic-promotion` requires at least one `copy-source-*` token and one
`copy-destination-*` token. Destination-copy support may be declared on its
own. `multipart-create` requires `create`, and
`multipart-replace` requires `replace`. A passing suite verifies only the exact
declared profile. Promote that profile into application configuration
intentionally; do not treat generic S3 compatibility as proof of conditional
semantics.

The public `withS3Capabilities()` helper mutates one raw S3 adapter and is
single-use. Build a fresh raw adapter for each verified profile. Reapplication
is rejected rather than merging capability fields, so declaration order cannot
leave operations from a broader prior profile enabled.

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

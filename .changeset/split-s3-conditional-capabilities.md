---
'@nestm/storage': minor
---

Split the aggregate S3 conditional-mutation and copy declarations into exact
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

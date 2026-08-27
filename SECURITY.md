# Security Policy

## Supported versions

Until the first stable release, security fixes target the newest published
prerelease. Pin and test the exact alpha version used with the matching NestJS
12 prerelease.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, or
pull request. Use GitHub's private vulnerability reporting flow:

<https://github.com/nestm-dev/storage/security/advisories/new>

Include the package and Nest versions, a minimal reproduction, expected and
observed behavior, likely impact, and any tested mitigation.

Reports about authorization bypasses in the optional gateway, unsafe signed URL
behavior, unbounded buffering, path/key confusion, credential leakage,
cross-store pruning, or dependency compromise are especially useful.

For a vulnerability originating in NestJS, `files-sdk`, or a provider SDK,
follow that project's security policy as well. You may still report it here
privately when this integration needs a mitigation.

## Gateway security boundary

Mounting the optional HTTP gateway requires both authentication guards and a
`StorageGatewayKeyPolicy`. The policy receives parsed paths and must derive the
provider key space from trusted request context. Do not treat a client prefix
or object key as a tenant identifier. `unsafeAllowUnscopedKeys` exists only to
migrate trusted single-tenant deployments and is unsafe on an exposed gateway.

Signed URL expiry, signed-upload byte size, and signed-upload MIME are bounded
by module configuration and cannot be increased by a request. Only `inline`
and `attachment` content dispositions are accepted. File type still must be
verified from magic bytes after upload; a signed MIME condition proves only
what header the uploader supplied. The gateway rejects signed-upload drivers
that do not advertise provider-enforced content-type and size-range policies.
It also rejects download adapters that cannot guarantee the requested expiry;
in particular, the S3 bridge does not treat `publicBaseUrl` links as expiring.

For staged uploads on S3, use `promote`/`promoteTo` with the ETag returned by
the validated `head` or with an immutable provider version. Ordinary `copy`
does not protect against a staging-key replay between validation and copy.
Conditional promotion keeps the staging source; delete it only after the
application's metadata transaction commits.

## Workspace security boundary

`StorageWorkspace` is a narrowing capability for storage operations. Construct
it from trusted application context, keep the underlying `StorageClient` and
mount prefix private, and pass only the workspace or its AI tool set to
untrusted agent code. A tenant id, run id, prefix, provider cursor, snapshot id,
or fork id supplied by a model is not a safe mount coordinate.

The workspace accepts only canonical mount-relative POSIX paths and rechecks
every key returned by a driver before unscoping it. Pagination cursors are bound
to the store, normalized physical prefix, stable mount identity, trusted
tenant/workspace scope, operation, complete effective limits, normalized query,
and expiry. Provider continuations and prefixes stay inside the encrypted or
server-side payload. Both layers are non-consuming: a durable opaque token
store must read rather than consume a record, and an embedded provider cursor
must remain replayable through a fresh compatible driver against the same
backend namespace while that provider cursor remains valid and available.
Provider cursors cannot depend on process-local state; an adapter for a
consuming or instance-bound backend token must materialize a stable continuation
before exposing paginated `StorageDriver.list` results.

Under unchanged provider-visible state, cursors are reusable while their
provider continuation remains valid and available. The authenticated expiry is
an authorization ceiling, not a guarantee of provider-token lifetime, snapshot
isolation, provider/network availability, or valid credentials. Provider
invalidation remains an operational failure, and concurrent mutations remain
subject to provider ordering, duplicate, and omission semantics.

Production pagination must configure either the built-in AES-256-GCM codec with
a dedicated shared 32-byte key ring or an authenticated shared durable token
store. Do not reuse an authentication, session, storage-provider, or encryption
key from another purpose. All replicas must use the same stable identities and
key ring, compatible driver configuration, and logical backend namespace. New
cursors use the active key id; retain prior keys for at least the maximum cursor
TTL during rotation. Dropping a key, changing a binding field, or restarting
with a different ephemeral key intentionally invalidates outstanding cursors.
Tokens and decoded payloads are bounded, and malformed, altered, expired,
cross-query, cross-operation, cross-workspace, and cross-store cursors fail
closed.

Permissions, byte limits, result limits, and conditional mutation preconditions
are enforced inside the capability; tool omission and user approval are
additional workflow controls, not the authorization boundary.

Conditional mutations can still have an ambiguous outcome when a remote
provider commits and then loses or violates its response, or when a configured
post-operation plugin fails after the driver has committed. Known post-commit
failures report `StorageError.applied === true`; a conditional upload also
carries `appliedEtag` when its committed generation is known. This is positive
evidence, not a complete remote-commit oracle: a timeout, connection loss, or
exhausted retry can lose a provider success response and still leave
`applied === false`. Do not reissue an ambiguous predicate blindly. Reconcile
the logical destination first, using an exact ETag read when `appliedEtag` is
available and inspecting the relevant source/destination state for copy or
delete. Create-only and ETag preconditions prevent a blind retry from silently
overwriting a different object, but they cannot make a multi-object move
transactionally atomic.

This guarantee covers calls made through `StorageWorkspace`. It does not
confine arbitrary `node:fs`, shell, subprocess, or native-code access in the
same process. A coding harness with built-in shell or filesystem tools must run
inside an OS sandbox (container, VM, or equivalent) that exposes only a
materialized workspace. Setting `cwd` to a workspace directory is not
isolation.

For local filesystem storage, use a dedicated service-owned root and route all
in-process mutations through the package-decorated adapter; its ordinary and
conditional mutation paths share one lock domain. A separate process,
unwrapped adapter, or direct filesystem writer can bypass that coordination and
must not mutate the tree concurrently. High-level Node filesystem checks reject
symlinks and hard-linked object files in existing workspace read and mutation
paths, including metadata sidecars, but cannot provide a race-proof boundary
against an actor that can replace path components between validation and use.
For that threat model, mount only the workspace into a separate
UID/container/VM and synchronize approved results back through storage. The
local adapter also commits the body and metadata sidecar as two files; a process
crash between their atomic renames can require reconciliation.

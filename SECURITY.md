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

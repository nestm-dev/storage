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

---
'@nestm/storage': minor
---

Split the aggregate S3 conditional-mutation and copy declarations into exact
create, replace, delete, read, source-copy, destination-copy, atomic-promotion,
and multipart-completion capabilities. Add independent AWS S3, Cloudflare R2,
and fail-closed custom-endpoint profiles that force unverified drivers
read-only; enforce complete physical-key byte budgets; normalize conditional
provider errors without retaining raw provider payloads; and publish a reusable
provider conformance contract with gated filesystem, AWS, R2, and custom suites.

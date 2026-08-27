---
'@nestm/storage': minor
---

Delegate conditional create, replace, exact ETag read, delete, and paired copy
to the Files SDK 2.3 operation pipeline so plugins, hooks, retries, and receipts
apply without bypassing native provider preconditions. Keep the direct NestM
fallback only for version predicates, conditional multipart/resumable
completion, and one-sided conditional copies, and fail those shapes closed when
caller Files policy is configured.

Expose paired-copy dependency flags in provider capabilities and preserve
`StorageError.applied` plus `appliedEtag` so callers can reconcile a conditional
mutation that committed before a post-operation failure. Preserve the same
bounded reconciliation signal through workspace, AI-tool, and gateway error
boundaries.

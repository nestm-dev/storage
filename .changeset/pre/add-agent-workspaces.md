---
'@nestm/storage': minor
---

Add a backend-neutral `StorageWorkspace` capability and optional AI SDK 7 tool
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

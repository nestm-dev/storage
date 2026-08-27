---
'@nestm/storage': patch
---

Map structurally branded `files-sdk` errors, including errors wrapped across
duplicate package copies, so missing objects retain the `NOT_FOUND` storage
error code.

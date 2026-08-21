---
'@nestm/storage': minor
---

Add explicit last-write-wins workspace write, copy, and unconditional-delete
operations that traverse the ordinary Files SDK plugin, hook, and receipt
pipeline while retaining the existing native conditional create, replace,
copy, move, and delete variants. Unconditional delete requires both `write` and
`delete`; move remains conditional-only because a non-atomic
download/upload/delete sequence could delete a newer source generation. Add a
separate `write` permission and an AI tool factory mutation-mode switch whose
default remains conditional.

Add bounded binary workspace reads through `readBytes`, alongside the existing
UTF-8 `readText` API. `readBytes` is a required `StorageWorkspace` member, so
custom interface implementations and typed test doubles must add it when
upgrading; workspaces returned by `mountStorageWorkspace` need no changes.

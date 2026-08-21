---
'@nestm/storage': patch
---

Fail conditional storage operations closed when caller-configured Files SDK
plugins, hooks, or receipts would be bypassed by native adapter extensions.
Ordinary operations continue through Files SDK while incompatible conditional
capabilities are hidden until Files SDK exposes one shared interception boundary.

---
'@nestm/storage': minor
---

Add a framework-neutral `@nestm/storage/core` entry point for the storage
client, driver contract, errors, operation types, and upload controls. NestJS
peers are now optional so non-Nest consumers can install and use the core API
without pulling in the framework.

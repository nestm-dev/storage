---
'@nestm/storage': minor
---

Remove the product-specific artifact protocol, encryption codec, and Nest composition entry
points. `@nestm/storage` remains a generic storage library; applications should compose domain
protocols over its clients and provider drivers in their own packages.

---
'@nestm/storage': patch
---

Add optional `/crypto` encrypted staged content coordination over FileCipherEngine, with host-owned addressing, AAD, persistence and reference-protected cleanup. Preserve detached metadata preparation, exact physical acknowledgements, immutable ETag reads, authenticated ranges and cancellation. Trusted staged writers can reserve an identity before metadata preparation with `writeReserved`.

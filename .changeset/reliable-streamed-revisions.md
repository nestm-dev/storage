---
'@nestm/storage': patch
---

Add protected revision-pinned host streams for file catalogs and checkpoints. Apply saved-file edits directly from one stream into an atomic candidate, avoiding intermediate checkouts and repeated small range reads.

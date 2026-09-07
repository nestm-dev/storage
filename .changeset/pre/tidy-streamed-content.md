---
'@nestm/storage': patch
---

Use conditional multipart completion for staged content streams when the provider supports create-only completion. This enables encrypted file writes on AWS S3 without buffering the entire content or weakening immutable creation and exact ETag reads.

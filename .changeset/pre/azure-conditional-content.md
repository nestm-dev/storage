---
'@nestm/storage': minor
---

Add native Azure Blob create-only uploads, ETag-conditional replacement and deletion,
and exact ETag reads with ranges through the Files SDK conditional pipeline. Expose
`createAzureStorageDriver` and decorate the named Azure provider with the same
primitives, allowing staged encrypted content to run on Azure without application
provider code.

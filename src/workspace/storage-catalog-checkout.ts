import { StorageError } from '../storage.error.js';
import type {
  StorageFileCatalogCapability,
  StorageCatalogCommand,
} from './storage-file-catalog.types.js';
import type { StorageFileWorkflowCapability } from './storage-file-workflow.types.js';

/** Bounded, exact-revision catalog read into a sealed text checkpoint. */
export async function checkoutStorageCatalogText<Receipt>(
  catalog: StorageFileCatalogCapability<Receipt>,
  workflow: StorageFileWorkflowCapability<Receipt>,
  input: StorageCatalogCommand & { readonly expectedEtag: string },
) {
  const file = await catalog.stat(input);
  if (file.etag !== input.expectedEtag)
    throw new StorageError('The catalog revision changed.', {
      code: 'CONFLICT',
    });
  if (file.size > workflow.limits.maxTextBytes)
    throw new StorageError('Checkout exceeds the buffered text limit.', {
      code: 'LIMIT_EXCEEDED',
    });
  const pieces: string[] = [];
  let offset = 0;
  do {
    const page = await catalog.readWindow({ ...input, offset });
    if (
      page.etag !== input.expectedEtag ||
      page.totalBytes !== file.size ||
      page.offset !== offset
    )
      throw new StorageError('The catalog revision changed.', {
        code: 'CONFLICT',
      });
    if (page.content === null)
      throw new StorageError('Checkout requires a text file.', {
        code: 'INVALID_ARGUMENT',
      });
    const next = offset + new TextEncoder().encode(page.content).byteLength;
    if (
      next > file.size ||
      (page.nextOffset === null
        ? next !== file.size
        : page.nextOffset !== next || next <= offset)
    )
      throw new StorageError('Invalid catalog text window.', {
        code: 'PROVIDER',
      });
    pieces.push(page.content);
    offset = next;
    if (page.nextOffset === null) break;
  } while (offset < file.size);
  return workflow.stageText({
    ...input,
    content: pieces.join(''),
    idempotencyKey: input.commandId,
  });
}

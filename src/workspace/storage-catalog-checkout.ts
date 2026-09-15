import { StorageError } from '../storage.error.js';
import type {
  StorageFileCatalogCapability,
  StorageCatalogCommand,
} from './storage-file-catalog.types.js';
import type { StorageFileWorkflowCapability } from './storage-file-workflow.types.js';

/** Stream exact catalog windows into a sealed checkpoint without buffering the file. */
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
  return workflow.stageStream({
    path: input.path,
    expectedEtag: input.expectedEtag,
    text: true,
    signal: input.signal,
    idempotencyKey: input.commandId,
    contentIdentity: JSON.stringify([file.fileId, file.etag, file.size]),
    body: () => {
      let offset = 0;
      return new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
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
              const next =
                offset + new TextEncoder().encode(page.content).byteLength;
              if (
                next > file.size ||
                (page.nextOffset === null
                  ? next !== file.size
                  : page.nextOffset !== next || next <= offset)
              )
                throw new StorageError('Invalid catalog text window.', {
                  code: 'PROVIDER',
                });
              controller.enqueue(new TextEncoder().encode(page.content));
              offset = next;
              if (page.nextOffset === null) {
                const current = await catalog.stat(input);
                if (
                  current.etag !== input.expectedEtag ||
                  current.size !== file.size
                )
                  throw new StorageError('The catalog revision changed.', {
                    code: 'CONFLICT',
                  });
                controller.close();
              }
            } catch (error) {
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      );
    },
  });
}

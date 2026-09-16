import type {
  StorageFileCatalogCapability,
  StorageCatalogCommand,
} from './storage-file-catalog.types.js';
import type { StorageFileWorkflowCapability } from './storage-file-workflow.types.js';

/** Copy an exact host stream into a sealed checkpoint without small-window rereads. */
export async function checkoutStorageCatalogText<Receipt>(
  catalog: StorageFileCatalogCapability<Receipt>,
  workflow: StorageFileWorkflowCapability<Receipt>,
  input: StorageCatalogCommand & { readonly expectedEtag: string },
) {
  return workflow.stageStream({
    path: input.path,
    expectedEtag: input.expectedEtag,
    text: true,
    signal: input.signal,
    idempotencyKey: input.commandId,
    contentIdentity: JSON.stringify([input.path, input.expectedEtag]),
    body: async () => (await catalog.readStream(input)).body,
  });
}

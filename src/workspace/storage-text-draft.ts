import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from '../storage.error.js';
import { storageBytesStream } from '../core/storage-streams.js';
import type { StorageStagedContent } from '../core/storage-staged-content.js';
import type {
  StorageFileDraftRecord,
  StorageFilePartRecord,
  StorageFileWorkflowLimits,
  StorageFileWorkflowTransaction,
} from './storage-file-workflow.types.js';

/** Stage bytes outside the host transaction, then atomically publish all part references. */
export async function stageStorageTextDraft<Scope, Receipt>(options: {
  readonly scope: Scope;
  readonly signal: AbortSignal;
  readonly limits: Readonly<StorageFileWorkflowLimits>;
  readonly content: StorageStagedContent<Scope>;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly requireMutation: (expectedEtag: string | null) => void;
  readonly transaction: <T>(
    work: (tx: StorageFileWorkflowTransaction<Receipt>) => Promise<T>,
  ) => Promise<T>;
  readonly load: () => Promise<{
    content: string;
    path: string;
    expectedEtag: string | null;
    source: StorageFileDraftRecord<Receipt> | null;
  }>;
}): Promise<StorageFileDraftRecord<Receipt>> {
  const { transaction, signal, limits } = options;
  const replay = async (tx: StorageFileWorkflowTransaction<Receipt>) => {
    const prior = await tx.findDraftByKey(options.idempotencyKey);
    if (prior !== null) {
      options.requireMutation(prior.expectedEtag);
      if (prior.requestFingerprint !== options.fingerprint)
        throw new StorageError(
          'Draft key was already used for different input.',
          { code: 'CONFLICT' },
        );
    }
    return prior;
  };
  const prior = await transaction(replay);
  if (prior !== null) return prior;
  const loaded = await options.load();
  options.requireMutation(loaded.expectedEtag);
  if (/[\uD800-\uDFFF]/u.test(loaded.content))
    throw new StorageError('Text must be well-formed UTF-8.', {
      code: 'INVALID_ARGUMENT',
    });
  const bytes = new TextEncoder().encode(loaded.content);
  if (bytes.byteLength > limits.maxTextBytes)
    throw new StorageError('Text checkpoint exceeds the buffered text limit.', {
      code: 'LIMIT_EXCEEDED',
    });
  if (limits.maxChunkBytes < 4)
    throw new StorageError(
      'Text checkpoints require a chunk limit of at least four bytes.',
      { code: 'LIMIT_EXCEEDED' },
    );
  const parts: StorageFilePartRecord[] = [];
  for (let offset = 0; offset < bytes.length;) {
    signal.throwIfAborted();
    let end = Math.min(bytes.length, offset + limits.maxChunkBytes);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    const chunk = bytes.subarray(offset, end);
    const body = await options.content.write(
      options.scope,
      storageBytesStream(chunk),
      { maxBytes: limits.maxChunkBytes, signal },
    );
    if (
      body.size !== chunk.length ||
      body.sha256 !== createHash('sha256').update(chunk).digest('hex')
    )
      throw new StorageError('Invalid text chunk receipt.', {
        code: 'PROVIDER',
      });
    parts.push({ offset, size: body.size, sha256: body.sha256, body });
    offset = end;
  }
  return transaction(async (tx) => {
    const concurrent = await replay(tx);
    if (concurrent !== null) return concurrent;
    if (loaded.source !== null) {
      const current = await tx.getDraft(loaded.source.id);
      if (
        current === null ||
        current.size !== loaded.source.size ||
        !['open', 'sealed'].includes(current.status)
      )
        throw new StorageError(
          'The source draft changed while editing. Read its latest size.',
          { code: 'CONFLICT' },
        );
      await tx.saveDraft({ ...current, status: 'sealed' });
    }
    const draft: StorageFileDraftRecord<Receipt> = {
      id: randomUUID(),
      path: loaded.path,
      expectedEtag: loaded.expectedEtag,
      sourceDraftId: loaded.source?.id ?? null,
      text: true,
      status: 'sealed',
      size: bytes.length,
      result: null,
      createdAt: new Date().toISOString(),
      idempotencyKey: options.idempotencyKey,
      requestFingerprint: options.fingerprint,
      body: null,
    };
    await tx.saveDraft(draft);
    for (const part of parts) await tx.putPart(draft.id, part);
    return draft;
  });
}

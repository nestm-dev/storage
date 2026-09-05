import { StorageError } from '../storage.error.js';
import type { StorageByteRange } from '../storage.types.js';
import { trimStorageUtf8Chunk } from '../bytes/index.js';

export function storageBytesStream(
  bytes: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Explicitly buffers no more than maxBytes and cancels the source on failure/abort. */
export async function collectStorageBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  storageInteger(maxBytes, 'maxBytes');
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (!Number.isSafeInteger(size) || size > maxBytes)
        throw new StorageError('The stream exceeds its byte budget.', {
          code: 'LIMIT_EXCEEDED',
        });
      chunks.push(next.value.slice());
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface StorageTextWindow {
  readonly content: string | null;
  readonly offset: number;
  readonly nextOffset: number | null;
}
export interface StorageTextWindowOptions {
  readonly size: number;
  readonly offset?: number | undefined;
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
}
export type StorageRangeReader = (
  range: Required<StorageByteRange>,
  signal?: AbortSignal,
) => Promise<ReadableStream<Uint8Array>>;

/** Byte offsets; inclusive provider ranges. Never trims malformed UTF-8 at EOF. */
export async function readStorageTextWindow(
  read: StorageRangeReader,
  options: StorageTextWindowOptions,
): Promise<StorageTextWindow> {
  const { size, maxBytes, signal } = options;
  const offset = options.offset ?? 0;
  storageInteger(size, 'size');
  storageInteger(offset, 'offset');
  storageInteger(maxBytes, 'maxBytes', 4);
  if (offset > size)
    throw new StorageError('Offset exceeds the body size.', {
      code: 'INVALID_ARGUMENT',
    });
  signal?.throwIfAborted();
  if (offset === size) return { content: '', offset, nextOffset: null };
  const length = Math.min(maxBytes, size - offset);
  const bytes = await collectStorageBytes(
    await read({ start: offset, end: offset + length - 1 }, signal),
    length,
    signal,
  );
  if (bytes.byteLength !== length)
    throw new StorageError('The range response is incomplete.', {
      code: 'PROVIDER',
    });
  try {
    const complete = trimStorageUtf8Chunk(bytes, {
      final: offset + length === size,
    });
    const end = complete.byteLength;
    const content = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(complete);
    return {
      content,
      offset,
      nextOffset: offset + end < size ? offset + end : null,
    };
  } catch {
    throw new StorageError(
      'The window is not valid UTF-8 or its offset splits a character.',
      { code: 'INVALID_ARGUMENT' },
    );
  }
}

/** @internal */
export function storageInteger(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new StorageError(`${name} must be a safe integer >= ${minimum}.`, {
      code: 'INVALID_ARGUMENT',
    });
}

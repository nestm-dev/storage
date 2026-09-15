import { trimStorageUtf8Chunk } from '../bytes/index.js';
import { StorageError } from '../storage.error.js';

/** Bounded byte rechunking; each text chunk ends at a complete Unicode scalar. */
export async function* chunkStorageDraftStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  text: boolean,
  signal: AbortSignal,
) {
  if (maxBytes < (text ? 4 : 1)) {
    await source.cancel().catch(() => {});
    throw new StorageError('Chunk limit is too small.', {
      code: 'LIMIT_EXCEEDED',
    });
  }
  let buffer = new Uint8Array(maxBytes);
  let filled = 0;
  const reader = source.getReader();
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      for (let at = 0; at < next.value.length;) {
        const count = Math.min(maxBytes - filled, next.value.length - at);
        buffer.set(next.value.subarray(at, at + count), filled);
        filled += count;
        at += count;
        if (filled === maxBytes) {
          const complete = text
            ? trimStorageUtf8Chunk(buffer, { final: false })
            : buffer;
          if (text) new TextDecoder('utf-8', { fatal: true }).decode(complete);
          yield complete;
          const rest = buffer.subarray(complete.length);
          buffer = new Uint8Array(maxBytes);
          buffer.set(rest);
          filled = rest.length;
        }
      }
    }
    if (filled) {
      const final = buffer.subarray(0, filled);
      if (text) new TextDecoder('utf-8', { fatal: true }).decode(final);
      yield final;
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

import {
  createStoredFile,
  FilesError,
  type AdapterConditionalOperations,
  type AdapterUploadOptions,
  type Body,
} from 'files-sdk';
import { memory, type MemoryAdapter, type MemoryEntry } from 'files-sdk/memory';
import { createHash } from 'node:crypto';

const decorated = new WeakSet<MemoryAdapter>();

/**
 * Reuses files-sdk buffering/metadata; comparisons and Map replacement share a
 * synchronous linearization point AFTER body consumption. raw stays host-only.
 */
export function withMemoryConditionalOperations(
  adapter: MemoryAdapter,
): MemoryAdapter {
  if (decorated.has(adapter)) return adapter;
  decorated.add(adapter);
  // Upstream memory uses a quoted 32-bit content checksum. Give every publication
  // (ordinary, copy, resumable or conditional) a canonical SHA-256 identity at
  // the Map's synchronous set boundary; uploads return this same entry object.
  const set = adapter.raw.set.bind(adapter.raw);
  Object.defineProperty(adapter.raw, 'set', {
    value: (key: string, entry: MemoryEntry) => {
      entry.etag = createHash('sha256').update(entry.bytes).digest('hex');
      return set(key, entry);
    },
  });
  for (const [key, entry] of adapter.raw) adapter.raw.set(key, entry);
  const upload = async (
    key: string,
    body: Body,
    expectedEtag: string | null,
    options?: AdapterUploadOptions,
  ) => {
    options?.signal?.throwIfAborted();
    // An isolated upstream store performs its usual body conversion and hashing.
    const staged = memory();
    const result = await staged.upload(key, body, options);
    options?.signal?.throwIfAborted();
    const current = adapter.raw.get(key);
    if (
      expectedEtag === null
        ? current !== undefined
        : current?.etag !== expectedEtag
    )
      throw new FilesError(
        'Conflict',
        'Memory object condition did not match.',
      );
    // No await/callback between the comparison and publication, including when
    // ordinary upstream writes race this conditional operation.
    adapter.raw.set(key, staged.raw.get(key)!);
    return { ...result, etag: staged.raw.get(key)!.etag };
  };
  const conditional: AdapterConditionalOperations = {
    create: (key, body, options) => upload(key, body, null, options),
    replace: (key, body, etag, options) => upload(key, body, etag, options),
    exactRead: async (key, etag, options) => {
      options?.signal?.throwIfAborted();
      const entry = adapter.raw.get(key);
      if (entry === undefined || entry.etag !== etag)
        throw new FilesError(
          'Conflict',
          'Memory object condition did not match.',
        );
      const range = options?.range;
      const bytes = entry.bytes.slice(
        range?.start ?? 0,
        range?.end === undefined ? undefined : range.end + 1,
      );
      return createStoredFile(
        {
          key,
          etag: entry.etag,
          size: bytes.byteLength,
          type: entry.contentType,
          lastModified: entry.lastModified,
          ...(entry.metadata === undefined
            ? {}
            : { metadata: { ...entry.metadata } }),
        },
        { kind: 'buffer', data: bytes },
      );
    },
    delete: async (key, etag, options) => {
      options?.signal?.throwIfAborted();
      const entry = adapter.raw.get(key);
      if (entry === undefined || entry.etag !== etag)
        throw new FilesError(
          'Conflict',
          'Memory object condition did not match.',
        );
      adapter.raw.delete(key);
    },
  };
  return Object.assign(adapter, { conditional: Object.freeze(conditional) });
}

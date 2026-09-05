/** Browser-safe bounded byte helpers. No Node, framework, provider or AI imports. */
export async function sha256StorageBytes(
  bytes: Uint8Array,
  options: {
    readonly maxBytes: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<string> {
  budget(options.maxBytes);
  options.signal?.throwIfAborted();
  if (bytes.byteLength > options.maxBytes)
    throw new RangeError('Chunk exceeds the byte budget.');
  const hash = await crypto.subtle.digest('SHA-256', bytes.slice());
  options.signal?.throwIfAborted();
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Defers only a valid incomplete suffix (at most 3 bytes), never malformed data. */
export function trimStorageUtf8Chunk(
  bytes: Uint8Array,
  options: { readonly final: boolean },
): Uint8Array {
  let end = bytes.byteLength;
  if (!options.final && end > 0) {
    let start = end - 1;
    while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
    if (start >= 0) {
      const lead = bytes[start]!;
      const width =
        lead >= 0xc2 && lead <= 0xdf
          ? 2
          : lead >= 0xe0 && lead <= 0xef
            ? 3
            : lead >= 0xf0 && lead <= 0xf4
              ? 4
              : 1;
      if (end - start < width) {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          bytes,
          { stream: true },
        );
        end = start;
      }
    }
  }
  const result = bytes.subarray(0, end);
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result);
  return result;
}

export function encodeStorageBase64(
  bytes: Uint8Array,
  options: { readonly maxBytes: number },
): string {
  budget(options.maxBytes);
  if (bytes.byteLength > options.maxBytes)
    throw new RangeError('Chunk exceeds the byte budget.');
  let text = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 8192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
}

export interface StorageChunkIntegrityReceipt {
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
}
/** Verify receipt bounds, ordering and actual local bytes before skipping a chunk. */
export async function verifyStorageChunkReceipt(
  blob: Blob,
  receipt: StorageChunkIntegrityReceipt,
  options: {
    readonly offset: number;
    readonly maxBytes: number;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<number> {
  budget(options.maxBytes);
  options.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(options.offset) ||
    options.offset < 0 ||
    receipt.offset !== options.offset ||
    !Number.isSafeInteger(receipt.size) ||
    receipt.size < 1 ||
    receipt.size > options.maxBytes ||
    !Number.isSafeInteger(receipt.offset + receipt.size) ||
    receipt.offset + receipt.size > blob.size ||
    !/^[0-9a-f]{64}$/u.test(receipt.sha256)
  )
    throw new TypeError('Invalid or out-of-order chunk receipt.');
  const bytes = new Uint8Array(
    await blob
      .slice(receipt.offset, receipt.offset + receipt.size)
      .arrayBuffer(),
  );
  if ((await sha256StorageBytes(bytes, options)) !== receipt.sha256)
    throw new Error('The selected bytes differ from the accepted chunk.');
  return receipt.offset + receipt.size;
}

/** Bounded UTF-8 validation; filename/MIME classification remains host policy. */
export async function isStorageUtf8Blob(
  blob: Blob,
  options: {
    readonly chunkBytes: number;
    readonly rejectNul?: boolean;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<boolean> {
  budget(options.chunkBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  try {
    options.signal?.throwIfAborted();
    for (let offset = 0; offset < blob.size; offset += options.chunkBytes) {
      options.signal?.throwIfAborted();
      const bytes = await blob
        .slice(offset, offset + options.chunkBytes)
        .arrayBuffer();
      options.signal?.throwIfAborted();
      const text = decoder.decode(bytes, { stream: true });
      if (options.rejectNul && text.includes('\0')) return false;
    }
    decoder.decode();
    return true;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return false;
  }
}
function budget(value: number) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Byte budget must be a positive safe integer.');
}

import {
  encodeStorageBase64,
  isStorageUtf8Blob,
  sha256StorageBytes,
  trimStorageUtf8Chunk,
  verifyStorageChunkReceipt,
} from './index.js';

it('verifies actual resumable chunk bytes, ordering, limits and changed-content rejection', async () => {
  const bytes = new TextEncoder().encode('a😀b');
  const blob = new Blob([bytes]);
  const sha256 = await sha256StorageBytes(bytes, { maxBytes: 10 });
  const receipt = { offset: 0, size: bytes.length, sha256 };
  expect(
    await verifyStorageChunkReceipt(blob, receipt, { offset: 0, maxBytes: 10 }),
  ).toBe(bytes.length);
  await expect(
    verifyStorageChunkReceipt(new Blob(['other!']), receipt, {
      offset: 0,
      maxBytes: 10,
    }),
  ).rejects.toThrow(/differ/u);
  await expect(
    verifyStorageChunkReceipt(blob, receipt, { offset: 1, maxBytes: 10 }),
  ).rejects.toThrow(/out-of-order/u);
  await expect(sha256StorageBytes(bytes, { maxBytes: 1 })).rejects.toThrow(
    /budget/u,
  );
  expect(encodeStorageBase64(bytes, { maxBytes: 10 })).toBe(
    Buffer.from(bytes).toString('base64'),
  );
});
it('shares strict UTF-8 boundary behavior with server windows and preserves abort', async () => {
  const bytes = new TextEncoder().encode('a😀b');
  expect(
    new TextDecoder().decode(
      trimStorageUtf8Chunk(bytes.slice(0, 4), { final: false }),
    ),
  ).toBe('a');
  expect(() =>
    trimStorageUtf8Chunk(bytes.slice(0, 4), { final: true }),
  ).toThrow();
  expect(await isStorageUtf8Blob(new Blob([bytes]), { chunkBytes: 2 })).toBe(
    true,
  );
  expect(
    await isStorageUtf8Blob(new Blob([new Uint8Array([0xff])]), {
      chunkBytes: 2,
    }),
  ).toBe(false);
  expect(
    await isStorageUtf8Blob(new Blob(['a\0']), {
      chunkBytes: 2,
      rejectNul: true,
    }),
  ).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(
    isStorageUtf8Blob(new Blob([]), {
      chunkBytes: 2,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

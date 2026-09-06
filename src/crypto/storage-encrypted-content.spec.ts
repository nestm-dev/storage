import { createSecretKey, randomUUID } from 'node:crypto';
import { AesKeyRingProvider } from '@nestm/crypto/core';
import { FileCipherEngine } from '@nestm/crypto/files';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageClient } from '../storage.client.js';
import { StorageError } from '../storage.error.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import {
  collectStorageBytes,
  storageBytesStream,
} from '../core/storage-streams.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';
import {
  StorageEncryptedContentStore,
  type StorageEncryptedContentRecord,
  type StorageEncryptedContentProtection,
} from './index.js';

const engines: FileCipherEngine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
});
function fixture() {
  const cipher = new FileCipherEngine({
    defaultProvider: 'archive',
    maxPlaintextBytes: 10_000_000n,
    providers: [
      {
        name: 'archive',
        provider: new AesKeyRingProvider({
          activeKeyId: 'one',
          keys: { one: createSecretKey(Buffer.alloc(32, 53)) },
        }),
      },
    ],
  });
  engines.push(cipher);
  const client = new StorageClient('archive', createMemoryStorageDriver());
  const key = (scope: string, id: string) => `${scope}/${id}`;
  const physical = new StorageStagedContentStore({ client, key });
  const prepared = new Map<string, StorageEncryptedContentProtection>();
  const records = new Map<string, StorageEncryptedContentRecord>();
  const references = new Set<string>();
  const metadata = {
    prepare: vi.fn(
      async (
        scope: string,
        id: string,
        protection: StorageEncryptedContentProtection,
      ) => {
        if (prepared.has(key(scope, id))) throw new Error('Already reserved');
        prepared.set(key(scope, id), structuredClone(protection));
      },
    ),
    complete: vi.fn(
      async (scope: string, record: StorageEncryptedContentRecord) => {
        records.set(key(scope, record.id), structuredClone(record));
      },
    ),
    require: async (scope: string, id: string) => {
      const record = records.get(key(scope, id));
      if (record === undefined)
        throw new StorageError('Missing record', { code: 'NOT_FOUND' });
      return record;
    },
    discard: vi.fn(
      async (
        scope: string,
        id: string,
        receipt?: StorageEncryptedContentRecord['ciphertextBody'],
      ) => {
        if (references.has(key(scope, id))) return;
        if (receipt !== undefined) {
          await physical.remove(scope, receipt);
          records.delete(key(scope, id));
          prepared.delete(key(scope, id));
        }
      },
    ),
  };
  const options = {
    client,
    cipher,
    key,
    aad: (scope: string, id: string) =>
      new TextEncoder().encode(JSON.stringify(['archive-v1', scope, id])),
    allowedProviders: ['archive'],
    metadata,
  };
  const store = new StorageEncryptedContentStore(options);
  return {
    client,
    cipher,
    key,
    records,
    prepared,
    references,
    metadata,
    options,
    store,
  };
}
const bytes = (text: string) =>
  storageBytesStream(new TextEncoder().encode(text));

describe('StorageEncryptedContentStore', () => {
  it('preserves caller-reserved staged identities and rejects reuse without deleting existing bytes', async () => {
    const f = fixture();
    const staged = new StorageStagedContentStore({
      client: f.client,
      key: f.key,
    });
    const id = randomUUID();
    const receipt = await staged.writeReserved('library', id, bytes('first'));
    expect(receipt.payloadId).toBe(id);
    await expect(
      staged.writeReserved('library', id, bytes('second')),
    ).rejects.toThrow();
    expect(
      new TextDecoder().decode(
        await collectStorageBytes(await staged.read('library', receipt), 20),
      ),
    ).toBe('first');
  });

  it('persists detached metadata before upload and reopens full/range reads using the same identity', async () => {
    const f = fixture();
    const upload = f.client.uploadConditional.bind(f.client);
    vi.spyOn(f.client, 'uploadConditional').mockImplementation(
      async (key, body, options) => {
        expect(f.prepared.has(key)).toBe(true);
        return upload(key, body, options);
      },
    );
    const plain = new Uint8Array(3 * 1_048_576 + 20).map((_, i) => i % 251);
    const receipt = await f.store.write('library', storageBytesStream(plain));
    const record = await f.metadata.require('library', receipt.payloadId);
    expect(record.ciphertextBody.payloadId).toBe(receipt.payloadId);
    expect(record.ciphertextBody.size).toBeGreaterThan(receipt.size);
    const reopened = new StorageEncryptedContentStore(f.options);
    expect(
      await collectStorageBytes(
        await reopened.read('library', receipt),
        plain.length,
      ),
    ).toEqual(plain);
    const read = vi.spyOn(f.client, 'downloadConditional');
    const start = 1_048_576 - 3;
    expect(
      await collectStorageBytes(
        await reopened.read('library', receipt, {
          range: { start, end: start + 11 },
        }),
        12,
      ),
    ).toEqual(plain.slice(start, start + 12));
    for (const [, options] of read.mock.calls)
      expect(options).toMatchObject({
        condition: { etag: receipt.etag },
        range: expect.any(Object),
      });
    await expect(
      reopened.read('another-library', receipt),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 30_000);

  it('rejects replaced receipts, relocated metadata, and tampered final authentication frames', async () => {
    const f = fixture();
    const receipt = await f.store.write('library', bytes('secret'));
    const record = await f.metadata.require('library', receipt.payloadId);
    await expect(
      f.store.read('library', { ...receipt, sha256: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = randomUUID();
    f.records.set(f.key('library', other), { ...record, id: other });
    await expect(f.store.readById('library', other)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const raw = await f.client.downloadBytes(
      f.key('library', receipt.payloadId),
    );
    raw[raw.length - 1]! ^= 1;
    const replaced = await f.client.uploadConditional(
      f.key('library', receipt.payloadId),
      raw,
      { condition: { type: 'replace', etag: receipt.etag } },
    );
    f.records.set(f.key('library', record.id), {
      ...record,
      ciphertextBody: { ...record.ciphertextBody, etag: replaced.etag! },
    });
    await expect(
      f.store.readById('library', record.id, { range: { start: 0, end: 1 } }),
    ).rejects.toThrow();
    await expect(
      collectStorageBytes(await f.store.readById('library', record.id), 6),
    ).rejects.toThrow();
  });

  it('cancels unread plaintext without touching metadata owned by another writer when preparation fails', async () => {
    const f = fixture();
    const cancel = vi.fn();
    f.metadata.prepare.mockRejectedValue(new Error('reservation failed'));
    await expect(
      f.store.write('library', new ReadableStream({ cancel })),
    ).rejects.toMatchObject({ code: 'PROVIDER' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.metadata.discard).not.toHaveBeenCalled();
    expect((await f.client.list()).items).toHaveLength(0);
  });

  it('passes exact acknowledgement to host-controlled failed-write cleanup and respects references', async () => {
    const f = fixture();
    f.metadata.complete.mockRejectedValueOnce(new Error('commit failed'));
    await expect(
      f.store.write('library', bytes('uncommitted')),
    ).rejects.toThrow();
    expect(f.metadata.discard).toHaveBeenCalledWith(
      'library',
      expect.any(String),
      expect.objectContaining({ etag: expect.any(String) }),
    );
    expect((await f.client.list()).items).toHaveLength(0);
    f.metadata.complete.mockImplementationOnce(async (scope, record) => {
      f.references.add(f.key(scope, record.id));
      throw new Error('uncertain commit, now referenced');
    });
    await expect(
      f.store.write('library', bytes('referenced')),
    ).rejects.toThrow();
    expect((await f.client.list()).items).toHaveLength(1);
  });

  it('retains prepared inventory after an uncertain upload and cancels bounded writes', async () => {
    const f = fixture();
    const upload = f.client.uploadConditional.bind(f.client);
    vi.spyOn(f.client, 'uploadConditional').mockImplementationOnce(
      async (...args) => {
        await upload(...args);
        throw new Error('acknowledgement lost');
      },
    );
    await expect(
      f.store.write('library', bytes('uncertain')),
    ).rejects.toThrow();
    expect(f.metadata.discard).toHaveBeenCalledWith(
      'library',
      expect.any(String),
      undefined,
    );
    expect(f.prepared.size).toBe(1);
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = f.store.write('library', new ReadableStream({ cancel }), {
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(() => expect(f.metadata.prepare).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    await expect(
      f.store.write('library', bytes('too large'), { maxBytes: 2 }),
    ).rejects.toThrow();
  });
});

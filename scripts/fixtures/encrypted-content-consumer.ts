import assert from 'node:assert/strict';
import { createSecretKey } from 'node:crypto';
import { AesKeyRingProvider } from '@nestm/crypto/core';
import { FileCipherEngine } from '@nestm/crypto/files';
import {
  StorageClient,
  StorageError,
  StorageStagedContentStore,
  collectStorageBytes,
  storageBytesStream,
} from '@nestm/storage/core';
import { createMemoryStorageDriver } from '@nestm/storage/testing';
import {
  StorageEncryptedContentStore,
  type StorageEncryptedContentRecord,
} from '@nestm/storage/crypto';

const cipher = new FileCipherEngine({
  defaultProvider: 'archive',
  maxPlaintextBytes: 1_000n,
  providers: [
    {
      name: 'archive',
      provider: new AesKeyRingProvider({
        activeKeyId: 'key',
        keys: { key: createSecretKey(Buffer.alloc(32, 91)) },
      }),
    },
  ],
});
const client = new StorageClient('archive', createMemoryStorageDriver());
const key = (shelf: string, id: string) => `${shelf}/${id}`;
const physical = new StorageStagedContentStore({ client, key });
const prepared = new Set<string>();
const records = new Map<string, StorageEncryptedContentRecord>();
const store = new StorageEncryptedContentStore<string>({
  client,
  cipher,
  key,
  allowedProviders: ['archive'],
  aad: (shelf, id) => new TextEncoder().encode(JSON.stringify([shelf, id])),
  metadata: {
    async prepare(shelf, id) {
      assert.equal(prepared.has(key(shelf, id)), false);
      prepared.add(key(shelf, id));
    },
    async complete(shelf, record) {
      assert(prepared.has(key(shelf, record.id)));
      records.set(key(shelf, record.id), structuredClone(record));
    },
    async require(shelf, id) {
      const record = records.get(key(shelf, id));
      if (!record) throw new StorageError('Missing', { code: 'NOT_FOUND' });
      return record;
    },
    async discard(shelf, id, receipt) {
      if (receipt) {
        await physical.remove(shelf, receipt);
        records.delete(key(shelf, id));
        prepared.delete(key(shelf, id));
      }
    },
  },
});
try {
  const plaintext = new TextEncoder().encode('Library edition 🦉');
  const receipt = await store.write('essays', storageBytesStream(plaintext));
  assert.deepEqual(
    await collectStorageBytes(await store.read('essays', receipt), 100),
    plaintext,
  );
  assert.deepEqual(
    await collectStorageBytes(
      await store.read('essays', receipt, { range: { start: 2, end: 5 } }),
      4,
    ),
    plaintext.slice(2, 6),
  );
  await assert.rejects(store.read('poetry', receipt));
} finally {
  await cipher.close();
}

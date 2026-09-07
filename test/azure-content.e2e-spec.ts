import { createSecretKey, randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import type { ContainerClient } from '@azure/storage-blob';
import { AesKeyRingProvider } from '@nestm/crypto/core';
import { FileCipherEngine } from '@nestm/crypto/files';
import { StorageClient } from '../src/storage.client.js';
import { StorageStagedContentStore } from '../src/core/storage-staged-content.js';
import {
  collectStorageBytes,
  storageBytesStream,
} from '../src/core/storage-streams.js';
import {
  StorageEncryptedContentStore,
  type StorageEncryptedContentRecord,
} from '../src/crypto/index.js';
import {
  azure,
  createAzureStorageDriver,
  type AzureAdapterOptions,
} from '../src/files-sdk/azure/index.js';
import { createStorageProviderConformanceCases } from '../src/testing/index.js';

const enabled = process.env.STORAGE_AZURE_CONFORMANCE === 'true';
let options: AzureAdapterOptions;
let container: ContainerClient | undefined;
const clients: StorageClient[] = [];
const createClient = () =>
  new StorageClient(
    'azure-conformance',
    createAzureStorageDriver({ adapter: options }),
  );
const client = () => {
  const value = createClient();
  clients.push(value);
  return value;
};

describe.skipIf(!enabled)('Azure native provider and encrypted content', () => {
  beforeAll(async () => {
    const name = `nestm-test-${randomUUID()}`;
    const connectionString = process.env.STORAGE_AZURE_TEST_CONNECTION_STRING;
    if (connectionString) options = { container: name, connectionString };
    else {
      const accountName = process.env.STORAGE_AZURE_TEST_ACCOUNT_NAME;
      if (!accountName)
        throw new Error('Set Azure test connection string or account name.');
      options = {
        container: name,
        accountName,
        credential: new DefaultAzureCredential(),
        useUserDelegationSas: false,
      };
    }
    container = azure(options).raw.getContainerClient(name);
    await container.create();
  });
  afterAll(async () => {
    await container?.delete();
  });
  afterEach(async () => {
    await Promise.all(
      clients.splice(0).map((value) => value.onApplicationShutdown()),
    );
  });

  for (const contract of createStorageProviderConformanceCases({
    provider: 'azure-blob',
    createFixture: () => ({
      client: createClient(),
      createReplica: createClient,
    }),
    expected: {
      conditionalCreate: { resultEtag: true },
      conditionalReplace: { resultEtag: true },
      conditionalDelete: { etag: true },
      conditionalRead: { etag: true, version: false },
      physicalKey: { maxBytes: 1024 },
    },
  })) {
    it(contract.name, async (context) => {
      const result = await contract.run();
      if (result.status === 'skipped') context.skip(result.reason);
    });
  }

  it('settles competing creates and replacements atomically across independent clients', async () => {
    const first = client();
    const second = client();
    const key = `race/${randomUUID()}`;
    const race = await Promise.allSettled([
      first.uploadConditional(key, 'first', { condition: { type: 'create' } }),
      second.uploadConditional(key, 'second', {
        condition: { type: 'create' },
      }),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(race.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });
    const etag = (await first.head(key)).etag!;
    const replacements = await Promise.allSettled([
      first.uploadConditional(key, 'third', {
        condition: { type: 'replace', etag },
      }),
      second.uploadConditional(key, 'fourth', {
        condition: { type: 'replace', etag },
      }),
    ]);
    expect(
      replacements.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(
      first.downloadConditional(key, { condition: { etag } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      first.deleteConditional(key, { condition: { etag } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await first.exists(key)).toBe(true);
  });

  it('streams staged content across block boundaries, reopens exact ranges, and rejects stale cleanup', async () => {
    const storage = client();
    const key = (scope: string, id: string) => `${scope}/${id}`;
    const staged = new StorageStagedContentStore({ client: storage, key });
    const bytes = new Uint8Array(9 * 1024 * 1024 + 19).fill(53);
    bytes[4 * 1024 * 1024] = 99;
    const body = await staged.write('scope-a', storageBytesStream(bytes), {
      maxBytes: bytes.length,
    });
    const reopened = new StorageStagedContentStore({ client: client(), key });
    const offset = 4 * 1024 * 1024 - 1;
    expect(
      await collectStorageBytes(
        await reopened.read('scope-a', body, {
          range: { start: offset, end: offset + 2 },
        }),
        3,
      ),
    ).toEqual(bytes.slice(offset, offset + 3));
    await expect(
      reopened.writeReserved(
        'scope-a',
        body.payloadId,
        storageBytesStream(new Uint8Array([1])),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await storage.uploadConditional(
      key('scope-a', body.payloadId),
      'new revision',
      { condition: { type: 'replace', etag: body.etag } },
    );
    await expect(reopened.remove('scope-a', body)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await storage.exists(key('scope-a', body.payloadId))).toBe(true);
  });

  it('cancels over-budget staged streams without committing an object', async () => {
    const storage = client();
    const id = randomUUID();
    const staged = new StorageStagedContentStore({
      client: storage,
      key: (scope: string, id) => `${scope}/${id}`,
    });
    await expect(
      staged.writeReserved(
        'bounded',
        id,
        storageBytesStream(new Uint8Array(1025)),
        { maxBytes: 1024 },
      ),
    ).rejects.toBeDefined();
    expect(await storage.exists(`bounded/${id}`)).toBe(false);
  });

  it('round-trips authenticated encrypted content and range reads through a fresh client', async () => {
    const cipher = new FileCipherEngine({
      defaultProvider: 'azure-test',
      maxPlaintextBytes: 10_000_000n,
      providers: [
        {
          name: 'azure-test',
          provider: new AesKeyRingProvider({
            activeKeyId: 'test',
            keys: { test: createSecretKey(Buffer.alloc(32, 53)) },
          }),
        },
      ],
    });
    const records = new Map<string, StorageEncryptedContentRecord>();
    const key = (scope: string, id: string) => `encrypted/${scope}/${id}`;
    const open = () =>
      new StorageEncryptedContentStore({
        client: client(),
        cipher,
        key,
        allowedProviders: ['azure-test'],
        aad: (scope: string, id: string) =>
          new TextEncoder().encode(JSON.stringify([scope, id])),
        metadata: {
          prepare: async () => {},
          complete: async (scope: string, record) => {
            records.set(key(scope, record.id), record);
          },
          require: async (scope: string, id: string) => {
            const record = records.get(key(scope, id));
            if (!record) throw new Error('Missing content metadata.');
            return record;
          },
          discard: async () => {},
        },
      });
    try {
      const plaintext = new TextEncoder().encode(
        '😀 encrypted Azure bytes\n'.repeat(10000),
      );
      const receipt = await open().write(
        'workspace-a',
        storageBytesStream(plaintext),
        { maxBytes: plaintext.length },
      );
      expect(
        await collectStorageBytes(
          await open().read('workspace-a', receipt),
          plaintext.length,
        ),
      ).toEqual(plaintext);
      expect(
        await collectStorageBytes(
          await open().read('workspace-a', receipt, {
            range: { start: 4, end: 25 },
          }),
          22,
        ),
      ).toEqual(plaintext.slice(4, 26));
      const raw = await collectStorageBytes(
        (await client().downloadStream(key('workspace-a', receipt.payloadId)))
          .body,
        plaintext.length * 2,
      );
      expect(raw).not.toEqual(plaintext);
      await expect(open().read('workspace-b', receipt)).rejects.toThrow();
    } finally {
      await cipher.close();
    }
  });
});

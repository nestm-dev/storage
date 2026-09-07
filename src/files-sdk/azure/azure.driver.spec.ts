import {
  BlobClient,
  BlobServiceClient,
  BlockBlobClient,
} from '@azure/storage-blob';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { StorageClient } from '../../storage.client.js';
import { createProviderStorageDriver } from '../provider/index.js';
import { azure, createAzureStorageDriver } from './index.js';

const adapter = {
  accountName: 'nestmtest',
  accountKey: Buffer.alloc(32, 7).toString('base64'),
  container: 'content',
};
const clients: StorageClient[] = [];
const client = (
  options: Parameters<typeof createAzureStorageDriver>[0] = { adapter },
) => {
  const value = new StorageClient('azure', createAzureStorageDriver(options));
  clients.push(value);
  return value;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    clients.splice(0).map((value) => value.onApplicationShutdown()),
  );
});

describe('Azure storage driver', () => {
  it('advertises the same native predicates through direct and named construction', async () => {
    const named = await createProviderStorageDriver({
      provider: 'azure',
      config: {
        accountName: adapter.accountName,
        container: adapter.container,
        configJson: { accountKey: adapter.accountKey },
      },
    });
    for (const capabilities of [
      createAzureStorageDriver({ adapter }).capabilities,
      named.capabilities,
    ]) {
      expect(capabilities).toMatchObject({
        conditionalCreate: { resultEtag: true },
        conditionalReplace: { resultEtag: true },
        conditionalRead: { etag: true, version: false },
        conditionalDelete: { etag: true },
        rangeRead: true,
        physicalKey: { maxBytes: 1024 },
      });
      expect(capabilities.conditionalCopySource).toBeUndefined();
      expect(capabilities.conditionalMultipartCompletion).toBeUndefined();
    }
  });

  it('keeps Files SDK policy hooks around conditional requests and passes exact write conditions', async () => {
    const upload = vi
      .spyOn(BlockBlobClient.prototype, 'uploadStream')
      .mockImplementation(async (stream) => {
        for await (const chunk of stream) {
          expect(Buffer.isBuffer(chunk)).toBe(true);
        }
        return { etag: '"revision-1"' } as Awaited<
          ReturnType<BlockBlobClient['uploadStream']>
        >;
      });
    const onAction = vi.fn();
    const storage = client({ adapter, prefix: 'tenant', hooks: { onAction } });
    expect(
      await storage.uploadConditional('a.txt', 'é', {
        condition: { type: 'create' },
        contentType: 'text/plain',
        metadata: { purpose: 'test' },
      }),
    ).toMatchObject({ etag: 'revision-1', size: 2 });
    expect(upload.mock.calls[0]?.[3]).toMatchObject({
      conditions: { ifNoneMatch: '*' },
      metadata: { purpose: 'test' },
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });
    await storage.uploadConditional('a.txt', 'next', {
      condition: { type: 'replace', etag: 'revision-1' },
    });
    expect(upload.mock.calls[1]?.[3]).toMatchObject({
      conditions: { ifMatch: '"revision-1"' },
    });
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe tags, physical keys, and readonly mutations before provider calls', async () => {
    const upload = vi.spyOn(BlockBlobClient.prototype, 'uploadStream');
    const storage = client();
    await expect(async () =>
      storage.uploadConditional('a', 'x', {
        condition: { type: 'replace', etag: '*' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(async () =>
      storage.uploadConditional('a'.repeat(1025), 'x', {
        condition: { type: 'create' },
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(async () =>
      client({ adapter, readonly: true }).uploadConditional('a', 'x', {
        condition: { type: 'create' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('preserves range boundaries and exact ETag predicates on reads', async () => {
    const download = vi
      .spyOn(BlobClient.prototype, 'download')
      .mockResolvedValue({
        etag: '"revision-1"',
        _response: {} as Awaited<
          ReturnType<BlobClient['download']>
        >['_response'],
        contentLength: 2,
        contentType: 'text/plain',
        readableStreamBody: Readable.from([Buffer.from('bc')]),
      } as Awaited<ReturnType<BlobClient['download']>>);
    const storage = client();
    const object = await storage.downloadConditional('a', {
      condition: { etag: 'revision-1' },
      range: { start: 1, end: 2 },
    });
    expect(await new Response(object.body).text()).toBe('bc');
    expect(download).toHaveBeenCalledWith(
      1,
      2,
      expect.objectContaining({ conditions: { ifMatch: '"revision-1"' } }),
    );
  });

  it.each([undefined, '"unexpected-revision"'])(
    'closes a rejected exact-read stream for provider ETag %s',
    async (etag) => {
      const stream = Readable.from([Buffer.from('protected')]);
      vi.spyOn(BlobClient.prototype, 'download').mockResolvedValue({
        ...(etag === undefined ? {} : { etag }),
        _response: {} as Awaited<
          ReturnType<BlobClient['download']>
        >['_response'],
        readableStreamBody: stream,
      } as Awaited<ReturnType<BlobClient['download']>>);
      await expect(
        client().downloadConditional('a', {
          condition: { etag: 'revision-1' },
        }),
      ).rejects.toMatchObject({
        code: etag === undefined ? 'PROVIDER' : 'CONFLICT',
      });
      expect(stream.destroyed).toBe(true);
    },
  );

  it('sanitizes Azure errors without exposing request metadata or credentials', async () => {
    vi.spyOn(BlobClient.prototype, 'delete').mockRejectedValue({
      statusCode: 412,
      details: { errorCode: 'ConditionNotMet' },
      message: `secret ${adapter.accountKey}`,
      request: { headers: { authorization: 'secret' } },
    });
    const error = await client()
      .deleteConditional('a', { condition: { etag: 'old' } })
      .catch((error) => error);
    expect(error).toMatchObject({ code: 'CONFLICT', cause: undefined });
    expect(inspect(error)).not.toContain(adapter.accountKey);
    expect(inspect(error)).not.toContain('authorization');
  });

  it('cancels a blocked source and does not dispatch an already aborted upload', async () => {
    const upload = vi
      .spyOn(BlockBlobClient.prototype, 'uploadStream')
      .mockImplementation(async (stream) => {
        for await (const _chunk of stream) {
          /* wait for source */
        }
        return { etag: '"revision-1"' } as Awaited<
          ReturnType<BlockBlobClient['uploadStream']>
        >;
      });
    const cancel = vi.fn();
    const controller = new AbortController();
    const storage = client();
    const result = storage.uploadConditional(
      'a',
      new ReadableStream({ pull: () => new Promise(() => {}), cancel }),
      { condition: { type: 'create' }, signal: controller.signal },
    );
    const rejected = expect(result).rejects.toBeDefined();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
    upload.mockClear();
    await expect(
      storage.uploadConditional('b', 'x', {
        condition: { type: 'create' },
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('never lets ambient shared-key credentials override an explicit token credential', () => {
    vi.stubEnv('AZURE_STORAGE_CONNECTION_STRING', 'invalid-secret');
    vi.stubEnv('AZURE_STORAGE_ACCOUNT_KEY', adapter.accountKey);
    const credential = {
      getToken: async () => ({
        token: 'test',
        expiresOnTimestamp: Date.now() + 60000,
      }),
    };
    const resolved = azure({
      accountName: 'identityaccount',
      container: 'content',
      credential,
    });
    expect(resolved.raw).toBeInstanceOf(BlobServiceClient);
    expect(resolved.raw.url).toBe(
      'https://identityaccount.blob.core.windows.net/',
    );
    expect(resolved.raw.credential).toBe(credential);
    expect(() => azure({ ...adapter, credential })).toThrow(
      /competing credentials/u,
    );
  });
});

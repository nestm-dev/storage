import { Readable } from 'node:stream';

import { createStoredFile } from 'files-sdk';
import { memory } from 'files-sdk/memory';

import { StorageError, StorageErrorCode } from '../storage.error.js';
import { createFilesSdkDriver } from './files-sdk.driver.js';

describe('FilesSdkStorageDriver', () => {
  it('maps a not-found FilesError from another package copy', async () => {
    class ForeignFilesError extends Error {
      override readonly name = 'FilesError';
      readonly code = 'NotFound';
      readonly aborted = false;
      readonly timedOut = false;
      readonly permanent = true;
    }

    const adapter = memory();
    adapter.head = async () => {
      throw new ForeignFilesError('missing object');
    };
    const driver = createFilesSdkDriver({ adapter });

    await expect(driver.head('missing.bin')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
      message: 'missing object',
      permanent: true,
    });
  });

  it('does not classify an unrelated provider error from its code alone', async () => {
    const adapter = memory();
    adapter.head = async () => {
      throw Object.assign(new Error('provider used a coincidental code'), {
        code: 'NotFound',
      });
    };
    const driver = createFilesSdkDriver({ adapter });

    await expect(driver.head('unknown.bin')).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      message: 'provider used a coincidental code',
    });
  });

  it('preserves owned storage errors raised while consuming upload streams', async () => {
    const expected = new StorageError('stream limit reached', {
      code: StorageErrorCode.LIMIT_EXCEEDED,
      permanent: true,
    });
    const source = Readable.from(
      (async function* () {
        yield new Uint8Array([1]);
        throw expected;
      })(),
    );
    const driver = createFilesSdkDriver({ adapter: memory() });

    await expect(
      driver.upload('limited.bin', source, { multipart: true }),
    ).rejects.toBe(expected);
  });

  it('normalizes errors raised after a download stream is returned', async () => {
    const adapter = memory();
    adapter.download = async (key) =>
      createStoredFile(
        {
          key,
          size: 1,
          type: 'application/octet-stream',
        },
        {
          factory: () =>
            new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.error(new Error('late provider failure'));
              },
            }),
          kind: 'stream',
        },
      );
    const driver = createFilesSdkDriver({ adapter });
    const object = await driver.download('late.bin');

    await expect(object.body.getReader().read()).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      message: 'late provider failure',
    });
  });

  it('rejects a conditional adapter result from the wrong physical key', async () => {
    const adapter = Object.assign(memory(), {
      conditionalMutation: {
        create: true,
        delete: true,
        etag: true,
        replace: true,
      },
      deleteConditional: vi.fn(async () => undefined),
      uploadConditional: vi.fn(async () => ({
        contentType: 'text/plain',
        etag: 'etag',
        key: 'scope/other.txt',
        size: 4,
      })),
    });
    const driver = createFilesSdkDriver({ adapter, prefix: 'scope' });

    await expect(
      driver.uploadConditional('requested.txt', 'body', {
        condition: { type: 'create' },
      }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      key: 'requested.txt',
    });
    expect(adapter.uploadConditional).toHaveBeenCalledWith(
      'scope/requested.txt',
      'body',
      { condition: { type: 'create' } },
    );
  });
});

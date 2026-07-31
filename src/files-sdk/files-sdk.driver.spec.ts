import { Readable } from 'node:stream';

import { createStoredFile } from 'files-sdk';
import { memory } from 'files-sdk/memory';

import { StorageError, StorageErrorCode } from '../storage.error.js';
import { createFilesSdkDriver } from './files-sdk.driver.js';

describe('FilesSdkStorageDriver', () => {
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
});

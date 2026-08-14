import { Readable } from 'node:stream';
import { inspect } from 'node:util';

import { createStoredFile } from 'files-sdk';
import { memory } from 'files-sdk/memory';

import {
  StorageError,
  StorageErrorCode,
  isStorageError,
  type StorageError as StorageErrorType,
} from '../storage.error.js';
import { createFilesSdkDriver } from './files-sdk.driver.js';

async function rejectedStorageError(
  operation: () => Promise<unknown>,
): Promise<StorageErrorType> {
  try {
    await operation();
  } catch (error: unknown) {
    if (isStorageError(error)) return error;
    throw error;
  }
  throw new Error('Expected storage operation to reject.');
}

function logShape(error: StorageErrorType): string {
  return `${inspect(error, { depth: null })}\n${JSON.stringify({ error })}`;
}

describe('FilesSdkStorageDriver', () => {
  it('maps a not-found FilesError from another package copy without retaining provider details', async () => {
    const providerMessage = 'missing object request-id=secret-not-found';
    class ForeignFilesError extends Error {
      override readonly name = 'FilesError';
      readonly code = 'NotFound';
      readonly aborted = false;
      readonly timedOut = false;
      readonly permanent = true;
    }

    const adapter = memory();
    adapter.head = async () => {
      throw Object.assign(new ForeignFilesError(providerMessage), {
        cause: { providerBody: providerMessage },
      });
    };
    const driver = createFilesSdkDriver({ adapter });

    const error = await rejectedStorageError(() => driver.head('missing.bin'));
    expect(error).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.NOT_FOUND,
      message: 'Storage provider object was not found.',
      permanent: true,
    });
    expect(logShape(error)).not.toContain(providerMessage);
  });

  it('redacts unauthorized and generic provider errors while preserving flags', async () => {
    const unauthorizedDetail = 'secret unauthorized XML request-id=private';
    const providerDetail = 'secret provider body host-id=private';
    const adapter = memory();
    adapter.head = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error(unauthorizedDetail), {
          aborted: false,
          cause: { providerBody: unauthorizedDetail },
          code: 'Unauthorized',
          name: 'FilesError',
          permanent: true,
          timedOut: false,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(providerDetail), {
          code: 'NotFound',
          requestId: providerDetail,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('secret aborted provider detail'), {
          aborted: true,
          code: 'Provider',
          name: 'FilesError',
          permanent: false,
          timedOut: false,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('secret timeout provider detail'), {
          aborted: false,
          code: 'Provider',
          name: 'FilesError',
          permanent: false,
          timedOut: true,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('secret nested storage detail'), {
          aborted: false,
          cause: new StorageError('secret nested storage detail', {
            cause: { requestId: 'secret nested request id' },
            code: StorageErrorCode.UNAUTHORIZED,
            permanent: true,
          }),
          code: 'Provider',
          name: 'FilesError',
          permanent: false,
          timedOut: false,
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('secret flagged nested storage detail'), {
          aborted: true,
          cause: new StorageError('secret flagged nested storage detail', {
            cause: { requestId: 'secret flagged nested request id' },
            code: StorageErrorCode.NOT_FOUND,
            permanent: true,
          }),
          code: 'Provider',
          name: 'FilesError',
          permanent: false,
          timedOut: true,
        }),
      );
    const driver = createFilesSdkDriver({ adapter });

    const unauthorized = await rejectedStorageError(() =>
      driver.head('unauthorized.bin'),
    );
    expect(unauthorized).toMatchObject({
      aborted: false,
      cause: undefined,
      code: StorageErrorCode.UNAUTHORIZED,
      message: 'Storage provider operation was unauthorized.',
      permanent: true,
      timedOut: false,
    });
    const provider = await rejectedStorageError(() =>
      driver.head('unknown.bin'),
    );
    expect(provider).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.PROVIDER,
      message: 'Storage provider operation failed.',
    });
    const aborted = await rejectedStorageError(() =>
      driver.head('aborted.bin'),
    );
    expect(aborted).toMatchObject({
      aborted: true,
      cause: undefined,
      code: StorageErrorCode.ABORTED,
      message: 'Storage provider operation was aborted.',
      permanent: false,
      timedOut: false,
    });
    const timedOut = await rejectedStorageError(() =>
      driver.head('timeout.bin'),
    );
    expect(timedOut).toMatchObject({
      aborted: false,
      cause: undefined,
      code: StorageErrorCode.TIMEOUT,
      message: 'Storage provider operation timed out.',
      permanent: false,
      timedOut: true,
    });
    const nested = await rejectedStorageError(() => driver.head('nested.bin'));
    expect(nested).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.UNAUTHORIZED,
      message: 'Storage provider operation was unauthorized.',
      permanent: true,
    });
    const flaggedNested = await rejectedStorageError(() =>
      driver.head('flagged-nested.bin'),
    );
    expect(flaggedNested).toMatchObject({
      aborted: true,
      cause: undefined,
      code: StorageErrorCode.TIMEOUT,
      message: 'Storage provider operation timed out.',
      permanent: false,
      timedOut: true,
    });
    const serialized = [
      unauthorized,
      provider,
      aborted,
      timedOut,
      nested,
      flaggedNested,
    ]
      .map(logShape)
      .join('\n');
    expect(serialized).not.toContain(unauthorizedDetail);
    expect(serialized).not.toContain(providerDetail);
    expect(serialized).not.toContain('secret aborted provider detail');
    expect(serialized).not.toContain('secret timeout provider detail');
    expect(serialized).not.toContain('secret nested storage detail');
    expect(serialized).not.toContain('secret nested request id');
    expect(serialized).not.toContain('secret flagged nested storage detail');
    expect(serialized).not.toContain('secret flagged nested request id');
  });

  it('preserves caller error classification without exposing its message or identity', async () => {
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

    const error = await rejectedStorageError(() =>
      driver.upload('limited.bin', source, { multipart: true }),
    );
    expect(error).not.toBe(expected);
    expect(error).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.LIMIT_EXCEEDED,
      message: 'Storage provider operation exceeded a limit.',
      permanent: true,
    });
    expect(logShape(error)).not.toContain('stream limit reached');
  });

  it('redacts direct StorageErrors and prefixed conditional adapter failures', async () => {
    const rawMessage = 'raw provider body secret-request-id';
    const ordinary = memory();
    ordinary.head = async () => {
      throw new StorageError(rawMessage, {
        cause: { requestId: 'ordinary-secret' },
        code: StorageErrorCode.PROVIDER,
      });
    };
    const ordinaryDriver = createFilesSdkDriver({ adapter: ordinary });
    const ordinaryError = await rejectedStorageError(() =>
      ordinaryDriver.head('ordinary.txt'),
    );
    expect(ordinaryError).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.PROVIDER,
      key: undefined,
      message: 'Storage provider operation failed.',
    });
    expect(logShape(ordinaryError)).not.toContain(rawMessage);
    expect(logShape(ordinaryError)).not.toContain('ordinary-secret');

    const conditional = Object.assign(memory(), {
      conditionalRead: { etag: true, version: false },
      async downloadConditional(key: string): Promise<never> {
        throw new StorageError(`Storage object "${key}" was not found.`, {
          cause: { requestId: 'conditional-secret' },
          code: StorageErrorCode.NOT_FOUND,
          key,
          permanent: true,
        });
      },
    });
    const conditionalDriver = createFilesSdkDriver({
      adapter: conditional,
      prefix: 'secret-tenant-prefix',
    });
    const conditionalError = await rejectedStorageError(() =>
      conditionalDriver.downloadConditional('missing.txt', {
        condition: { etag: 'canonical-etag' },
      }),
    );
    expect(conditionalError).toMatchObject({
      cause: undefined,
      code: StorageErrorCode.NOT_FOUND,
      key: undefined,
      message: 'Storage provider object was not found.',
      permanent: true,
    });
    const serialized = logShape(conditionalError);
    expect(serialized).not.toContain('secret-tenant-prefix');
    expect(serialized).not.toContain('conditional-secret');
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
      message: 'Storage provider operation failed.',
    });
  });

  it('normalizes one provider ETag and rejects ambiguous provider values', async () => {
    const adapter = memory();
    adapter.head = vi
      .fn()
      .mockResolvedValueOnce(
        createStoredFile(
          {
            etag: '"provider-etag"',
            key: 'safe.bin',
            size: 1,
            type: 'application/octet-stream',
          },
          {
            factory: () => new ReadableStream<Uint8Array>(),
            kind: 'stream',
          },
        ),
      )
      .mockResolvedValueOnce(
        createStoredFile(
          {
            etag: '"stale","current"',
            key: 'unsafe.bin',
            size: 1,
            type: 'application/octet-stream',
          },
          {
            factory: () => new ReadableStream<Uint8Array>(),
            kind: 'stream',
          },
        ),
      );
    const driver = createFilesSdkDriver({ adapter });

    await expect(driver.head('safe.bin')).resolves.toMatchObject({
      etag: 'provider-etag',
    });
    await expect(driver.head('unsafe.bin')).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      permanent: true,
    });
  });

  it('rejects a conditional adapter result from the wrong physical key', async () => {
    const adapter = Object.assign(memory(), {
      conditionalCreate: { resultEtag: true },
      conditionalDelete: { etag: true },
      conditionalReplace: { resultEtag: true },
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
    });
    expect(adapter.uploadConditional).toHaveBeenCalledWith(
      'scope/requested.txt',
      'body',
      { condition: { type: 'create' } },
    );
  });
});

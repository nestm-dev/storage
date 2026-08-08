import { CopyObjectCommand } from '@aws-sdk/client-s3';
import {
  mapS3Error,
  s3,
  type S3Adapter,
  type S3AdapterOptions,
} from 'files-sdk/s3';

import type { StoragePromotionOptions } from '../../storage.types.js';
import {
  createFilesSdkDriver,
  type FilesSdkConditionalCopyAdapter,
  type FilesSdkDriverOptions,
  type FilesSdkSignedUploadPolicyAdapter,
  type FilesSdkSignedDownloadPolicyAdapter,
  type FilesSdkStorageDriver,
  mapFilesSdkError,
} from '../files-sdk.driver.js';

export interface S3StorageDriverOptions extends Omit<
  FilesSdkDriverOptions<S3Adapter>,
  'adapter'
> {
  adapter: S3AdapterOptions;
}

export type S3StorageAdapter = S3Adapter &
  FilesSdkConditionalCopyAdapter &
  FilesSdkSignedDownloadPolicyAdapter &
  FilesSdkSignedUploadPolicyAdapter;

function copySource(
  bucket: string,
  key: string,
  version: string | undefined,
): string {
  const source = `${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  return version === undefined
    ? source
    : `${source}?versionId=${encodeURIComponent(version)}`;
}

function operationSignal(
  options: StoragePromotionOptions,
): AbortSignal | undefined {
  const timeoutSignal =
    options.timeout === undefined || options.timeout <= 0
      ? undefined
      : AbortSignal.timeout(options.timeout);
  if (options.signal === undefined) {
    return timeoutSignal;
  }
  return timeoutSignal === undefined
    ? options.signal
    : AbortSignal.any([options.signal, timeoutSignal]);
}

function maxRetries(options: StoragePromotionOptions): number {
  const configured =
    typeof options.retries === 'number'
      ? options.retries
      : options.retries?.max;
  return Math.max(0, Math.floor(configured ?? 0));
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.max(0, milliseconds),
    );
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Adds the S3-only capabilities to an adapter already built by `s3(...)`: an
 * ETag/version-conditional server-side promotion, and the signed upload and
 * download policies the bridge advertises through `capabilities`.
 *
 * Exported so the provider factory can apply them to the adapter `loadFiles`
 * resolved for the `s3` slug instead of re-deriving {@link S3AdapterOptions}
 * from flat provider config. It expects an adapter whose `raw` is an `S3Client`
 * — pass one built by `s3(...)`, not an S3-compatible wrapper.
 */
export function withS3Capabilities(
  base: S3Adapter,
  options: Pick<S3AdapterOptions, 'publicBaseUrl'> = {},
): S3StorageAdapter {
  return Object.assign(base, {
    conditionalCopy: Object.freeze({
      etag: true,
      supported: true,
      version: true,
    }),
    signedUploadPolicy: Object.freeze({
      contentType: true,
      sizeRange: true,
    }),
    signedDownloadPolicy: Object.freeze({
      expiresIn: options.publicBaseUrl === undefined,
    }),
    async promote(
      sourceKey: string,
      destinationKey: string,
      promotion: StoragePromotionOptions,
    ): Promise<void> {
      const retries = maxRetries(promotion);
      for (let attempt = 0; ; attempt += 1) {
        const signal = operationSignal(promotion);
        try {
          await base.raw.send(
            new CopyObjectCommand({
              Bucket: base.bucket,
              CopySource: copySource(
                base.bucket,
                sourceKey,
                promotion.sourceVersion,
              ),
              ...(promotion.sourceEtag !== undefined && {
                CopySourceIfMatch: promotion.sourceEtag,
              }),
              Key: destinationKey,
            }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
          return;
        } catch (error) {
          const mapped = mapS3Error(error);
          if (
            attempt >= retries ||
            mapped.code !== 'Provider' ||
            mapped.aborted ||
            mapped.permanent ||
            signal?.aborted === true
          ) {
            throw mapped;
          }
          const storageError = mapFilesSdkError(mapped);
          const delay =
            typeof promotion.retries === 'object' &&
            promotion.retries.backoff !== undefined
              ? promotion.retries.backoff({
                  attempt: attempt + 1,
                  error: storageError,
                })
              : Math.min(1000, 100 * 2 ** attempt);
          await waitForRetry(delay, promotion.signal);
        }
      }
    },
  } satisfies FilesSdkConditionalCopyAdapter &
    FilesSdkSignedDownloadPolicyAdapter &
    FilesSdkSignedUploadPolicyAdapter);
}

/**
 * Creates the files-sdk S3 driver from the storage package's own dependency
 * context and adds an ETag/version-conditional server-side promotion.
 */
export function createS3StorageDriver(
  options: S3StorageDriverOptions,
): FilesSdkStorageDriver<S3StorageAdapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  return createFilesSdkDriver({
    ...filesOptions,
    adapter: withS3Capabilities(s3(adapterOptions), adapterOptions),
  });
}

export { mapS3Error, s3 } from 'files-sdk/s3';
export type { S3Adapter, S3AdapterOptions, S3Sdk } from 'files-sdk/s3';

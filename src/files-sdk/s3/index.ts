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

type EnhancedS3Adapter = S3Adapter &
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
 * Creates the files-sdk S3 driver from the storage package's own dependency
 * context and adds an ETag/version-conditional server-side promotion.
 */
export function createS3StorageDriver(
  options: S3StorageDriverOptions,
): FilesSdkStorageDriver<EnhancedS3Adapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  const base = s3(adapterOptions);
  const adapter: EnhancedS3Adapter = Object.assign(base, {
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
      expiresIn: adapterOptions.publicBaseUrl === undefined,
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

  return createFilesSdkDriver({
    ...filesOptions,
    adapter,
  });
}

export { mapS3Error, s3 } from 'files-sdk/s3';
export type { S3Adapter, S3AdapterOptions, S3Sdk } from 'files-sdk/s3';

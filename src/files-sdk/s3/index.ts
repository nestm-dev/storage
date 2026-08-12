import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import {
  mapS3Error,
  s3,
  type S3Adapter,
  type S3AdapterOptions,
} from 'files-sdk/s3';

import type {
  StorageBody,
  StorageConditionalDeleteOptions,
  StorageConditionalUploadOptions,
  StorageOperationOptions,
  StoragePromotionOptions,
  StorageUploadResult,
} from '../../storage.types.js';
import { StorageError, StorageErrorCode } from '../../storage.error.js';
import {
  createFilesSdkDriver,
  type FilesSdkConditionalCopyAdapter,
  type FilesSdkConditionalMutationAdapter,
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
  /**
   * Opt in or out of conditional writes for an S3-compatible endpoint whose
   * support is known. Native AWS S3 enables them by default; custom endpoints
   * default to false because compatibility varies.
   */
  conditionalMutation?: boolean;
}

type S3StorageAdapterBase = S3Adapter &
  FilesSdkConditionalCopyAdapter &
  FilesSdkSignedDownloadPolicyAdapter &
  FilesSdkSignedUploadPolicyAdapter;

export type S3StorageAdapter = S3StorageAdapterBase &
  Partial<FilesSdkConditionalMutationAdapter>;

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
  options: StorageOperationOptions,
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

function maxRetries(options: StorageOperationOptions): number {
  const configured =
    typeof options.retries === 'number'
      ? options.retries
      : options.retries?.max;
  return Math.max(0, Math.floor(configured ?? 0));
}

function etagHeader(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag : `"${etag}"`;
}

function stripEtag(etag: string | undefined): string | undefined {
  return etag?.replace(/^"+|"+$/gu, '');
}

function contentTypeOf(
  body: StorageBody,
  override: string | undefined,
): string {
  if (override !== undefined) {
    return override;
  }
  if (typeof body === 'string') {
    return 'text/plain; charset=utf-8';
  }
  if (body instanceof Blob && body.type.length > 0) {
    return body.type;
  }
  return 'application/octet-stream';
}

async function normalizeConditionalBody(
  body: StorageBody,
  onProgress: StorageConditionalUploadOptions['onProgress'],
): Promise<{
  body: Uint8Array | ReadableStream<Uint8Array>;
  size: () => number;
  contentLength?: number;
}> {
  let bytes: Uint8Array | undefined;
  if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  }

  if (bytes !== undefined) {
    const total = bytes.byteLength;
    onProgress?.({ loaded: 0, total });
    return { body: bytes, contentLength: total, size: () => total };
  }

  const stream =
    body instanceof Readable
      ? (Readable.toWeb(body) as ReadableStream<Uint8Array>)
      : body;
  if (!(stream instanceof ReadableStream)) {
    throw new StorageError('Unsupported conditional upload body.', {
      code: StorageErrorCode.INVALID_ARGUMENT,
      operation: 'upload',
      permanent: true,
    });
  }
  const reader = stream.getReader();
  let loaded = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      cancel(reason) {
        return reader.cancel(reason);
      },
      async pull(controller) {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        loaded += result.value.byteLength;
        controller.enqueue(result.value);
        onProgress?.({ loaded });
      },
    }),
    size: () => loaded,
  };
}

async function withS3Retry<Result>(
  options: StorageOperationOptions,
  operation: (signal: AbortSignal | undefined) => Promise<Result>,
): Promise<Result> {
  const retries = maxRetries(options);
  for (let attempt = 0; ; attempt += 1) {
    const signal = operationSignal(options);
    try {
      return await operation(signal);
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
        typeof options.retries === 'object' &&
        options.retries.backoff !== undefined
          ? options.retries.backoff({
              attempt: attempt + 1,
              error: storageError,
            })
          : Math.min(1000, 100 * 2 ** attempt);
      await waitForRetry(delay, options.signal);
    }
  }
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
  options: Pick<S3AdapterOptions, 'endpoint' | 'publicBaseUrl'> & {
    conditionalMutation?: boolean;
  } = {},
): S3StorageAdapter {
  const supportsConditionalMutation =
    options.conditionalMutation ?? options.endpoint === undefined;
  const common = Object.assign(base, {
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
      await withS3Retry(promotion, async (signal) => {
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
      });
    },
  } satisfies FilesSdkConditionalCopyAdapter &
    FilesSdkSignedDownloadPolicyAdapter &
    FilesSdkSignedUploadPolicyAdapter);
  if (!supportsConditionalMutation) {
    return common;
  }
  return Object.assign(common, {
    conditionalMutation: Object.freeze({
      create: true,
      delete: true,
      etag: true,
      replace: true,
    }),
    async deleteConditional(
      key: string,
      options: StorageConditionalDeleteOptions,
    ): Promise<void> {
      await withS3Retry(options, async (signal) => {
        await base.raw.send(
          new DeleteObjectCommand({
            Bucket: base.bucket,
            IfMatch: etagHeader(options.condition.etag),
            Key: key,
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        );
      });
    },
    async uploadConditional(
      key: string,
      body: StorageBody,
      conditional: StorageConditionalUploadOptions,
    ): Promise<StorageUploadResult> {
      if (
        conditional.multipart !== undefined &&
        conditional.multipart !== false
      ) {
        throw new StorageError(
          'Conditional S3 uploads do not support multipart mode.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key,
            operation: 'upload',
            permanent: true,
          },
        );
      }
      if (conditional.control !== undefined) {
        throw new StorageError(
          'Conditional S3 uploads do not support resumable control.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key,
            operation: 'upload',
            permanent: true,
          },
        );
      }

      const normalized = await normalizeConditionalBody(
        body,
        conditional.onProgress,
      );
      const contentType = contentTypeOf(body, conditional.contentType);
      const retryOptions: StorageOperationOptions =
        normalized.contentLength === undefined
          ? { ...conditional, retries: 0 }
          : conditional;
      const result = await withS3Retry(retryOptions, (signal) =>
        base.raw.send(
          new PutObjectCommand({
            Body: normalized.body,
            Bucket: base.bucket,
            ...(conditional.cacheControl !== undefined && {
              CacheControl: conditional.cacheControl,
            }),
            ...(normalized.contentLength !== undefined && {
              ContentLength: normalized.contentLength,
            }),
            ContentType: contentType,
            ...(conditional.condition.type === 'create'
              ? { IfNoneMatch: '*' }
              : { IfMatch: etagHeader(conditional.condition.etag) }),
            Key: key,
            ...(conditional.metadata !== undefined && {
              Metadata: conditional.metadata,
            }),
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        ),
      );
      const size = normalized.size();
      conditional.onProgress?.({
        loaded: size,
        ...(normalized.contentLength !== undefined && {
          total: normalized.contentLength,
        }),
      });
      const etag = stripEtag(result.ETag);
      if (etag === undefined || etag.length === 0) {
        throw new StorageError(
          'S3 committed a conditional upload without returning the ETag required to identify its result; reconcile the destination before retrying.',
          {
            code: StorageErrorCode.PROVIDER,
            key,
            operation: 'upload',
            permanent: true,
          },
        );
      }
      return {
        contentType,
        etag,
        key,
        size,
      };
    },
  } satisfies FilesSdkConditionalMutationAdapter);
}

/**
 * Creates the files-sdk S3 driver from the storage package's own dependency
 * context and adds an ETag/version-conditional server-side promotion.
 */
export function createS3StorageDriver(
  options: S3StorageDriverOptions,
): FilesSdkStorageDriver<S3StorageAdapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  const { conditionalMutation, ...plainFilesOptions } = filesOptions;
  return createFilesSdkDriver({
    ...plainFilesOptions,
    adapter: withS3Capabilities(s3(adapterOptions), {
      ...adapterOptions,
      ...(conditionalMutation !== undefined && { conditionalMutation }),
    }),
  });
}

export { mapS3Error, s3 } from 'files-sdk/s3';
export type { S3Adapter, S3AdapterOptions, S3Sdk } from 'files-sdk/s3';

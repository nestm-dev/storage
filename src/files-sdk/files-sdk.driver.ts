import { Readable } from 'node:stream';

import {
  Files,
  FilesError,
  type Adapter,
  type Body,
  type DownloadOptions,
  type FilesOptions,
  type ListOptions,
  type OperationOptions,
  type RetryOptions,
  type SearchOptions,
  type SignUploadOptions,
  type StoredFile,
  type UploadOptions,
  type UploadResult,
  type UrlOptions,
} from 'files-sdk';

import {
  StorageError,
  StorageErrorCode,
  isStorageError,
} from '../storage.error.js';
import type { StorageDriver } from '../storage.driver.js';
import type {
  StorageBody,
  StorageConditionalCopyDestinationCapability,
  StorageConditionalCopySourceCapability,
  StorageConditionalDeleteCapability,
  StorageConditionalDeleteOptions,
  StorageConditionalMultipartCompletionCapability,
  StorageConditionalReadCapability,
  StorageConditionalReadOptions,
  StorageConditionalUploadOptions,
  StorageConditionalWriteCapability,
  StorageDownloadOptions,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StorageOperationOptions,
  StoragePhysicalKeyCapability,
  StoragePromotionOptions,
  StorageRetryOptions,
  StorageSearchOptions,
  StorageSignedUploadPolicyCapability,
  StorageSignedDownloadPolicyCapability,
  StorageSignedDownloadOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StorageUploadOptions,
  StorageUploadResult,
} from '../storage.types.js';
import { getFilesSdkUploadControl } from '../storage-upload-control.js';

export type FilesSdkDriverOptions<AdapterType extends Adapter> =
  FilesOptions<AdapterType>;

/**
 * Optional adapter extension for providers that can conditionally copy an
 * immutable source identity. Plain files-sdk adapters remain fully supported.
 */
export interface FilesSdkConditionalCopyAdapter {
  readonly conditionalCopySource?: StorageConditionalCopySourceCapability;
  readonly conditionalCopyDestination?: StorageConditionalCopyDestinationCapability;
  promote(
    sourceKey: string,
    destinationKey: string,
    options: StoragePromotionOptions,
  ): Promise<void>;
}

/** Optional adapter extension for native compare-and-set uploads. */
export interface FilesSdkConditionalUploadAdapter {
  readonly conditionalCreate?: StorageConditionalWriteCapability;
  readonly conditionalReplace?: StorageConditionalWriteCapability;
  readonly conditionalMultipartCompletion?: StorageConditionalMultipartCompletionCapability;
  uploadConditional(
    key: string,
    body: Body,
    options: StorageConditionalUploadOptions,
  ): Promise<StorageUploadResult>;
}

/** Optional adapter extension for native compare-and-delete. */
export interface FilesSdkConditionalDeleteAdapter {
  readonly conditionalDelete: StorageConditionalDeleteCapability;
  deleteConditional(
    key: string,
    options: StorageConditionalDeleteOptions,
  ): Promise<void>;
}

/** Optional adapter extension for an exact observed-identity read. */
export interface FilesSdkConditionalReadAdapter {
  readonly conditionalRead: StorageConditionalReadCapability;
  downloadConditional(
    key: string,
    options: StorageConditionalReadOptions,
  ): Promise<StorageObject>;
}

/** Optional provider key budget, measured after the driver prefix is applied. */
export interface FilesSdkPhysicalKeyAdapter {
  readonly physicalKey: StoragePhysicalKeyCapability;
}

export interface FilesSdkSignedUploadPolicyAdapter {
  readonly signedUploadPolicy: StorageSignedUploadPolicyCapability;
}

export interface FilesSdkSignedDownloadPolicyAdapter {
  readonly signedDownloadPolicy: StorageSignedDownloadPolicyCapability;
}

function conditionalCopyAdapterOf(
  adapter: Adapter,
): FilesSdkConditionalCopyAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('promote' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalCopyAdapter>;
  const source = candidate.conditionalCopySource;
  const destination = candidate.conditionalCopyDestination;
  if (
    (source === undefined && destination === undefined) ||
    (source !== undefined &&
      (typeof source.etag !== 'boolean' ||
        typeof source.version !== 'boolean')) ||
    (destination !== undefined &&
      (typeof destination.create !== 'boolean' ||
        typeof destination.replace !== 'boolean' ||
        typeof destination.atomicWithSource !== 'boolean')) ||
    typeof candidate.promote !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalCopyAdapter;
}

function conditionalUploadAdapterOf(
  adapter: Adapter,
): FilesSdkConditionalUploadAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('uploadConditional' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalUploadAdapter>;
  const create = candidate.conditionalCreate;
  const replace = candidate.conditionalReplace;
  const multipart = candidate.conditionalMultipartCompletion;
  if (
    (create === undefined && replace === undefined) ||
    (create !== undefined && typeof create.resultEtag !== 'boolean') ||
    (replace !== undefined && typeof replace.resultEtag !== 'boolean') ||
    (multipart !== undefined &&
      (typeof multipart.create !== 'boolean' ||
        typeof multipart.replace !== 'boolean')) ||
    typeof candidate.uploadConditional !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalUploadAdapter;
}

function conditionalDeleteAdapterOf(
  adapter: Adapter,
): FilesSdkConditionalDeleteAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('conditionalDelete' in adapter) ||
    !('deleteConditional' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalDeleteAdapter>;
  if (
    candidate.conditionalDelete === undefined ||
    typeof candidate.conditionalDelete.etag !== 'boolean' ||
    typeof candidate.deleteConditional !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalDeleteAdapter;
}

function conditionalReadAdapterOf(
  adapter: Adapter,
): FilesSdkConditionalReadAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('conditionalRead' in adapter) ||
    !('downloadConditional' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalReadAdapter>;
  if (
    candidate.conditionalRead === undefined ||
    typeof candidate.conditionalRead.etag !== 'boolean' ||
    typeof candidate.conditionalRead.version !== 'boolean' ||
    typeof candidate.downloadConditional !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalReadAdapter;
}

function physicalKeyAdapterOf(
  adapter: Adapter,
): FilesSdkPhysicalKeyAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('physicalKey' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter & Partial<FilesSdkPhysicalKeyAdapter>;
  const maxBytes = candidate.physicalKey?.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || (maxBytes ?? 0) <= 0) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkPhysicalKeyAdapter;
}

function signedUploadPolicyAdapterOf(
  adapter: Adapter,
): FilesSdkSignedUploadPolicyAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('signedUploadPolicy' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkSignedUploadPolicyAdapter>;
  const capability = candidate.signedUploadPolicy;
  if (
    capability === undefined ||
    typeof capability.contentType !== 'boolean' ||
    typeof capability.sizeRange !== 'boolean'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkSignedUploadPolicyAdapter;
}

function signedDownloadPolicyAdapterOf(
  adapter: Adapter,
): FilesSdkSignedDownloadPolicyAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('signedDownloadPolicy' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkSignedDownloadPolicyAdapter>;
  const capability = candidate.signedDownloadPolicy;
  if (capability === undefined || typeof capability.expiresIn !== 'boolean') {
    return undefined;
  }
  return candidate as Adapter & FilesSdkSignedDownloadPolicyAdapter;
}

interface FilesErrorLike {
  readonly name: string;
  readonly message: string;
  readonly code: FilesError['code'];
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly permanent: boolean;
  readonly cause?: unknown;
}

function isFilesErrorCode(value: unknown): value is FilesError['code'] {
  return (
    value === 'NotFound' ||
    value === 'Unauthorized' ||
    value === 'Conflict' ||
    value === 'ReadOnly' ||
    value === 'Provider'
  );
}

function isFilesErrorLike(error: unknown): error is FilesErrorLike {
  if (error instanceof FilesError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    return (
      error.name === 'FilesError' &&
      typeof error.message === 'string' &&
      'code' in error &&
      isFilesErrorCode(error.code) &&
      'aborted' in error &&
      typeof error.aborted === 'boolean' &&
      'timedOut' in error &&
      typeof error.timedOut === 'boolean' &&
      'permanent' in error &&
      typeof error.permanent === 'boolean'
    );
  } catch {
    return false;
  }
}

function unwrapFilesError(error: FilesErrorLike): FilesErrorLike {
  const seen = new Set<FilesErrorLike>();
  let current = error;

  while (
    current.code === 'Provider' &&
    !current.aborted &&
    !current.timedOut &&
    !current.permanent &&
    isFilesErrorLike(current.cause) &&
    current.message === current.cause.message &&
    !seen.has(current.cause)
  ) {
    seen.add(current);
    current = current.cause;
  }

  return current;
}

export function mapFilesSdkError(error: unknown): StorageError {
  if (isStorageError(error)) {
    return error;
  }
  if (!isFilesErrorLike(error)) {
    return new StorageError(
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
        code: StorageErrorCode.PROVIDER,
      },
    );
  }

  const filesError = unwrapFilesError(error);

  if (isStorageError(filesError.cause)) {
    return filesError.cause;
  }

  let code: StorageErrorCode;
  if (filesError.timedOut) {
    code = StorageErrorCode.TIMEOUT;
  } else if (filesError.aborted) {
    code = StorageErrorCode.ABORTED;
  } else {
    switch (filesError.code) {
      case 'NotFound':
        code = StorageErrorCode.NOT_FOUND;
        break;
      case 'Unauthorized':
        code = StorageErrorCode.UNAUTHORIZED;
        break;
      case 'Conflict':
        code = StorageErrorCode.CONFLICT;
        break;
      case 'ReadOnly':
        code = StorageErrorCode.READ_ONLY;
        break;
      case 'Provider':
        code = /(?:not supported|does not support|unsupported)/iu.test(
          filesError.message,
        )
          ? StorageErrorCode.NOT_SUPPORTED
          : StorageErrorCode.PROVIDER;
        break;
    }
  }

  return new StorageError(filesError.message, {
    aborted: filesError.aborted,
    cause: filesError.cause ?? error,
    code,
    permanent: filesError.permanent,
    timedOut: filesError.timedOut,
  });
}

function mapRetryOptions(
  retries: StorageRetryOptions | undefined,
): RetryOptions | undefined {
  if (retries === undefined || typeof retries === 'number') {
    return retries;
  }

  return {
    max: retries.max,
    ...(retries.backoff !== undefined && {
      backoff: ({ attempt, error }) =>
        retries.backoff?.({
          attempt,
          error: mapFilesSdkError(error),
        }) ?? 0,
    }),
  };
}

function storageRetryOptions(
  retries: RetryOptions | undefined,
): StorageRetryOptions | undefined {
  if (retries === undefined || typeof retries === 'number') {
    return retries;
  }
  return {
    max: retries.max,
    ...(retries.backoff !== undefined && {
      backoff: ({ attempt, error }) =>
        retries.backoff?.({
          attempt,
          error: new FilesError(
            error.code === StorageErrorCode.NOT_FOUND
              ? 'NotFound'
              : error.code === StorageErrorCode.UNAUTHORIZED
                ? 'Unauthorized'
                : error.code === StorageErrorCode.CONFLICT
                  ? 'Conflict'
                  : error.code === StorageErrorCode.READ_ONLY
                    ? 'ReadOnly'
                    : 'Provider',
            error.message,
            error,
            {
              aborted: error.aborted,
              permanent: error.permanent,
              timedOut: error.timedOut,
            },
          ),
        }) ?? 0,
    }),
  };
}

function operationOptions(
  options?: StorageOperationOptions,
): OperationOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  const retries = mapRetryOptions(options.retries);
  return {
    ...(retries !== undefined && { retries }),
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.timeout !== undefined && { timeout: options.timeout }),
  };
}

async function* normalizeNodeChunks(
  source: Readable,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    if (typeof chunk === 'string') {
      yield new TextEncoder().encode(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }
    throw new StorageError(
      'Node upload streams must yield strings or Uint8Array chunks.',
      {
        code: StorageErrorCode.INVALID_ARGUMENT,
        permanent: true,
      },
    );
  }
}

function mapBody(body: StorageBody): Body {
  if (body instanceof Readable) {
    return Readable.toWeb(
      Readable.from(normalizeNodeChunks(body)),
    ) as ReadableStream<Uint8Array>;
  }
  return body;
}

function normalizeDownloadStream(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
    source.getReader();

  const release = (): void => {
    reader?.releaseLock();
    reader = undefined;
  };

  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      const activeReader = reader;
      if (activeReader === undefined) {
        return;
      }
      try {
        await activeReader.cancel(reason);
      } catch (error) {
        throw mapFilesSdkError(error);
      } finally {
        release();
      }
    },
    async pull(controller) {
      const activeReader = reader;
      if (activeReader === undefined) {
        controller.close();
        return;
      }
      try {
        const result = await activeReader.read();
        if (result.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        release();
        controller.error(mapFilesSdkError(error));
      }
    },
  });
}

function uploadOptions(
  options?: StorageUploadOptions,
): UploadOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...operationOptions(options),
    ...(options.cacheControl !== undefined && {
      cacheControl: options.cacheControl,
    }),
    ...(options.contentType !== undefined && {
      contentType: options.contentType,
    }),
    ...(options.control !== undefined && {
      control: getFilesSdkUploadControl(options.control),
    }),
    ...(options.metadata !== undefined && { metadata: options.metadata }),
    ...(options.multipart !== undefined && {
      multipart: options.multipart,
    }),
    ...(options.onProgress !== undefined && {
      onProgress: options.onProgress,
    }),
  };
}

function downloadOptions(options?: StorageDownloadOptions): DownloadOptions {
  return {
    ...operationOptions(options),
    as: 'stream',
    ...(options?.range !== undefined && { range: options.range }),
  };
}

function listOptions(options?: StorageListOptions): ListOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...operationOptions(options),
    ...(options.cursor !== undefined && { cursor: options.cursor }),
    ...(options.delimiter !== undefined && { delimiter: options.delimiter }),
    ...(options.limit !== undefined && { limit: options.limit }),
    ...(options.prefix !== undefined && { prefix: options.prefix }),
  };
}

function searchOptions(
  options?: StorageSearchOptions,
): SearchOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...operationOptions(options),
    ...(options.caseInsensitive !== undefined && {
      caseInsensitive: options.caseInsensitive,
    }),
    ...(options.limit !== undefined && { limit: options.limit }),
    ...(options.match !== undefined && { match: options.match }),
    ...(options.maxResults !== undefined && {
      maxResults: options.maxResults,
    }),
    ...(options.prefix !== undefined && { prefix: options.prefix }),
  };
}

function signedDownloadOptions(
  options?: StorageSignedDownloadOptions,
): UrlOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...operationOptions(options),
    ...(options.expiresIn !== undefined && {
      expiresIn: options.expiresIn,
    }),
    ...(options.responseContentDisposition !== undefined && {
      responseContentDisposition: options.responseContentDisposition,
    }),
  };
}

function signedUploadOptions(
  options: StorageSignedUploadOptions,
): SignUploadOptions {
  return {
    ...operationOptions(options),
    expiresIn: options.expiresIn,
    ...(options.contentType !== undefined && {
      contentType: options.contentType,
    }),
    ...(options.maxSize !== undefined && { maxSize: options.maxSize }),
    ...(options.minSize !== undefined && { minSize: options.minSize }),
  };
}

function metadataOf(file: StoredFile): StorageObjectMetadata {
  return {
    contentType: file.type,
    ...(file.etag !== undefined && { etag: file.etag }),
    key: file.key,
    ...(file.lastModified !== undefined && {
      lastModified: new Date(file.lastModified),
    }),
    ...(file.metadata !== undefined && {
      metadata: { ...file.metadata },
    }),
    name: file.name,
    size: file.size,
  };
}

function uploadResultOf(result: UploadResult): StorageUploadResult {
  return {
    contentType: result.contentType,
    ...(result.etag !== undefined && { etag: result.etag }),
    key: result.key,
    ...(result.lastModified !== undefined && {
      lastModified: new Date(result.lastModified),
    }),
    size: result.size,
  };
}

export class FilesSdkStorageDriver<
  AdapterType extends Adapter = Adapter,
> implements StorageDriver {
  readonly #files: Files<AdapterType>;
  readonly #name: string;
  readonly #conditionalCopy: FilesSdkConditionalCopyAdapter | undefined;
  readonly #conditionalDelete: FilesSdkConditionalDeleteAdapter | undefined;
  readonly #conditionalRead: FilesSdkConditionalReadAdapter | undefined;
  readonly #conditionalUpload: FilesSdkConditionalUploadAdapter | undefined;
  readonly #physicalKey: FilesSdkPhysicalKeyAdapter | undefined;
  readonly #prefix: string;
  readonly #readOnly: boolean;
  readonly #retries: StorageRetryOptions | undefined;
  readonly #signal: AbortSignal | undefined;
  readonly #timeout: number | undefined;
  readonly #signedUploadPolicy: FilesSdkSignedUploadPolicyAdapter | undefined;
  readonly #signedDownloadPolicy:
    FilesSdkSignedDownloadPolicyAdapter | undefined;

  constructor(options: FilesSdkDriverOptions<AdapterType>) {
    this.#files = new Files(options);
    this.#name = options.adapter.name;
    this.#conditionalCopy = conditionalCopyAdapterOf(options.adapter);
    this.#conditionalDelete = conditionalDeleteAdapterOf(options.adapter);
    this.#conditionalRead = conditionalReadAdapterOf(options.adapter);
    this.#conditionalUpload = conditionalUploadAdapterOf(options.adapter);
    this.#physicalKey = physicalKeyAdapterOf(options.adapter);
    this.#prefix = this.#files.prefix;
    this.#assertPhysicalKeyBudget(this.#prefix);
    this.#readOnly = options.readonly === true;
    this.#retries = storageRetryOptions(options.retries);
    this.#signal = options.signal;
    this.#timeout = options.timeout;
    this.#signedUploadPolicy = signedUploadPolicyAdapterOf(options.adapter);
    this.#signedDownloadPolicy = signedDownloadPolicyAdapterOf(options.adapter);
  }

  get name(): string {
    return this.#name;
  }

  get capabilities() {
    const capabilities = this.#files.capabilities;
    return {
      cacheControl: capabilities.cacheControl,
      delimiter: capabilities.delimiter,
      metadata: capabilities.metadata,
      rangeRead: capabilities.rangeRead,
      resumableUpload: !this.#readOnly && capabilities.multipart,
      serverSideCopy: !this.#readOnly && capabilities.serverSideCopy,
      ...(this.#conditionalCopy !== undefined &&
        !this.#readOnly && {
          ...(this.#conditionalCopy.conditionalCopySource !== undefined && {
            conditionalCopySource: {
              ...this.#conditionalCopy.conditionalCopySource,
            },
          }),
          ...(this.#conditionalCopy.conditionalCopyDestination !==
            undefined && {
            conditionalCopyDestination: {
              ...this.#conditionalCopy.conditionalCopyDestination,
            },
          }),
        }),
      ...(this.#conditionalDelete !== undefined &&
        !this.#readOnly && {
          conditionalDelete: {
            ...this.#conditionalDelete.conditionalDelete,
          },
        }),
      ...(this.#conditionalRead !== undefined && {
        conditionalRead: { ...this.#conditionalRead.conditionalRead },
      }),
      ...(this.#conditionalUpload !== undefined &&
        !this.#readOnly && {
          ...(this.#conditionalUpload.conditionalCreate !== undefined && {
            conditionalCreate: {
              ...this.#conditionalUpload.conditionalCreate,
            },
          }),
          ...(this.#conditionalUpload.conditionalReplace !== undefined && {
            conditionalReplace: {
              ...this.#conditionalUpload.conditionalReplace,
            },
          }),
          ...(this.#conditionalUpload.conditionalMultipartCompletion !==
            undefined && {
            conditionalMultipartCompletion: {
              ...this.#conditionalUpload.conditionalMultipartCompletion,
            },
          }),
        }),
      ...(this.#physicalKey !== undefined && {
        physicalKey: { ...this.#physicalKey.physicalKey },
      }),
      signedDownload: { ...capabilities.signedUrl },
      ...(this.#signedDownloadPolicy !== undefined && {
        signedDownloadPolicy: {
          ...this.#signedDownloadPolicy.signedDownloadPolicy,
        },
      }),
      signedUpload: this.#readOnly ? false : ('runtime' as const),
      ...(this.#signedUploadPolicy !== undefined &&
        !this.#readOnly && {
          signedUploadPolicy: {
            ...this.#signedUploadPolicy.signedUploadPolicy,
          },
        }),
      nativeUploadProgress: !this.#readOnly && capabilities.uploadProgress,
    };
  }

  async upload(
    key: string,
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    this.#assertLogicalKey(key);
    return this.#call(async () =>
      uploadResultOf(
        await this.#files.upload(key, mapBody(body), uploadOptions(options)),
      ),
    );
  }

  uploadConditional(
    key: string,
    body: StorageBody,
    options: StorageConditionalUploadOptions,
  ): Promise<StorageUploadResult> {
    if (this.#readOnly) {
      return Promise.reject(
        new StorageError(
          `Cannot call uploadConditional() on a read-only storage adapter.`,
          {
            code: StorageErrorCode.READ_ONLY,
            key,
            operation: 'upload',
            permanent: true,
          },
        ),
      );
    }
    const adapter = this.#conditionalUpload;
    const capability =
      options.condition.type === 'create'
        ? adapter?.conditionalCreate
        : adapter?.conditionalReplace;
    const multipartRequested =
      options.multipart !== undefined && options.multipart !== false;
    const multipartSupported =
      !multipartRequested ||
      (options.condition.type === 'create'
        ? adapter?.conditionalMultipartCompletion?.create === true
        : adapter?.conditionalMultipartCompletion?.replace === true);
    if (
      adapter === undefined ||
      capability === undefined ||
      !multipartSupported
    ) {
      return Promise.reject(
        new StorageError(
          `Storage adapter "${this.#name}" does not support conditional upload.`,
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key,
            operation: 'upload',
            permanent: true,
          },
        ),
      );
    }
    const mergedOptions = this.#conditionalOptions(options);
    return this.#call(async () => {
      const physicalKey = this.#path(key);
      const result = await adapter.uploadConditional(
        physicalKey,
        mapBody(body),
        mergedOptions,
      );
      if (result.key !== physicalKey) {
        throw new StorageError(
          'Storage adapter returned an unexpected conditional upload key.',
          {
            code: StorageErrorCode.PROVIDER,
            key,
            operation: 'upload',
            permanent: true,
          },
        );
      }
      return { ...result, key };
    });
  }

  async download(
    key: string,
    options?: StorageDownloadOptions,
  ): Promise<StorageObject> {
    this.#assertLogicalKey(key);
    return this.#call(async () => {
      const file = await this.#files.download(key, downloadOptions(options));
      return {
        ...metadataOf(file),
        body: normalizeDownloadStream(file.stream()),
      };
    });
  }

  downloadConditional(
    key: string,
    options: StorageConditionalReadOptions,
  ): Promise<StorageObject> {
    const adapter = this.#conditionalRead;
    if (
      adapter === undefined ||
      (options.condition.etag !== undefined && !adapter.conditionalRead.etag) ||
      (options.condition.version !== undefined &&
        !adapter.conditionalRead.version)
    ) {
      return Promise.reject(
        new StorageError(
          `Storage adapter "${this.#name}" does not support conditional read.`,
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key,
            operation: 'download',
            permanent: true,
          },
        ),
      );
    }
    return this.#call(async () => {
      const physicalKey = this.#path(key);
      const object = await adapter.downloadConditional(
        physicalKey,
        this.#conditionalOptions(options),
      );
      if (object.key !== physicalKey) {
        await object.body.cancel().catch(() => undefined);
        throw new StorageError(
          'Storage adapter returned an unexpected conditional download key.',
          {
            code: StorageErrorCode.PROVIDER,
            key,
            operation: 'download',
            permanent: true,
          },
        );
      }
      return {
        ...object,
        body: normalizeDownloadStream(object.body),
        key,
        name: key.split('/').at(-1) ?? key,
      };
    });
  }

  async head(
    key: string,
    options?: StorageOperationOptions,
  ): Promise<StorageObjectMetadata> {
    this.#assertLogicalKey(key);
    return this.#call(async () =>
      metadataOf(await this.#files.head(key, operationOptions(options))),
    );
  }

  exists(key: string, options?: StorageOperationOptions): Promise<boolean> {
    this.#assertLogicalKey(key);
    return this.#call(() => this.#files.exists(key, operationOptions(options)));
  }

  delete(key: string, options?: StorageOperationOptions): Promise<void> {
    this.#assertLogicalKey(key);
    return this.#call(async () => {
      await this.#files.delete(key, operationOptions(options));
    });
  }

  deleteConditional(
    key: string,
    options: StorageConditionalDeleteOptions,
  ): Promise<void> {
    if (this.#readOnly) {
      return Promise.reject(
        new StorageError(
          `Cannot call deleteConditional() on a read-only storage adapter.`,
          {
            code: StorageErrorCode.READ_ONLY,
            key,
            operation: 'delete',
            permanent: true,
          },
        ),
      );
    }
    const adapter = this.#conditionalDelete;
    if (adapter === undefined || !adapter.conditionalDelete.etag) {
      return Promise.reject(
        new StorageError(
          `Storage adapter "${this.#name}" does not support conditional delete.`,
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key,
            operation: 'delete',
            permanent: true,
          },
        ),
      );
    }
    const mergedOptions = this.#conditionalOptions(options);
    return this.#call(() =>
      adapter.deleteConditional(this.#path(key), mergedOptions),
    );
  }

  copy(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void> {
    this.#assertLogicalKey(sourceKey);
    this.#assertLogicalKey(destinationKey);
    return this.#call(() =>
      this.#files.copy(sourceKey, destinationKey, operationOptions(options)),
    );
  }

  move(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void> {
    this.#assertLogicalKey(sourceKey);
    this.#assertLogicalKey(destinationKey);
    return this.#call(() =>
      this.#files.move(sourceKey, destinationKey, operationOptions(options)),
    );
  }

  promote(
    sourceKey: string,
    destinationKey: string,
    options: StoragePromotionOptions,
  ): Promise<void> {
    const destination = options.destination;
    if (
      destination !== undefined &&
      (typeof destination !== 'object' ||
        destination === null ||
        (destination.type !== 'create' && destination.type !== 'replace'))
    ) {
      return Promise.reject(
        new StorageError('destination.type must be "create" or "replace".', {
          code: StorageErrorCode.INVALID_ARGUMENT,
          key: destinationKey,
          operation: 'promote',
          permanent: true,
        }),
      );
    }
    if (this.#readOnly) {
      return Promise.reject(
        new StorageError(
          `Cannot call promote() on a read-only storage adapter.`,
          {
            code: StorageErrorCode.READ_ONLY,
            key: sourceKey,
            operation: 'promote',
            permanent: true,
          },
        ),
      );
    }
    const adapter = this.#conditionalCopy;
    if (
      adapter === undefined ||
      (options.sourceEtag !== undefined &&
        adapter.conditionalCopySource?.etag !== true) ||
      (options.sourceVersion !== undefined &&
        adapter.conditionalCopySource?.version !== true) ||
      (options.destination?.type === 'create' &&
        adapter.conditionalCopyDestination?.create !== true) ||
      (options.destination?.type === 'replace' &&
        adapter.conditionalCopyDestination?.replace !== true) ||
      (options.destination !== undefined &&
        (options.sourceEtag !== undefined ||
          options.sourceVersion !== undefined) &&
        adapter.conditionalCopyDestination?.atomicWithSource !== true)
    ) {
      return Promise.reject(
        new StorageError(
          `Storage adapter "${this.#name}" does not support conditional promotion.`,
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key: sourceKey,
            operation: 'promote',
            permanent: true,
          },
        ),
      );
    }
    return this.#call(() =>
      adapter.promote(
        this.#path(sourceKey),
        this.#path(destinationKey),
        this.#conditionalOptions(options),
      ),
    );
  }

  async list(options?: StorageListOptions): Promise<StorageListResult> {
    if (options?.prefix !== undefined && options.prefix.length > 0) {
      this.#assertLogicalKey(options.prefix);
    }
    return this.#call(async () => {
      const result = await this.#files.list(listOptions(options));
      return {
        items: result.items.map(metadataOf),
        ...(result.cursor !== undefined && { cursor: result.cursor }),
        ...(result.prefixes !== undefined && {
          prefixes: [...result.prefixes],
        }),
      };
    });
  }

  search(
    pattern: string | RegExp,
    options?: StorageSearchOptions,
  ): AsyncIterable<StorageObjectMetadata> {
    return this.#search(pattern, options);
  }

  async *#search(
    pattern: string | RegExp,
    options?: StorageSearchOptions,
  ): AsyncGenerator<StorageObjectMetadata, void> {
    try {
      if (options?.prefix !== undefined && options.prefix.length > 0) {
        this.#assertLogicalKey(options.prefix);
      }
      for await (const file of this.#files.search(
        pattern,
        searchOptions(options),
      )) {
        yield metadataOf(file);
      }
    } catch (error) {
      throw mapFilesSdkError(error);
    }
  }

  signDownload(
    key: string,
    options?: StorageSignedDownloadOptions,
  ): Promise<string> {
    this.#assertLogicalKey(key);
    return this.#call(() =>
      this.#files.url(key, signedDownloadOptions(options)),
    );
  }

  signUpload(
    key: string,
    options: StorageSignedUploadOptions,
  ): Promise<StorageSignedUpload> {
    this.#assertLogicalKey(key);
    return this.#call(() =>
      this.#files.signedUploadUrl(key, signedUploadOptions(options)),
    );
  }

  async #call<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw mapFilesSdkError(error);
    }
  }

  #path(key: string): string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new StorageError('key must be a non-empty string.', {
        code: StorageErrorCode.INVALID_ARGUMENT,
        permanent: true,
      });
    }
    if (key.includes('\0')) {
      throw new StorageError('key must not contain null bytes.', {
        code: StorageErrorCode.INVALID_ARGUMENT,
        key,
        permanent: true,
      });
    }
    const normalized = key.replace(/^\/+/u, '');
    if (
      normalized
        .split('/')
        .some((segment) => segment === '.' || segment === '..')
    ) {
      throw new StorageError('key must not contain . or .. path segments.', {
        code: StorageErrorCode.INVALID_ARGUMENT,
        key,
        permanent: true,
      });
    }
    const physicalKey =
      this.#prefix.length === 0 ? normalized : `${this.#prefix}/${normalized}`;
    this.#assertPhysicalKeyBudget(physicalKey, key);
    return physicalKey;
  }

  #assertLogicalKey(key: string): void {
    this.#path(key);
  }

  #assertPhysicalKeyBudget(physicalKey: string, logicalKey?: string): void {
    const maxBytes = this.#physicalKey?.physicalKey.maxBytes;
    if (
      maxBytes === undefined ||
      new TextEncoder().encode(physicalKey).byteLength <= maxBytes
    ) {
      return;
    }
    throw new StorageError(
      `The combined storage prefix and key exceed the provider's ${maxBytes}-byte physical-key limit.`,
      {
        code: StorageErrorCode.LIMIT_EXCEEDED,
        ...(logicalKey !== undefined && { key: logicalKey }),
        permanent: true,
      },
    );
  }

  #conditionalOptions<
    Options extends
      | StorageConditionalUploadOptions
      | StorageConditionalDeleteOptions
      | StorageConditionalReadOptions
      | StoragePromotionOptions,
  >(options: Options): Options {
    return {
      ...options,
      ...(options.retries === undefined &&
        this.#retries !== undefined && { retries: this.#retries }),
      ...(options.signal === undefined &&
        this.#signal !== undefined && { signal: this.#signal }),
      ...(options.timeout === undefined &&
        this.#timeout !== undefined && { timeout: this.#timeout }),
    };
  }
}

export function createFilesSdkDriver<AdapterType extends Adapter>(
  options: FilesSdkDriverOptions<AdapterType>,
): FilesSdkStorageDriver<AdapterType> {
  return new FilesSdkStorageDriver(options);
}

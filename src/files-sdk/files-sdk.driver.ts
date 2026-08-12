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
  StorageConditionalDeleteOptions,
  StorageConditionalMutationCapability,
  StorageConditionalUploadOptions,
  StorageDownloadOptions,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StorageOperationOptions,
  StorageConditionalCopyCapability,
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
  readonly conditionalCopy: StorageConditionalCopyCapability;
  promote(
    sourceKey: string,
    destinationKey: string,
    options: StoragePromotionOptions,
  ): Promise<void>;
}

/** Optional adapter extension for native compare-and-set mutations. */
export interface FilesSdkConditionalMutationAdapter {
  readonly conditionalMutation: StorageConditionalMutationCapability;
  uploadConditional(
    key: string,
    body: Body,
    options: StorageConditionalUploadOptions,
  ): Promise<StorageUploadResult>;
  deleteConditional(
    key: string,
    options: StorageConditionalDeleteOptions,
  ): Promise<void>;
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
    !('conditionalCopy' in adapter) ||
    !('promote' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalCopyAdapter>;
  const capability = candidate.conditionalCopy;
  if (
    capability === undefined ||
    typeof capability.supported !== 'boolean' ||
    typeof capability.etag !== 'boolean' ||
    typeof capability.version !== 'boolean' ||
    typeof candidate.promote !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalCopyAdapter;
}

function conditionalMutationAdapterOf(
  adapter: Adapter,
): FilesSdkConditionalMutationAdapter | undefined {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    !('conditionalMutation' in adapter) ||
    !('uploadConditional' in adapter) ||
    !('deleteConditional' in adapter)
  ) {
    return undefined;
  }
  const candidate = adapter as Adapter &
    Partial<FilesSdkConditionalMutationAdapter>;
  const capability = candidate.conditionalMutation;
  if (
    capability === undefined ||
    typeof capability.create !== 'boolean' ||
    typeof capability.replace !== 'boolean' ||
    typeof capability.delete !== 'boolean' ||
    typeof capability.etag !== 'boolean' ||
    typeof candidate.uploadConditional !== 'function' ||
    typeof candidate.deleteConditional !== 'function'
  ) {
    return undefined;
  }
  return candidate as Adapter & FilesSdkConditionalMutationAdapter;
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
  readonly #conditionalMutation: FilesSdkConditionalMutationAdapter | undefined;
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
    this.#conditionalMutation = conditionalMutationAdapterOf(options.adapter);
    this.#prefix = this.#files.prefix;
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
      resumableUpload: capabilities.multipart,
      serverSideCopy: capabilities.serverSideCopy,
      ...(this.#conditionalCopy !== undefined && {
        conditionalCopy: { ...this.#conditionalCopy.conditionalCopy },
      }),
      ...(this.#conditionalMutation !== undefined &&
        !this.#readOnly && {
          conditionalMutation: {
            ...this.#conditionalMutation.conditionalMutation,
          },
        }),
      signedDownload: { ...capabilities.signedUrl },
      ...(this.#signedDownloadPolicy !== undefined && {
        signedDownloadPolicy: {
          ...this.#signedDownloadPolicy.signedDownloadPolicy,
        },
      }),
      signedUpload: 'runtime' as const,
      ...(this.#signedUploadPolicy !== undefined && {
        signedUploadPolicy: { ...this.#signedUploadPolicy.signedUploadPolicy },
      }),
      nativeUploadProgress: capabilities.uploadProgress,
    };
  }

  async upload(
    key: string,
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
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
    const adapter = this.#conditionalMutation;
    if (adapter === undefined) {
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
    return this.#call(async () => {
      const file = await this.#files.download(key, downloadOptions(options));
      return {
        ...metadataOf(file),
        body: normalizeDownloadStream(file.stream()),
      };
    });
  }

  async head(
    key: string,
    options?: StorageOperationOptions,
  ): Promise<StorageObjectMetadata> {
    return this.#call(async () =>
      metadataOf(await this.#files.head(key, operationOptions(options))),
    );
  }

  exists(key: string, options?: StorageOperationOptions): Promise<boolean> {
    return this.#call(() => this.#files.exists(key, operationOptions(options)));
  }

  delete(key: string, options?: StorageOperationOptions): Promise<void> {
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
    const adapter = this.#conditionalMutation;
    if (adapter === undefined) {
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
    return this.#call(() =>
      this.#files.copy(sourceKey, destinationKey, operationOptions(options)),
    );
  }

  move(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void> {
    return this.#call(() =>
      this.#files.move(sourceKey, destinationKey, operationOptions(options)),
    );
  }

  promote(
    sourceKey: string,
    destinationKey: string,
    options: StoragePromotionOptions,
  ): Promise<void> {
    const adapter = this.#conditionalCopy;
    if (adapter === undefined || !adapter.conditionalCopy.supported) {
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
      adapter.promote(sourceKey, destinationKey, options),
    );
  }

  async list(options?: StorageListOptions): Promise<StorageListResult> {
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
    return this.#call(() =>
      this.#files.url(key, signedDownloadOptions(options)),
    );
  }

  signUpload(
    key: string,
    options: StorageSignedUploadOptions,
  ): Promise<StorageSignedUpload> {
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
    if (this.#prefix.length === 0) {
      return key;
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
    return `${this.#prefix}/${normalized}`;
  }

  #conditionalOptions<
    Options extends
      StorageConditionalUploadOptions | StorageConditionalDeleteOptions,
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

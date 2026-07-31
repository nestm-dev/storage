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

import { StorageError, StorageErrorCode } from '../storage.error.js';
import type { StorageDriver } from '../storage.driver.js';
import type {
  StorageBody,
  StorageDownloadOptions,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StorageOperationOptions,
  StorageRetryOptions,
  StorageSearchOptions,
  StorageSignedDownloadOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StorageUploadOptions,
  StorageUploadResult,
} from '../storage.types.js';
import { getFilesSdkUploadControl } from '../storage-upload-control.js';

export type FilesSdkDriverOptions<AdapterType extends Adapter> =
  FilesOptions<AdapterType>;

function mapFilesError(error: unknown): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  if (!(error instanceof FilesError)) {
    return new StorageError(
      error instanceof Error ? error.message : String(error),
      {
        cause: error,
        code: StorageErrorCode.PROVIDER,
      },
    );
  }

  if (error.cause instanceof StorageError) {
    return error.cause;
  }

  let code: StorageErrorCode;
  if (error.timedOut) {
    code = StorageErrorCode.TIMEOUT;
  } else if (error.aborted) {
    code = StorageErrorCode.ABORTED;
  } else {
    switch (error.code) {
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
          error.message,
        )
          ? StorageErrorCode.NOT_SUPPORTED
          : StorageErrorCode.PROVIDER;
        break;
    }
  }

  return new StorageError(error.message, {
    aborted: error.aborted,
    cause: error.cause ?? error,
    code,
    permanent: error.permanent,
    timedOut: error.timedOut,
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
          error: mapFilesError(error),
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
        throw mapFilesError(error);
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
        controller.error(mapFilesError(error));
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

  constructor(options: FilesSdkDriverOptions<AdapterType>) {
    this.#files = new Files(options);
    this.#name = options.adapter.name;
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
      signedDownload: { ...capabilities.signedUrl },
      signedUpload: 'runtime' as const,
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
      throw mapFilesError(error);
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
      throw mapFilesError(error);
    }
  }
}

export function createFilesSdkDriver<AdapterType extends Adapter>(
  options: FilesSdkDriverOptions<AdapterType>,
): FilesSdkStorageDriver<AdapterType> {
  return new FilesSdkStorageDriver(options);
}

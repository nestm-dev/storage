import { settleMany } from './internal/settle-many.js';
import {
  StorageError,
  StorageErrorCode,
  normalizeStorageError,
} from './storage.error.js';
import type { StorageDriver } from './storage.driver.js';
import type {
  StorageBody,
  StorageBufferedDownloadOptions,
  StorageBulkOptions,
  StorageCapabilities,
  StorageDeleteManyResult,
  StorageDownloadManyResult,
  StorageDownloadOptions,
  StorageExistsManyResult,
  StorageHeadManyResult,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StorageOperationContext,
  StorageOperationOptions,
  StoragePlugin,
  StorageSearchOptions,
  StorageSignedDownloadOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StorageUploadManyItem,
  StorageUploadManyOptions,
  StorageUploadManyResult,
  StorageUploadOptions,
  StorageUploadResult,
} from './storage.types.js';

export const DEFAULT_BUFFER_LIMIT = 10 * 1024 * 1024;

type BulkOperationOptions = StorageBulkOptions & StorageOperationOptions;
type DownloadManyOptions = StorageBulkOptions & StorageDownloadOptions;

function assertKey(key: string, label = 'key'): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new StorageError(`${label} must be a non-empty string.`, {
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
  }
}

function invalidArgument(message: string): never {
  throw new StorageError(message, {
    code: StorageErrorCode.INVALID_ARGUMENT,
    permanent: true,
  });
}

function assertPositiveSafeInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    invalidArgument(`${label} must be a positive safe integer.`);
  }
}

function assertDownloadOptions(options?: StorageDownloadOptions): void {
  const range = options?.range;
  if (range === undefined) {
    return;
  }
  if (!Number.isSafeInteger(range.start) || range.start < 0) {
    invalidArgument('range.start must be a non-negative safe integer.');
  }
  if (
    range.end !== undefined &&
    (!Number.isSafeInteger(range.end) || range.end < range.start)
  ) {
    invalidArgument(
      'range.end must be a safe integer greater than or equal to range.start.',
    );
  }
}

function assertListOptions(options?: StorageListOptions): void {
  if (options?.delimiter !== undefined && options.delimiter.length === 0) {
    invalidArgument('delimiter must be a non-empty string.');
  }
  assertPositiveSafeInteger(options?.limit, 'limit');
}

function assertSearchOptions(options?: StorageSearchOptions): void {
  assertPositiveSafeInteger(options?.limit, 'limit');
  assertPositiveSafeInteger(options?.maxResults, 'maxResults');
}

function assertSignedUploadOptions(options: StorageSignedUploadOptions): void {
  assertPositiveSafeInteger(options.expiresIn, 'expiresIn');
  assertPositiveSafeInteger(options.maxSize, 'maxSize');
  if (
    options.minSize !== undefined &&
    (!Number.isSafeInteger(options.minSize) || options.minSize < 0)
  ) {
    invalidArgument('minSize must be a non-negative safe integer.');
  }
  if (
    options.minSize !== undefined &&
    options.maxSize !== undefined &&
    options.minSize > options.maxSize
  ) {
    invalidArgument('minSize cannot be greater than maxSize.');
  }
}

function operationOptions(
  options?: BulkOperationOptions,
): StorageOperationOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...(options.retries !== undefined && { retries: options.retries }),
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.timeout !== undefined && { timeout: options.timeout }),
  };
}

function downloadOptions(
  options?: DownloadManyOptions,
): StorageDownloadOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...operationOptions(options),
    ...(options.range !== undefined && { range: options.range }),
  };
}

async function collectBody(
  object: StorageObject,
  maxBytes: number,
): Promise<Uint8Array> {
  if (maxBytes !== Infinity && (!Number.isFinite(maxBytes) || maxBytes < 0)) {
    await object.body.cancel().catch(() => undefined);
    throw new StorageError(
      'maxBytes must be a non-negative finite number or Infinity.',
      {
        code: StorageErrorCode.INVALID_ARGUMENT,
        key: object.key,
        permanent: true,
      },
    );
  }

  if (maxBytes !== Infinity && object.size > maxBytes) {
    await object.body.cancel().catch(() => undefined);
    throw new StorageError(
      `Object "${object.key}" is ${object.size} bytes, exceeding the ${maxBytes}-byte buffer limit.`,
      {
        code: StorageErrorCode.LIMIT_EXCEEDED,
        key: object.key,
        permanent: true,
      },
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = object.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (maxBytes !== Infinity && total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new StorageError(
          `Object "${object.key}" exceeded the ${maxBytes}-byte buffer limit while downloading.`,
          {
            code: StorageErrorCode.LIMIT_EXCEEDED,
            key: object.key,
            permanent: true,
          },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface StorageFileHandle {
  readonly key: string;
  upload(
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult>;
  download(options?: StorageDownloadOptions): Promise<StorageObject>;
  bytes(options?: StorageBufferedDownloadOptions): Promise<Uint8Array>;
  text(options?: StorageBufferedDownloadOptions): Promise<string>;
  head(options?: StorageOperationOptions): Promise<StorageObjectMetadata>;
  exists(options?: StorageOperationOptions): Promise<boolean>;
  delete(options?: StorageOperationOptions): Promise<void>;
  signDownload(options?: StorageSignedDownloadOptions): Promise<string>;
  signUpload(options: StorageSignedUploadOptions): Promise<StorageSignedUpload>;
  copyTo(
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void>;
  moveTo(
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void>;
}

export class StorageClient {
  readonly #driver: StorageDriver;
  readonly #plugins: readonly StoragePlugin[];
  #closed = false;

  constructor(
    readonly name: string,
    driver: StorageDriver,
    plugins: readonly StoragePlugin[] = [],
  ) {
    assertKey(name, 'store name');
    this.#driver = driver;
    this.#plugins = [...plugins];
  }

  get driverName(): string {
    return this.#driver.name;
  }

  get capabilities(): Readonly<StorageCapabilities> {
    return this.#driver.capabilities;
  }

  file(key: string): StorageFileHandle {
    assertKey(key);
    return {
      copyTo: (destinationKey, options) =>
        this.copy(key, destinationKey, options),
      delete: (options) => this.delete(key, options),
      download: (options) => this.downloadStream(key, options),
      exists: (options) => this.exists(key, options),
      head: (options) => this.head(key, options),
      key,
      moveTo: (destinationKey, options) =>
        this.move(key, destinationKey, options),
      signDownload: (options) => this.signDownload(key, options),
      signUpload: (options) => this.signUpload(key, options),
      bytes: (options) => this.downloadBytes(key, options),
      text: (options) => this.downloadText(key, options),
      upload: (body, options) => this.upload(key, body, options),
    };
  }

  upload(
    key: string,
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult> {
    assertKey(key);
    return this.#execute({ key, operation: 'upload', store: this.name }, () =>
      this.#driver.upload(key, body, options),
    );
  }

  downloadStream(
    key: string,
    options?: StorageDownloadOptions,
  ): Promise<StorageObject> {
    assertKey(key);
    assertDownloadOptions(options);
    return this.#execute({ key, operation: 'download', store: this.name }, () =>
      this.#driver.download(key, options),
    );
  }

  async downloadBytes(
    key: string,
    options?: StorageBufferedDownloadOptions,
  ): Promise<Uint8Array> {
    const { maxBytes = DEFAULT_BUFFER_LIMIT, ...download } = options ?? {};
    const object = await this.downloadStream(key, download);
    return collectBody(object, maxBytes);
  }

  async downloadText(
    key: string,
    options?: StorageBufferedDownloadOptions,
  ): Promise<string> {
    return new TextDecoder().decode(await this.downloadBytes(key, options));
  }

  async downloadJson<Result = unknown>(
    key: string,
    options?: StorageBufferedDownloadOptions,
  ): Promise<Result> {
    const text = await this.downloadText(key, options);
    try {
      return JSON.parse(text) as Result;
    } catch (error) {
      throw new StorageError(`Object "${key}" does not contain valid JSON.`, {
        cause: error,
        code: StorageErrorCode.INVALID_ARGUMENT,
        key,
        operation: 'download',
        permanent: true,
        store: this.name,
      });
    }
  }

  head(
    key: string,
    options?: StorageOperationOptions,
  ): Promise<StorageObjectMetadata> {
    assertKey(key);
    return this.#execute({ key, operation: 'head', store: this.name }, () =>
      this.#driver.head(key, options),
    );
  }

  exists(key: string, options?: StorageOperationOptions): Promise<boolean> {
    assertKey(key);
    return this.#execute({ key, operation: 'exists', store: this.name }, () =>
      this.#driver.exists(key, options),
    );
  }

  delete(key: string, options?: StorageOperationOptions): Promise<void> {
    assertKey(key);
    return this.#execute({ key, operation: 'delete', store: this.name }, () =>
      this.#driver.delete(key, options),
    );
  }

  copy(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void> {
    assertKey(sourceKey, 'source key');
    assertKey(destinationKey, 'destination key');
    return this.#execute(
      {
        from: sourceKey,
        operation: 'copy',
        store: this.name,
        to: destinationKey,
      },
      () => this.#driver.copy(sourceKey, destinationKey, options),
    );
  }

  move(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void> {
    assertKey(sourceKey, 'source key');
    assertKey(destinationKey, 'destination key');
    return this.#execute(
      {
        from: sourceKey,
        operation: 'move',
        store: this.name,
        to: destinationKey,
      },
      () => this.#driver.move(sourceKey, destinationKey, options),
    );
  }

  list(options?: StorageListOptions): Promise<StorageListResult> {
    assertListOptions(options);
    return this.#execute({ operation: 'list', store: this.name }, () =>
      this.#driver.list(options),
    );
  }

  async *listAll(
    options?: StorageListOptions,
  ): AsyncGenerator<StorageObjectMetadata, void> {
    const { delimiter: _delimiter, ...walkOptions } = options ?? {};
    void _delimiter;
    let cursor = walkOptions.cursor;
    const seen = new Set<string>();

    do {
      const page = await this.list({
        ...walkOptions,
        ...(cursor !== undefined && { cursor }),
      });
      yield* page.items;
      cursor = page.cursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) {
          throw new StorageError(
            `Store "${this.name}" returned a repeated pagination cursor.`,
            {
              code: StorageErrorCode.PROVIDER,
              operation: 'list',
              permanent: true,
              store: this.name,
            },
          );
        }
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  }

  search(
    pattern: string | RegExp,
    options?: StorageSearchOptions,
  ): AsyncIterable<StorageObjectMetadata> {
    assertSearchOptions(options);
    return this.#search(pattern, options);
  }

  async *#search(
    pattern: string | RegExp,
    options?: StorageSearchOptions,
  ): AsyncGenerator<StorageObjectMetadata, void> {
    const context: StorageOperationContext = {
      operation: 'search',
      store: this.name,
    };
    try {
      for (const plugin of this.#plugins) {
        await plugin.beforeOperation?.(context);
      }
      for await (const object of this.#driver.search(pattern, options)) {
        yield object;
      }
      for (const plugin of this.#plugins) {
        await plugin.afterOperation?.(context, undefined);
      }
    } catch (error) {
      const normalized = normalizeStorageError(error, {
        operation: 'search',
        store: this.name,
      });
      for (const plugin of this.#plugins) {
        try {
          await plugin.onError?.(context, normalized);
        } catch {
          // Preserve the original storage error.
        }
      }
      throw normalized;
    }
  }

  signDownload(
    key: string,
    options?: StorageSignedDownloadOptions,
  ): Promise<string> {
    assertKey(key);
    return this.#execute(
      { key, operation: 'signDownload', store: this.name },
      () => this.#driver.signDownload(key, options),
    );
  }

  signUpload(
    key: string,
    options: StorageSignedUploadOptions,
  ): Promise<StorageSignedUpload> {
    assertKey(key);
    assertSignedUploadOptions(options);
    return this.#execute(
      { key, operation: 'signUpload', store: this.name },
      () => this.#driver.signUpload(key, options),
    );
  }

  async uploadMany(
    items: readonly StorageUploadManyItem[],
    options?: StorageUploadManyOptions,
  ): Promise<StorageUploadManyResult> {
    const settled = await settleMany(
      items,
      (item) => item.key,
      (item) =>
        this.upload(item.key, item.body, {
          ...operationOptions(options),
          ...(item.cacheControl !== undefined && {
            cacheControl: item.cacheControl,
          }),
          ...(item.contentType !== undefined && {
            contentType: item.contentType,
          }),
          ...(item.metadata !== undefined && { metadata: item.metadata }),
          ...(item.multipart !== undefined && {
            multipart: item.multipart,
          }),
          ...(options?.onProgress !== undefined && {
            onProgress: (progress) =>
              options.onProgress?.({ ...progress, key: item.key }),
          }),
        }),
      options,
    );

    return {
      uploaded: settled.results,
      ...(settled.errors.length > 0 && { errors: settled.errors }),
    };
  }

  async downloadMany(
    keys: readonly string[],
    options?: DownloadManyOptions,
  ): Promise<StorageDownloadManyResult> {
    const settled = await settleMany(
      keys,
      (key) => key,
      (key) => this.downloadStream(key, downloadOptions(options)),
      options,
    );
    return {
      downloaded: settled.results,
      ...(settled.errors.length > 0 && { errors: settled.errors }),
    };
  }

  async headMany(
    keys: readonly string[],
    options?: BulkOperationOptions,
  ): Promise<StorageHeadManyResult> {
    const settled = await settleMany(
      keys,
      (key) => key,
      (key) => this.head(key, operationOptions(options)),
      options,
    );
    return {
      objects: settled.results,
      ...(settled.errors.length > 0 && { errors: settled.errors }),
    };
  }

  async existsMany(
    keys: readonly string[],
    options?: BulkOperationOptions,
  ): Promise<StorageExistsManyResult> {
    const settled = await settleMany(
      keys,
      (key) => key,
      async (key) => ({ exists: await this.exists(key, options), key }),
      options,
    );
    const existing: string[] = [];
    const missing: string[] = [];
    for (const result of settled.results) {
      (result.exists ? existing : missing).push(result.key);
    }
    return {
      existing,
      missing,
      ...(settled.errors.length > 0 && { errors: settled.errors }),
    };
  }

  async deleteMany(
    keys: readonly string[],
    options?: BulkOperationOptions,
  ): Promise<StorageDeleteManyResult> {
    const settled = await settleMany(
      keys,
      (key) => key,
      async (key) => {
        await this.delete(key, operationOptions(options));
        return key;
      },
      options,
    );
    return {
      deleted: settled.results,
      ...(settled.errors.length > 0 && { errors: settled.errors }),
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#driver.close?.();
  }

  async #execute<Result>(
    context: StorageOperationContext,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      for (const plugin of this.#plugins) {
        await plugin.beforeOperation?.(context);
      }
      const result = await operation();
      for (const plugin of this.#plugins) {
        await plugin.afterOperation?.(context, result);
      }
      return result;
    } catch (error) {
      const normalized = normalizeStorageError(error, {
        ...(context.key !== undefined && { key: context.key }),
        operation: context.operation,
        store: this.name,
      });
      for (const plugin of this.#plugins) {
        try {
          await plugin.onError?.(context, normalized);
        } catch {
          // Preserve the original storage error.
        }
      }
      throw normalized;
    }
  }
}

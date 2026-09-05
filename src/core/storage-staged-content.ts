import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from '../storage.error.js';
import type { StorageClient } from '../storage.client.js';
import type { StorageByteRange } from '../storage.types.js';
import { storageInteger } from './storage-streams.js';

export interface StorageStagedBody {
  readonly payloadId: string;
  readonly size: number;
  readonly sha256: string;
  readonly etag: string;
}
export interface StorageStagedWriteOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxBytes?: number | undefined;
}
export interface StorageStagedReadOptions {
  readonly signal?: AbortSignal | undefined;
  readonly range?: StorageByteRange | undefined;
}
export interface StorageStagedContent<Scope> {
  write(
    scope: Scope,
    body: ReadableStream<Uint8Array>,
    options?: StorageStagedWriteOptions,
  ): Promise<StorageStagedBody>;
  read(
    scope: Scope,
    body: StorageStagedBody,
    options?: StorageStagedReadOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}
export interface StorageStagedContentStoreOptions<Scope> {
  readonly client: StorageClient;
  /** Trusted, injective scope mapping; never accept this function from a model. */
  readonly key: (scope: Scope, payloadId: string) => string;
}

/** Immutable create-only bodies. Retention eligibility and references remain host-owned. */
export class StorageStagedContentStore<
  Scope,
> implements StorageStagedContent<Scope> {
  readonly #client: StorageClient;
  readonly #key: (scope: Scope, payloadId: string) => string;
  constructor(options: StorageStagedContentStoreOptions<Scope>) {
    this.#client = options.client;
    this.#key = options.key;
  }
  async write(
    scope: Scope,
    body: ReadableStream<Uint8Array>,
    options: StorageStagedWriteOptions = {},
  ): Promise<StorageStagedBody> {
    const { signal } = options;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    storageInteger(maxBytes, 'maxBytes');
    const capabilities = this.#client.capabilities;
    if (
      !capabilities.conditionalCreate?.resultEtag ||
      !capabilities.conditionalRead?.etag
    ) {
      await body.cancel().catch(() => {});
      throw new StorageError(
        'Staged content requires native create-only writes and exact ETag reads.',
        { code: 'NOT_SUPPORTED' },
      );
    }
    const payloadId = randomUUID();
    const hash = createHash('sha256');
    let size = 0;
    let completed = false;
    const measured = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          signal?.throwIfAborted();
          size += chunk.byteLength;
          if (!Number.isSafeInteger(size) || size > maxBytes)
            throw new StorageError('Staged body exceeds its byte budget.', {
              code: 'LIMIT_EXCEEDED',
            });
          hash.update(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          completed = true;
        },
      }),
      signal === undefined ? {} : { signal },
    );
    try {
      signal?.throwIfAborted();
      const result = await this.#client.uploadConditional(
        this.#key(scope, payloadId),
        measured,
        {
          condition: { type: 'create' },
          contentType: 'application/octet-stream',
          retries: 0,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!completed || result.size !== size || result.etag === undefined)
        throw new StorageError(
          'Provider did not acknowledge the complete staged body.',
          { code: 'PROVIDER', applied: true },
        );
      return Object.freeze({
        payloadId,
        size,
        sha256: hash.digest('hex'),
        etag: result.etag,
      });
    } catch (error) {
      await measured.cancel(error).catch(() => {});
      throw error;
    }
  }
  async read(
    scope: Scope,
    body: StorageStagedBody,
    options: StorageStagedReadOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    validateBody(body);
    options.signal?.throwIfAborted();
    if (options.range !== undefined && !this.#client.capabilities.rangeRead)
      throw new StorageError('Provider does not support byte ranges.', {
        code: 'NOT_SUPPORTED',
      });
    const result = await this.#client.downloadConditional(
      this.#key(scope, body.payloadId),
      {
        condition: { etag: body.etag },
        ...(options.range === undefined ? {} : { range: options.range }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return result.body;
  }
  /** Host must prove no durable/in-flight reference can be created before removal. */
  async remove(
    scope: Scope,
    body: StorageStagedBody,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<void> {
    validateBody(body);
    await this.#client.deleteConditional(this.#key(scope, body.payloadId), {
      condition: { etag: body.etag },
      ...options,
    });
  }
}
function validateBody(body: StorageStagedBody): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      body.payloadId,
    ) ||
    !/^[0-9a-f]{64}$/u.test(body.sha256)
  )
    throw new StorageError('Invalid staged body receipt.', {
      code: 'INVALID_ARGUMENT',
    });
  storageInteger(body.size, 'size');
}

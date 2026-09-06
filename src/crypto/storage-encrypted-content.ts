import { createHash, randomUUID } from 'node:crypto';
import {
  type FileCipherEngine,
  nmf1EncryptedFileSize,
  NMF1_FORMAT_MAX_PLAINTEXT_BYTES,
  type DetachedFileKey,
  type FileEncryptResult,
} from '@nestm/crypto/files';
import { StorageError } from '../storage.error.js';
import type { StorageClient } from '../storage.client.js';
import {
  StorageStagedContentStore,
  type StorageStagedContent,
  type StorageStagedBody,
  type StorageStagedReadOptions,
  type StorageStagedWriteOptions,
} from '../core/storage-staged-content.js';
import { storageBytesStream, storageInteger } from '../core/storage-streams.js';

/** Detached encryption metadata. Hosts own serialization, key policy and access control. */
export interface StorageEncryptedContentProtection {
  readonly headerBytes: Uint8Array;
  readonly detachedKey: DetachedFileKey;
  readonly wrappingContextDigest: string;
}
export interface StorageEncryptedContentRecord {
  readonly id: string;
  readonly protection: StorageEncryptedContentProtection;
  readonly ciphertextBody: StorageStagedBody;
  readonly size: number;
  readonly contentDigest: string;
}
export interface StorageEncryptedContentPersistence<Scope> {
  /** Atomic create-only reservation; persist before consuming any ciphertext. */
  prepare(
    scope: Scope,
    id: string,
    protection: StorageEncryptedContentProtection,
  ): Promise<void>;
  /** Atomically make the prepared body readable after both streams acknowledge completion. */
  complete(scope: Scope, record: StorageEncryptedContentRecord): Promise<void>;
  require(scope: Scope, id: string): Promise<StorageEncryptedContentRecord>;
  /**
   * Retire only after proving reference eligibility, then clean the exact object.
   * An absent receipt means upload completion may be uncertain: retain cleanup inventory.
   * Called only after this writer successfully prepared its fresh identity.
   */
  discard(
    scope: Scope,
    id: string,
    ciphertextBody?: StorageStagedBody,
  ): Promise<void>;
}
export interface StorageEncryptedContentStoreOptions<Scope> {
  readonly client: StorageClient;
  /** Caller owns the engine and its shutdown lifecycle. */
  readonly cipher: FileCipherEngine;
  readonly key: (scope: Scope, payloadId: string) => string;
  /** Return a fresh context buffer; this store clears it after the engine copies it. */
  readonly aad: (scope: Scope, payloadId: string) => Uint8Array;
  readonly allowedProviders: readonly string[];
  readonly provider?: string;
  readonly metadata: StorageEncryptedContentPersistence<Scope>;
}

/** Coordinates immutable ciphertext I/O and authenticated plaintext accounting. */
export class StorageEncryptedContentStore<
  Scope,
> implements StorageStagedContent<Scope> {
  readonly #options: StorageEncryptedContentStoreOptions<Scope>;
  readonly #ciphertext: StorageStagedContentStore<Scope>;
  constructor(options: StorageEncryptedContentStoreOptions<Scope>) {
    this.#options = {
      ...options,
      allowedProviders: Object.freeze([...options.allowedProviders]),
    };
    this.#ciphertext = new StorageStagedContentStore({
      client: options.client,
      key: options.key,
    });
  }

  async write(
    scope: Scope,
    body: ReadableStream<Uint8Array>,
    options: StorageStagedWriteOptions = {},
  ): Promise<StorageStagedBody> {
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    storageInteger(maxBytes, 'maxBytes');
    const signal = options.signal;
    signal?.throwIfAborted();
    const controller = new AbortController();
    const writeSignal =
      signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal]);
    const id = randomUUID();
    const hash = createHash('sha256');
    let plaintextSize = 0;
    const plaintext = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) {
          plaintextSize += chunk.byteLength;
          if (!Number.isSafeInteger(plaintextSize) || plaintextSize > maxBytes)
            throw new StorageError(
              'Encrypted content exceeds its byte budget.',
              { code: 'LIMIT_EXCEEDED' },
            );
          hash.update(chunk);
          stream.enqueue(chunk);
        },
      }),
      { signal: writeSignal },
    );
    let encryption: FileEncryptResult | undefined;
    let upload: Promise<StorageStagedBody> | undefined;
    let stored: StorageStagedBody | undefined;
    let prepared = false;
    let aad: Uint8Array | undefined;
    try {
      aad = this.#options.aad(scope, id);
      encryption = await this.#options.cipher.encrypt(plaintext, {
        aad,
        ...(this.#options.provider === undefined
          ? {}
          : { provider: this.#options.provider }),
        signal: writeSignal,
      });
      const protection = {
        headerBytes: encryption.headerBytes,
        detachedKey: encryption.detachedKey,
        wrappingContextDigest: encryption.wrappingContextDigest,
      };
      await this.#options.metadata.prepare(scope, id, protection);
      prepared = true;
      writeSignal.throwIfAborted();
      const maximum = nmf1EncryptedFileSize(
        BigInt(maxBytes) < NMF1_FORMAT_MAX_PLAINTEXT_BYTES
          ? BigInt(maxBytes)
          : NMF1_FORMAT_MAX_PLAINTEXT_BYTES,
      );
      if (maximum > BigInt(Number.MAX_SAFE_INTEGER))
        throw new StorageError('Ciphertext exceeds safe storage accounting.', {
          code: 'INVALID_ARGUMENT',
        });
      upload = this.#ciphertext
        .writeReserved(scope, id, encryption.encrypted, {
          signal: writeSignal,
          maxBytes: Number(maximum),
        })
        .then((receipt) => {
          stored = receipt;
          return receipt;
        });
      const [ciphertext, summary] = await Promise.all([
        upload,
        encryption.completion,
      ]);
      signal?.throwIfAborted();
      const size = Number(summary.plaintextBytes);
      if (
        !Number.isSafeInteger(size) ||
        size !== plaintextSize ||
        size > maxBytes ||
        summary.ciphertextBytes !== BigInt(ciphertext.size) ||
        summary.ciphertextSha256 !== ciphertext.sha256
      )
        throw new StorageError(
          'The encrypted body was not fully acknowledged.',
          { code: 'PROVIDER' },
        );
      const contentDigest = hash.digest('hex');
      await this.#options.metadata.complete(scope, {
        id,
        protection,
        ciphertextBody: ciphertext,
        size,
        contentDigest,
      });
      return Object.freeze({
        payloadId: id,
        size,
        sha256: contentDigest,
        etag: ciphertext.etag,
      });
    } catch (error: unknown) {
      controller.abort(error);
      await encryption?.cancel(error);
      await Promise.allSettled([upload, encryption?.completion]);
      if (prepared)
        await this.#options.metadata
          .discard(scope, id, stored)
          .catch(() => undefined);
      throw protectedFailure(signal);
    } finally {
      aad?.fill(0);
    }
  }

  read(
    scope: Scope,
    expected: StorageStagedBody,
    options?: StorageStagedReadOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.readById(scope, expected.payloadId, options, expected);
  }

  async readById(
    scope: Scope,
    id: string,
    options: StorageStagedReadOptions = {},
    expected?: StorageStagedBody,
  ): Promise<ReadableStream<Uint8Array>> {
    const signal = options.signal;
    let aad: Uint8Array | undefined;
    try {
      signal?.throwIfAborted();
      const record = await this.#options.metadata.require(scope, id);
      if (
        record.id !== id ||
        record.ciphertextBody.payloadId !== id ||
        (expected !== undefined &&
          (expected.etag !== record.ciphertextBody.etag ||
            expected.sha256 !== record.contentDigest ||
            expected.size !== record.size))
      )
        throw new StorageError('The encrypted content receipt changed.', {
          code: 'CONFLICT',
        });
      storageInteger(record.size, 'size');
      aad = this.#options.aad(scope, id);
      const input = {
        aad,
        detachedKey: record.protection.detachedKey,
        allowedProviders: this.#options.allowedProviders,
        expectedHeaderBytes: record.protection.headerBytes,
        expectedPlaintextBytes: BigInt(record.size),
        expectedCiphertextBytes: BigInt(record.ciphertextBody.size),
        ...(signal === undefined ? {} : { signal }),
      };
      if (options.range !== undefined) {
        const start = options.range.start;
        const end = options.range.end ?? record.size - 1;
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(end) ||
          end < start ||
          end >= record.size
        )
          throw new StorageError('The requested content range is invalid.', {
            code: 'INVALID_ARGUMENT',
          });
        const bytes = await this.#options.cipher.decryptRange(
          (range, readSignal) =>
            this.#ciphertext.read(scope, record.ciphertextBody, {
              signal: readSignal,
              range: {
                start: Number(range.start),
                ...(range.end === undefined ? {} : { end: Number(range.end) }),
              },
            }),
          {
            ...input,
            offset: BigInt(start),
            length: end - start + 1,
            maxRangeBytes: end - start + 1,
          },
        );
        return storageBytesStream(bytes);
      }
      const decrypted = await this.#options.cipher.decrypt(
        await this.#ciphertext.read(scope, record.ciphertextBody, options),
        { ...input, expectedCiphertextSha256: record.ciphertextBody.sha256 },
      );
      const hash = createHash('sha256');
      let size = 0;
      return decrypted.plaintext.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, stream) {
            size += chunk.byteLength;
            hash.update(chunk);
            stream.enqueue(chunk);
          },
          async flush() {
            try {
              await decrypted.verification;
              if (
                size !== record.size ||
                hash.digest('hex') !== record.contentDigest
              )
                throw protectedFailure(signal);
            } catch {
              throw protectedFailure(signal);
            }
          },
        }),
        signal === undefined ? {} : { signal },
      );
    } catch (error: unknown) {
      if (
        error instanceof StorageError &&
        ['NOT_FOUND', 'CONFLICT', 'INVALID_ARGUMENT'].includes(error.code)
      )
        throw error;
      throw protectedFailure(signal);
    } finally {
      aad?.fill(0);
    }
  }
}

function protectedFailure(signal?: AbortSignal): StorageError {
  return new StorageError(
    signal?.aborted
      ? 'The encrypted content operation was cancelled.'
      : 'The encrypted content could not be authenticated.',
    { code: signal?.aborted ? 'ABORTED' : 'PROVIDER' },
  );
}

import { Readable } from 'node:stream';
import {
  createStoredFile,
  FilesError,
  type AdapterConditionalOperations,
  type AdapterUploadOptions,
  type Body,
  type ConditionalUploadResult,
} from 'files-sdk';
import { mapAzureError, type AzureAdapter } from 'files-sdk/azure';
import type { FilesSdkPhysicalKeyAdapter } from '../files-sdk.driver.js';
import {
  normalizeProviderStorageEtag,
  storageEtagHeader,
} from '../../storage-etag.js';

/** Native Azure predicates execute inside Files SDK's conditional policy pipeline. */
export function withAzureConditionalOperations(
  adapter: AzureAdapter,
): AzureAdapter & FilesSdkPhysicalKeyAdapter {
  const container = adapter.raw.getContainerClient(adapter.bucket);
  const upload = async (
    key: string,
    body: Body,
    expectedEtag: string | null,
    options?: AdapterUploadOptions,
  ): Promise<ConditionalUploadResult> => {
    const conditions =
      expectedEtag === null
        ? { ifNoneMatch: '*' }
        : { ifMatch: etagHeader(expectedEtag) };
    const contentType =
      options?.contentType ??
      (body instanceof Blob && body.type
        ? body.type
        : 'application/octet-stream');
    let size = 0;
    const reader = bodyStream(body).getReader();
    const node = Readable.from(
      (async function* () {
        for (;;) {
          const next = await reader.read();
          options?.signal?.throwIfAborted();
          if (next.done) break;
          const chunk = next.value;
          size += chunk.byteLength;
          if (!Number.isSafeInteger(size))
            throw new FilesError('Provider', 'Azure upload is too large.');
          // Azure's upload scheduler requires Buffer.copy(), including when
          // the source is a web stream of ordinary Uint8Array chunks.
          yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
      })(),
      { objectMode: false },
    );
    // Destroying the Node stream also cancels the web source, including a source
    // blocked waiting for its next chunk when cancellation arrives.
    const abort = () => {
      void reader.cancel(options?.signal?.reason).catch(() => {});
    };
    options?.signal?.addEventListener('abort', abort, { once: true });
    try {
      options?.signal?.throwIfAborted();
      const result = await container
        .getBlockBlobClient(key)
        .uploadStream(node, 4 * 1024 * 1024, 2, {
          conditions,
          blobHTTPHeaders: {
            blobContentType: contentType,
            ...(options?.cacheControl === undefined
              ? {}
              : { blobCacheControl: options.cacheControl }),
          },
          ...(options?.metadata === undefined
            ? {}
            : { metadata: options.metadata }),
          ...(options?.signal === undefined
            ? {}
            : { abortSignal: options.signal }),
          ...(options?.onProgress === undefined
            ? {}
            : {
                onProgress: ({ loadedBytes }) =>
                  options.onProgress?.({ loaded: loadedBytes }),
              }),
        });
      return {
        key,
        size,
        contentType,
        etag: requiredEtag(result.etag),
        ...(result.lastModified === undefined
          ? {}
          : { lastModified: result.lastModified.getTime() }),
      };
    } catch (error) {
      throw mapAzureError(error);
    } finally {
      options?.signal?.removeEventListener('abort', abort);
      node.destroy();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  const conditional: AdapterConditionalOperations = {
    create: (key, body, options) => upload(key, body, null, options),
    replace: (key, body, etag, options) => upload(key, body, etag, options),
    exactRead: async (key, etag, options) => {
      const ifMatch = etagHeader(etag);
      options?.signal?.throwIfAborted();
      try {
        const range = options?.range;
        const result = await container
          .getBlobClient(key)
          .download(
            range?.start ?? 0,
            range?.end === undefined ? undefined : range.end - range.start + 1,
            {
              conditions: { ifMatch },
              ...(options?.signal === undefined
                ? {}
                : { abortSignal: options.signal }),
            },
          );
        const stream = result.readableStreamBody;
        if (!stream)
          throw new FilesError(
            'Provider',
            'Azure returned no download stream.',
          );
        let returnedEtag: string;
        try {
          returnedEtag = requiredEtag(result.etag);
          if (returnedEtag !== etag)
            throw new FilesError(
              'Conflict',
              'Azure object condition did not match.',
            );
        } catch (error) {
          stream.destroy();
          throw error;
        }
        return createStoredFile(
          {
            key,
            etag: returnedEtag,
            size: result.contentLength ?? 0,
            type: result.contentType ?? 'application/octet-stream',
            ...(result.lastModified === undefined
              ? {}
              : { lastModified: result.lastModified.getTime() }),
            ...(result.metadata === undefined
              ? {}
              : { metadata: result.metadata }),
          },
          {
            kind: 'stream',
            factory: () =>
              Readable.toWeb(
                Readable.from(stream),
              ) as ReadableStream<Uint8Array>,
          },
        );
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    delete: async (key, etag, options) => {
      const ifMatch = etagHeader(etag);
      options?.signal?.throwIfAborted();
      try {
        await container.getBlobClient(key).delete({
          conditions: { ifMatch },
          ...(options?.signal === undefined
            ? {}
            : { abortSignal: options.signal }),
        });
      } catch (error) {
        throw mapAzureError(error);
      }
    },
  };
  return {
    ...adapter,
    conditional: Object.freeze(conditional),
    // A conservative UTF-8 budget within Azure's 1024-character blob-name limit.
    physicalKey: Object.freeze({ maxBytes: 1024 }),
  };
}

function etagHeader(etag: string): string {
  const header = storageEtagHeader(etag);
  if (header === undefined)
    throw new FilesError(
      'Provider',
      'Azure requires one canonical strong ETag.',
    );
  return header;
}

function requiredEtag(value: unknown): string {
  const etag = normalizeProviderStorageEtag(value);
  if (etag === undefined)
    throw new FilesError(
      'Provider',
      'Azure returned no canonical strong ETag.',
    );
  return etag;
}

function bodyStream(body: Body): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  if (body instanceof Blob) return body.stream();
  const bytes =
    typeof body === 'string'
      ? new TextEncoder().encode(body)
      : ArrayBuffer.isView(body)
        ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
        : new Uint8Array(body);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

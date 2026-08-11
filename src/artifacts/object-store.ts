import {
  StorageErrorCode,
  isStorageError,
  type StorageClient,
  type StorageObject,
} from '../core/index.js';

import {
  warnLegacyRead,
  type ReadRef,
  type ScopeRef,
} from './artifact-storage.js';
import {
  open,
  seal,
  type EnvelopeContext,
  type StorageCrypto,
} from './crypto/index.js';
import {
  createObjectStorageClient,
  DEFAULT_OBJECT_NAMESPACES,
  resolveObjectNamespaces,
  type ArtifactStorageConfig,
} from './storage-driver.js';

/**
 * Generic key→bytes object store (not artifact-shaped). Backs org-logo uploads and staged
 * artifact uploads. Objects are CAE1 envelopes like artifact files; the content type lives in
 * the authenticated envelope header on every provider. Filesystem `.ct` sidecars remain read-only
 * compatibility data and are never emitted.
 */
export interface ObjectStore {
  putObject(
    key: string,
    body: Buffer,
    contentType: string,
    ref: ScopeRef,
  ): Promise<void>;
  /** `null` if absent; throws `EnvelopeError` on decrypt failure (never masked as a miss). */
  getObject(
    key: string,
    ref: ReadRef,
  ): Promise<{ body: Buffer; contentType?: string } | null>;
  deleteObject(key: string): Promise<void>;
  /** Delete every object under `prefix` last modified more than `olderThanMs` ago. Returns the count deleted. */
  sweepObjects(prefix: string, olderThanMs: number): Promise<number>;
  /** Keys beginning with `prefix` (store namespace), sorted lexicographically. */
  listObjects(prefix: string): Promise<string[]>;
}

export async function createObjectStore(
  cfg: ArtifactStorageConfig,
  crypto: StorageCrypto,
): Promise<ObjectStore> {
  const client = await createObjectStorageClient(cfg);
  return createObjectStoreWithClient(cfg, crypto, client);
}

/** Framework-neutral domain adapter used by both direct consumers and the Nest composition entry. */
export function createObjectStoreWithClient(
  cfg: ArtifactStorageConfig,
  crypto: StorageCrypto,
  client: StorageClient,
): ObjectStore {
  return new ClientObjectStore(
    client,
    crypto,
    cfg.provider === 'fs',
    cfg.objectNamespaces ?? DEFAULT_OBJECT_NAMESPACES,
  );
}

/**
 * Envelope context for a store object. `path` is the store-relative KEY on every provider —
 * the fs `_objects/` nesting is a driver-level prefix and must never reach the AAD, or two
 * providers would bind ciphertext to different addresses for the same logical object.
 */
function objectCtx(key: string, ref: ScopeRef | ReadRef): EnvelopeContext {
  return {
    scope: ref.scope as string,
    artifactId: null,
    version: ref.version ?? null,
    path: key,
  };
}

function aliasesLegacyFilesystemSidecar(segment: string): boolean {
  let end = segment.length;
  while (
    end > 0 &&
    (segment.charCodeAt(end - 1) === 0x2e ||
      segment.charCodeAt(end - 1) === 0x20)
  ) {
    end--;
  }
  return segment.slice(0, end).toLowerCase().endsWith('.ct');
}

function assertObjectKey(
  key: string,
  namespaces: ReadonlySet<string>,
  filesystemLayout: boolean,
  allowEmpty = false,
): void {
  const firstSegment = key.split(/[/\\]/, 1)[0] ?? '';
  const segments = key.split(/[/\\]/);
  if (allowEmpty && segments.at(-1) === '') segments.pop();
  if (
    (!allowEmpty && key === '') ||
    key.startsWith('/') ||
    key.includes('\0') ||
    (filesystemLayout && segments.some(aliasesLegacyFilesystemSidecar)) ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    ) ||
    (key !== '' && !namespaces.has(firstSegment.toLowerCase()))
  ) {
    throw new Error(`invalid object key: ${key}`);
  }
}

async function collectRawObject(object: StorageObject): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = object.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

interface RawObject {
  raw: Buffer;
  contentType?: string;
}

function isObjectKeyAllowed(
  key: string,
  namespaces: ReadonlySet<string>,
  filesystemLayout: boolean,
): boolean {
  try {
    assertObjectKey(key, namespaces, filesystemLayout);
    return true;
  } catch {
    return false;
  }
}

class ClientObjectStore implements ObjectStore {
  private readonly namespaces: ReadonlySet<string>;

  constructor(
    private readonly client: StorageClient,
    private readonly crypto: StorageCrypto,
    private readonly filesystemLayout: boolean,
    namespaces: readonly string[],
  ) {
    this.namespaces = resolveObjectNamespaces(namespaces);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
    ref: ScopeRef,
  ): Promise<void> {
    assertObjectKey(key, this.namespaces, this.filesystemLayout);
    const sealed = await seal(
      body,
      objectCtx(key, ref),
      this.crypto.keyProvider,
      contentType,
    );
    await this.client.upload(key, sealed, {
      // Real content type rides the authenticated envelope; raw storage remains opaque.
      contentType: 'application/octet-stream',
    });
    if (this.filesystemLayout) await this.client.delete(`${key}.ct`);
  }

  async getObject(
    key: string,
    ref: ReadRef,
  ): Promise<{ body: Buffer; contentType?: string } | null> {
    assertObjectKey(key, this.namespaces, this.filesystemLayout);
    const stored = await this.downloadRaw(this.client, key);
    if (stored === null) return null;
    const out = await open(
      stored.raw,
      objectCtx(key, ref),
      this.crypto.keyProvider,
      this.crypto.allowLegacyPlaintext === undefined
        ? {}
        : { allowLegacyPlaintext: this.crypto.allowLegacyPlaintext },
    );
    let contentType = out.contentType;
    if (out.legacy) {
      warnLegacyRead(this.filesystemLayout ? 'fs-object' : 'object', key);
      if (this.filesystemLayout) {
        contentType = await this.readLegacyFilesystemContentType(key);
      } else {
        contentType = stored.contentType;
      }
    }
    return {
      body: out.plain,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }

  async deleteObject(key: string): Promise<void> {
    assertObjectKey(key, this.namespaces, this.filesystemLayout);
    await this.client.delete(key);
    if (this.filesystemLayout) await this.client.delete(`${key}.ct`);
  }

  async sweepObjects(prefix: string, olderThanMs: number): Promise<number> {
    assertObjectKey(prefix, this.namespaces, this.filesystemLayout, true);
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new RangeError('olderThanMs must be a finite non-negative number');
    }
    const cutoff = Date.now() - olderThanMs;
    let deleted = 0;
    for await (const object of this.client.listAll({ prefix })) {
      if (
        !isObjectKeyAllowed(object.key, this.namespaces, this.filesystemLayout)
      ) {
        continue;
      }
      if (this.filesystemLayout && object.key.toLowerCase().endsWith('.ct'))
        continue;
      if (!isExpired(object.lastModified, cutoff)) continue;
      await this.client.delete(object.key);
      if (this.filesystemLayout) await this.client.delete(`${object.key}.ct`);
      deleted++;
    }
    return deleted;
  }

  async listObjects(prefix: string): Promise<string[]> {
    assertObjectKey(prefix, this.namespaces, this.filesystemLayout, true);
    const keys = new Set<string>();
    for await (const object of this.client.listAll({ prefix })) {
      if (
        !isObjectKeyAllowed(object.key, this.namespaces, this.filesystemLayout)
      ) {
        continue;
      }
      if (this.filesystemLayout && object.key.toLowerCase().endsWith('.ct'))
        continue;
      keys.add(object.key);
    }
    return [...keys].sort();
  }

  private async downloadRaw(
    client: StorageClient,
    key: string,
  ): Promise<RawObject | null> {
    try {
      const object = await client.downloadStream(key);
      const raw = await collectRawObject(object);
      return {
        raw,
        ...(object.contentType === undefined
          ? {}
          : { contentType: object.contentType }),
      };
    } catch (error) {
      if (isStorageError(error) && error.code === StorageErrorCode.NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  private async readLegacyFilesystemContentType(
    key: string,
  ): Promise<string | undefined> {
    try {
      return await this.client.downloadText(`${key}.ct`, {
        maxBytes: 64 * 1024,
      });
    } catch (error) {
      if (isStorageError(error) && error.code === StorageErrorCode.NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
  }
}

function isExpired(lastModified: Date | undefined, cutoff: number): boolean {
  const modifiedAt = lastModified?.getTime();
  // A provider that cannot supply a trustworthy timestamp cannot prove an object is expired.
  return (
    modifiedAt !== undefined &&
    Number.isFinite(modifiedAt) &&
    modifiedAt < cutoff
  );
}

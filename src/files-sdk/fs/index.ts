import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';

import type {
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  StoredFile,
} from 'files-sdk';
import { fs, type FsAdapter, type FsAdapterOptions } from 'files-sdk/fs';

import { StorageError, StorageErrorCode } from '../../storage.error.js';
import type {
  StorageConditionalDeleteOptions,
  StorageConditionalUploadOptions,
  StorageOperationOptions,
  StorageUploadResult,
} from '../../storage.types.js';
import {
  createFilesSdkDriver,
  type FilesSdkConditionalMutationAdapter,
  type FilesSdkDriverOptions,
  type FilesSdkStorageDriver,
} from '../files-sdk.driver.js';

export interface FsStorageDriverOptions extends Omit<
  FilesSdkDriverOptions<FsAdapter>,
  'adapter'
> {
  adapter: FsAdapterOptions;
}

export type FsStorageAdapter = FsAdapter & FilesSdkConditionalMutationAdapter;

const SIDECAR_SUFFIX = '.meta.json';
const TEMP_SUFFIX = '.fls-part';
const MAX_SIDECAR_BYTES = 1024 * 1024;

interface FsSidecar {
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  etag: string;
  lastModified: number;
}

interface OperationRuntime {
  signal: AbortSignal | undefined;
  timeoutSignal: AbortSignal | undefined;
  callerSignal: AbortSignal | undefined;
}

function fsErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

function storageFsError(
  error: unknown,
  key: string,
  operation: 'upload' | 'delete',
): StorageError {
  if (error instanceof StorageError) {
    return error;
  }
  const systemCode = fsErrorCode(error);
  const code =
    systemCode === 'ENOENT' || systemCode === 'ENOTDIR'
      ? StorageErrorCode.NOT_FOUND
      : systemCode === 'EEXIST'
        ? StorageErrorCode.CONFLICT
        : systemCode === 'EACCES' || systemCode === 'EPERM'
          ? StorageErrorCode.UNAUTHORIZED
          : StorageErrorCode.PROVIDER;
  return new StorageError(`Filesystem ${operation} failed for "${key}".`, {
    cause: error,
    code,
    key,
    operation,
    permanent:
      code === StorageErrorCode.NOT_FOUND ||
      code === StorageErrorCode.CONFLICT ||
      code === StorageErrorCode.UNAUTHORIZED,
  });
}

function invalidFsPath(key: string, message: string): never {
  throw new StorageError(`Invalid filesystem storage key: ${message}.`, {
    code: StorageErrorCode.INVALID_ARGUMENT,
    key,
    permanent: true,
  });
}

function strictSegments(key: string): string[] {
  if (key.length === 0 || key.includes('\0')) {
    invalidFsPath(key, 'the key is empty or contains a null byte');
  }
  if (path.isAbsolute(key) || key.includes('\\')) {
    invalidFsPath(key, 'only relative POSIX paths are accepted');
  }
  const segments = key.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    invalidFsPath(key, 'empty, dot, and parent segments are not accepted');
  }
  if (segments.some((segment) => /[. ]$/u.test(segment))) {
    invalidFsPath(key, 'segments ending in a dot or space are not accepted');
  }
  const leaf = segments.at(-1)?.toLowerCase() ?? '';
  if (leaf.endsWith(SIDECAR_SUFFIX) || leaf.endsWith(TEMP_SUFFIX)) {
    invalidFsPath(key, 'the final segment uses a reserved adapter suffix');
  }
  return segments;
}

function symlinkError(key: string): StorageError {
  return new StorageError(
    `Filesystem storage key "${key}" crosses a symbolic link.`,
    {
      code: StorageErrorCode.INVALID_ARGUMENT,
      key,
      permanent: true,
    },
  );
}

function unsupportedUpload(key: string, message: string): never {
  throw new StorageError(message, {
    code: StorageErrorCode.NOT_SUPPORTED,
    key,
    operation: 'upload',
    permanent: true,
  });
}

function conflict(key: string): never {
  throw new StorageError(`Conditional mutation conflicted for "${key}".`, {
    code: StorageErrorCode.CONFLICT,
    key,
    permanent: true,
  });
}

function notFound(key: string): never {
  throw new StorageError(`Storage object "${key}" was not found.`, {
    code: StorageErrorCode.NOT_FOUND,
    key,
    permanent: true,
  });
}

function runtimeOf(options: StorageOperationOptions): OperationRuntime {
  const timeoutSignal =
    options.timeout === undefined || options.timeout <= 0
      ? undefined
      : AbortSignal.timeout(options.timeout);
  return {
    callerSignal: options.signal,
    signal:
      options.signal === undefined
        ? timeoutSignal
        : timeoutSignal === undefined
          ? options.signal
          : AbortSignal.any([options.signal, timeoutSignal]),
    timeoutSignal,
  };
}

function assertActive(runtime: OperationRuntime, key: string): void {
  if (runtime.signal?.aborted !== true) {
    return;
  }
  const timedOut =
    runtime.timeoutSignal?.aborted === true &&
    runtime.callerSignal?.aborted !== true;
  throw new StorageError(
    timedOut
      ? `Filesystem mutation timed out for "${key}".`
      : `Filesystem mutation was aborted for "${key}".`,
    {
      aborted: true,
      cause: runtime.signal.reason,
      code: timedOut ? StorageErrorCode.TIMEOUT : StorageErrorCode.ABORTED,
      key,
      permanent: true,
      timedOut,
    },
  );
}

async function ensureRoot(root: string, key: string): Promise<void> {
  await fsp.mkdir(root, { mode: 0o700, recursive: true });
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink()) {
    throw symlinkError(key);
  }
  if (!stat.isDirectory()) {
    invalidFsPath(key, 'the configured root is not a directory');
  }
}

async function ensureParents(
  root: string,
  segments: readonly string[],
  key: string,
  create: boolean,
  runtime: OperationRuntime,
): Promise<string> {
  await ensureRoot(root, key);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    assertActive(runtime, key);
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      if (!create) {
        notFound(key);
      }
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (fsErrorCode(mkdirError) !== 'EEXIST') {
          throw mkdirError;
        }
      }
      stat = await fsp.lstat(current);
    }
    if (stat.isSymbolicLink()) {
      throw symlinkError(key);
    }
    if (!stat.isDirectory()) {
      invalidFsPath(key, 'a parent segment is not a directory');
    }
  }
  return path.join(root, ...segments);
}

async function regularFileOrMissing(
  target: string,
  key: string,
): Promise<Stats | undefined> {
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
      throw symlinkError(key);
    }
    if (!stat.isFile()) {
      invalidFsPath(key, 'an object path is not a regular file');
    }
    if (stat.nlink !== 1) {
      invalidFsPath(key, 'hard-linked object files are not accepted');
    }
    return stat;
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function assertSymlinkFreeReadPath(
  root: string,
  key: string,
): Promise<void> {
  const segments = strictSegments(key);
  let rootStat: Stats;
  try {
    rootStat = await fsp.lstat(root);
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (rootStat.isSymbolicLink()) {
    throw symlinkError(key);
  }
  if (!rootStat.isDirectory()) {
    invalidFsPath(key, 'the configured root is not a directory');
  }

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw symlinkError(key);
    }
    const leaf = index === segments.length - 1;
    if ((!leaf && !stat.isDirectory()) || (leaf && !stat.isFile())) {
      invalidFsPath(
        key,
        leaf
          ? 'an object path is not a regular file'
          : 'a parent segment is not a directory',
      );
    }
    if (leaf && stat.nlink !== 1) {
      invalidFsPath(key, 'hard-linked object files are not accepted');
    }
  }

  const sidecar = await regularFileOrMissing(current + SIDECAR_SUFFIX, key);
  if (sidecar?.isSymbolicLink()) {
    throw symlinkError(key);
  }
}

async function readSidecar(target: string, key: string): Promise<FsSidecar> {
  const handle = await fsp.open(
    target,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SIDECAR_BYTES) {
      throw new StorageError(`Filesystem metadata is invalid for "${key}".`, {
        code: StorageErrorCode.PROVIDER,
        key,
        permanent: true,
      });
    }
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('etag' in parsed) ||
      typeof parsed.etag !== 'string' ||
      !('contentType' in parsed) ||
      typeof parsed.contentType !== 'string' ||
      !('lastModified' in parsed) ||
      typeof parsed.lastModified !== 'number'
    ) {
      throw new StorageError(`Filesystem metadata is invalid for "${key}".`, {
        code: StorageErrorCode.PROVIDER,
        key,
        permanent: true,
      });
    }
    return parsed as FsSidecar;
  } finally {
    await handle.close();
  }
}

function bodyBytes(body: Body): Uint8Array | undefined {
  if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return undefined;
}

function defaultContentType(body: Body, override: string | undefined): string {
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

async function writeAll(
  handle: fsp.FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    offset += bytesWritten;
  }
}

function tempPath(directory: string): string {
  return path.join(directory, `.nestm-${randomUUID()}${TEMP_SUFFIX}`);
}

async function openTemp(directory: string): Promise<{
  handle: fsp.FileHandle;
  path: string;
}> {
  const target = tempPath(directory);
  const handle = await fsp.open(
    target,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  return { handle, path: target };
}

async function removeTemp(target: string | undefined): Promise<void> {
  if (target === undefined) {
    return;
  }
  try {
    await fsp.unlink(target);
  } catch (error) {
    if (fsErrorCode(error) !== 'ENOENT') {
      throw error;
    }
  }
}

async function stageBody(
  directory: string,
  key: string,
  body: Body,
  options: StorageConditionalUploadOptions,
  runtime: OperationRuntime,
): Promise<{ etag: string; path: string; size: number }> {
  const staged = await openTemp(directory);
  const hash = createHash('sha256');
  let size = 0;
  const knownBytes = bodyBytes(body);
  const knownSize =
    knownBytes?.byteLength ?? (body instanceof Blob ? body.size : undefined);
  options.onProgress?.({
    loaded: 0,
    ...(knownSize !== undefined && { total: knownSize }),
  });
  try {
    if (knownBytes !== undefined) {
      assertActive(runtime, key);
      await writeAll(staged.handle, knownBytes);
      hash.update(knownBytes);
      size = knownBytes.byteLength;
      options.onProgress?.({ loaded: size, total: size });
    } else if (body instanceof Blob) {
      const bytes = new Uint8Array(await body.arrayBuffer());
      assertActive(runtime, key);
      await writeAll(staged.handle, bytes);
      hash.update(bytes);
      size = bytes.byteLength;
      options.onProgress?.({ loaded: size, total: size });
    } else {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      try {
        while (true) {
          assertActive(runtime, key);
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          await writeAll(staged.handle, chunk.value);
          hash.update(chunk.value);
          size += chunk.value.byteLength;
          options.onProgress?.({ loaded: size });
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    await staged.handle.sync();
    await staged.handle.close();
    return {
      etag: `"${hash.digest('hex')}"`,
      path: staged.path,
      size,
    };
  } catch (error) {
    await staged.handle.close().catch(() => undefined);
    await removeTemp(staged.path).catch(() => undefined);
    throw error;
  }
}

async function stageSidecar(
  directory: string,
  sidecar: FsSidecar,
): Promise<string> {
  const staged = await openTemp(directory);
  try {
    await writeAll(
      staged.handle,
      new TextEncoder().encode(JSON.stringify(sidecar)),
    );
    await staged.handle.sync();
    await staged.handle.close();
    return staged.path;
  } catch (error) {
    await staged.handle.close().catch(() => undefined);
    await removeTemp(staged.path).catch(() => undefined);
    throw error;
  }
}

const CONDITIONAL_FS_TAILS = new Map<string, Promise<void>>();

async function serializeFsKey<Result>(
  lockKey: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  const previous = CONDITIONAL_FS_TAILS.get(lockKey) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  CONDITIONAL_FS_TAILS.set(lockKey, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (CONDITIONAL_FS_TAILS.get(lockKey) === tail) {
      CONDITIONAL_FS_TAILS.delete(lockKey);
    }
  }
}

/**
 * Adds symlink-defended reads and process-local conditional mutations to a
 * files-sdk fs adapter.
 *
 * The configured root must be dedicated to this driver: no other process and
 * no unconditional filesystem writer may mutate it concurrently. Each call
 * rejects symlinks in the existing key path and uses exclusive same-directory
 * temporary files plus atomic renames, but Node has no portable `openat2`
 * equivalent that could make those checks safe against a hostile concurrent
 * tree rewrite. This is a CAS implementation for an exclusively-owned local
 * workspace, not a host-filesystem sandbox. Body and metadata sidecars are two
 * files, so a process crash between their renames can still require cleanup.
 */
export function withFsConditionalMutation(base: FsAdapter): FsStorageAdapter {
  const root = path.resolve(base.root);
  const download = base.download.bind(base);
  const exists = base.exists.bind(base);
  const head = base.head.bind(base);
  const list = base.list.bind(base);
  const serialize = <Result>(
    key: string,
    operation: () => Promise<Result>,
  ): Promise<Result> =>
    serializeFsKey(`${root}\0${key.normalize('NFC').toLowerCase()}`, operation);

  return Object.assign(base, {
    conditionalMutation: Object.freeze({
      create: true,
      delete: true,
      etag: true,
      replace: true,
    }),
    async download(
      key: string,
      options?: DownloadOptions,
    ): Promise<StoredFile> {
      await assertSymlinkFreeReadPath(root, key);
      return download(key, options);
    },
    async exists(key: string, options?: OperationOptions): Promise<boolean> {
      await assertSymlinkFreeReadPath(root, key);
      return exists(key, options);
    },
    async head(key: string, options?: OperationOptions): Promise<StoredFile> {
      await assertSymlinkFreeReadPath(root, key);
      return head(key, options);
    },
    async list(options?: ListOptions): Promise<ListResult> {
      const result = await list(options);
      for (const item of result.items) {
        await assertSymlinkFreeReadPath(root, item.key);
      }
      return result;
    },
    async deleteConditional(
      key: string,
      options: StorageConditionalDeleteOptions,
    ): Promise<void> {
      return serialize(key, async () => {
        const runtime = runtimeOf(options);
        try {
          const segments = strictSegments(key);
          const bodyPath = await ensureParents(
            root,
            segments,
            key,
            false,
            runtime,
          );
          const sidecarPath = bodyPath + SIDECAR_SUFFIX;
          if (
            (await regularFileOrMissing(bodyPath, key)) === undefined ||
            (await regularFileOrMissing(sidecarPath, key)) === undefined
          ) {
            notFound(key);
          }
          const sidecar = await readSidecar(sidecarPath, key);
          if (sidecar.etag !== options.condition.etag) {
            conflict(key);
          }

          assertActive(runtime, key);
          await ensureParents(root, segments, key, false, runtime);
          if (
            (await regularFileOrMissing(bodyPath, key)) === undefined ||
            (await regularFileOrMissing(sidecarPath, key)) === undefined ||
            (await readSidecar(sidecarPath, key)).etag !==
              options.condition.etag
          ) {
            conflict(key);
          }
          await fsp.unlink(bodyPath);
          try {
            await fsp.unlink(sidecarPath);
          } catch (error) {
            throw storageFsError(error, key, 'delete');
          }
        } catch (error) {
          throw storageFsError(error, key, 'delete');
        }
      });
    },
    async uploadConditional(
      key: string,
      body: Body,
      options: StorageConditionalUploadOptions,
    ): Promise<StorageUploadResult> {
      return serialize(key, async () => {
        let bodyTemp: string | undefined;
        let sidecarTemp: string | undefined;
        const runtime = runtimeOf(options);
        try {
          if (options.multipart !== undefined && options.multipart !== false) {
            unsupportedUpload(
              key,
              'Conditional filesystem uploads do not support multipart mode.',
            );
          }
          if (options.control !== undefined) {
            unsupportedUpload(
              key,
              'Conditional filesystem uploads do not support resumable control.',
            );
          }

          const segments = strictSegments(key);
          const bodyPath = await ensureParents(
            root,
            segments,
            key,
            true,
            runtime,
          );
          const sidecarPath = bodyPath + SIDECAR_SUFFIX;
          const existingBody = await regularFileOrMissing(bodyPath, key);
          const existingSidecar = await regularFileOrMissing(sidecarPath, key);
          if (options.condition.type === 'create') {
            if (existingBody !== undefined || existingSidecar !== undefined) {
              conflict(key);
            }
          } else {
            if (existingBody === undefined || existingSidecar === undefined) {
              notFound(key);
            }
            if (
              (await readSidecar(sidecarPath, key)).etag !==
              options.condition.etag
            ) {
              conflict(key);
            }
          }

          const staged = await stageBody(
            path.dirname(bodyPath),
            key,
            body,
            options,
            runtime,
          );
          bodyTemp = staged.path;
          const lastModified = Date.now();
          const contentType = defaultContentType(body, options.contentType);
          sidecarTemp = await stageSidecar(path.dirname(bodyPath), {
            contentType,
            etag: staged.etag,
            lastModified,
            ...(options.cacheControl !== undefined && {
              cacheControl: options.cacheControl,
            }),
            ...(options.metadata !== undefined && {
              metadata: options.metadata,
            }),
          });

          assertActive(runtime, key);
          await ensureParents(root, segments, key, false, runtime);
          const currentBody = await regularFileOrMissing(bodyPath, key);
          const currentSidecar = await regularFileOrMissing(sidecarPath, key);
          if (options.condition.type === 'create') {
            if (currentBody !== undefined || currentSidecar !== undefined) {
              conflict(key);
            }
          } else if (
            currentBody === undefined ||
            currentSidecar === undefined ||
            (await readSidecar(sidecarPath, key)).etag !==
              options.condition.etag
          ) {
            conflict(key);
          }

          await fsp.rename(bodyTemp, bodyPath);
          bodyTemp = undefined;
          await fsp.rename(sidecarTemp, sidecarPath);
          sidecarTemp = undefined;
          return {
            contentType,
            etag: staged.etag,
            key,
            lastModified: new Date(lastModified),
            size: staged.size,
          };
        } catch (error) {
          throw storageFsError(error, key, 'upload');
        } finally {
          await removeTemp(bodyTemp).catch(() => undefined);
          await removeTemp(sidecarTemp).catch(() => undefined);
        }
      });
    },
  } satisfies FilesSdkConditionalMutationAdapter &
    Pick<FsAdapter, 'download' | 'exists' | 'head' | 'list'>);
}

/**
 * Creates the files-sdk filesystem driver from the storage package's own
 * dependency context. The adapter reaches only `node:fs`, so this entry point
 * adds no native SDK to the install — unlike every object-store provider, it is
 * always available.
 *
 * The adapter keeps a `<key>.meta.json` sidecar beside each body to carry the
 * content type, ETag, and custom metadata that a filesystem has nowhere else to
 * put. Sidecars never surface as keys: `list` and `search` skip them, and
 * uploading a key that ends in `.meta.json` fails closed rather than colliding
 * with one.
 *
 * Conditional mutations additionally require an exclusively-owned root. See
 * {@link withFsConditionalMutation}; use an OS sandbox as well when running an
 * agent that has direct shell or filesystem tools.
 */
export function createFsStorageDriver(
  options: FsStorageDriverOptions,
): FilesSdkStorageDriver<FsStorageAdapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  return createFilesSdkDriver({
    ...filesOptions,
    adapter: withFsConditionalMutation(fs(adapterOptions)),
  });
}

export { fs, mapFsError } from 'files-sdk/fs';
export type { FsAdapter, FsAdapterOptions } from 'files-sdk/fs';

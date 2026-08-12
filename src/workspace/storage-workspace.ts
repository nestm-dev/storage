import { StorageClient } from '../storage.client.js';
import { StorageErrorCode } from '../storage.error.js';
import type {
  StorageObjectMetadata,
  StorageOperationOptions,
  StorageUploadResult,
} from '../storage.types.js';

import { StorageWorkspaceCursorStore } from './storage-workspace.cursor.js';
import {
  sanitizeWorkspaceError,
  workspaceError,
} from './storage-workspace.error.js';
import {
  assertWorkspacePath,
  containsControlCharacter,
  isPathInside,
  joinWorkspacePath,
  workspaceBasename,
} from './storage-workspace.path.js';
import {
  DEFAULT_STORAGE_WORKSPACE_LIMITS,
  STORAGE_WORKSPACE_PERMISSIONS,
} from './storage-workspace.types.js';
import type {
  MountStorageWorkspaceOptions,
  StorageWorkspace as StorageWorkspaceContract,
  StorageWorkspaceBody,
  StorageWorkspaceDirectory,
  StorageWorkspaceEntry,
  StorageWorkspaceFile,
  StorageWorkspaceLimits,
  StorageWorkspaceListOptions,
  StorageWorkspaceMountOptions,
  StorageWorkspaceMutationOptions,
  StorageWorkspacePage,
  StorageWorkspacePermission,
  StorageWorkspaceReadOptions,
  StorageWorkspaceSearchMatch,
  StorageWorkspaceSearchOptions,
  StorageWorkspaceTextFile,
  StorageWorkspaceWriteOptions,
} from './storage-workspace.types.js';

const DEFAULT_PERMISSIONS: ReadonlySet<StorageWorkspacePermission> = new Set([
  'list',
  'read',
  'search',
]);
const PERMISSION_VALUES = new Set<StorageWorkspacePermission>(
  STORAGE_WORKSPACE_PERMISSIONS,
);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const WORKSPACE_CONSTRUCTOR = Symbol('StorageWorkspace.constructor');

interface WorkspaceState {
  readonly client: StorageClient;
  readonly cursorStore: StorageWorkspaceCursorStore;
  readonly id: string;
  readonly prefix: string;
}

interface ListCursorState {
  readonly backendCursor: string;
  readonly directory: string;
  readonly limit: number;
  readonly recursive: boolean;
}

interface SearchCursorState {
  readonly backendCursor: string | undefined;
  readonly caseInsensitive: boolean;
  readonly directory: string;
  readonly limit: number;
  readonly match: StorageWorkspaceSearchMatch;
  readonly query: string;
  readonly scanned: number;
}

function operationOptions(
  options?: StorageOperationOptions,
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

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw workspaceError(
      StorageErrorCode.INVALID_ARGUMENT,
      `${label} must be a positive safe integer.`,
      { permanent: true },
    );
  }
  return value;
}

function assertEtag(etag: string, maxBytes: number, operation: string): void {
  if (
    typeof etag !== 'string' ||
    etag.length === 0 ||
    containsControlCharacter(etag) ||
    encoder.encode(etag).byteLength > maxBytes
  ) {
    throw workspaceError(
      StorageErrorCode.INVALID_ARGUMENT,
      `${operation} requires a valid non-empty etag.`,
      { permanent: true },
    );
  }
}

function resolveLimits(
  requested: Partial<StorageWorkspaceLimits> | undefined,
  parent?: Readonly<StorageWorkspaceLimits>,
): Readonly<StorageWorkspaceLimits> {
  const baseline = parent ?? DEFAULT_STORAGE_WORKSPACE_LIMITS;
  const next: StorageWorkspaceLimits = {
    cursorTtlMs: requested?.cursorTtlMs ?? baseline.cursorTtlMs,
    maxPageSize: requested?.maxPageSize ?? baseline.maxPageSize,
    maxPathBytes: requested?.maxPathBytes ?? baseline.maxPathBytes,
    maxReadBytes: requested?.maxReadBytes ?? baseline.maxReadBytes,
    maxSearchResults: requested?.maxSearchResults ?? baseline.maxSearchResults,
    maxSearchScan: requested?.maxSearchScan ?? baseline.maxSearchScan,
    maxWriteBytes: requested?.maxWriteBytes ?? baseline.maxWriteBytes,
  };
  for (const [name, value] of Object.entries(next)) {
    positiveSafeInteger(value, `limits.${name}`);
    const parentValue = baseline[name as keyof StorageWorkspaceLimits];
    if (parent !== undefined && value > parentValue) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        `Child workspace limit "${name}" cannot exceed its parent limit.`,
        { permanent: true },
      );
    }
  }
  return Object.freeze(next);
}

function resolvePermissions(
  requested: Iterable<StorageWorkspacePermission> | undefined,
  parent?: ReadonlySet<StorageWorkspacePermission>,
): ReadonlySet<StorageWorkspacePermission> {
  const baseline = parent ?? DEFAULT_PERMISSIONS;
  const values = requested === undefined ? [...baseline] : [...requested];
  const permissions = new Set<StorageWorkspacePermission>();
  for (const permission of values) {
    if (!PERMISSION_VALUES.has(permission)) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        `Unknown workspace permission "${String(permission)}".`,
        { permanent: true },
      );
    }
    if (parent !== undefined && !parent.has(permission)) {
      throw workspaceError(
        StorageErrorCode.UNAUTHORIZED,
        `Child workspace cannot add the "${permission}" permission.`,
        { permanent: true },
      );
    }
    permissions.add(permission);
  }
  return permissions;
}

function logicalFile(
  metadata: StorageObjectMetadata | StorageUploadResult,
  path: string,
): StorageWorkspaceFile {
  if (
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    typeof metadata.contentType !== 'string' ||
    metadata.contentType.length === 0 ||
    (metadata.etag !== undefined &&
      (typeof metadata.etag !== 'string' || metadata.etag.length === 0)) ||
    (metadata.lastModified !== undefined &&
      !Number.isFinite(new Date(metadata.lastModified).getTime()))
  ) {
    throw workspaceError(
      StorageErrorCode.PROVIDER,
      'Storage provider returned malformed file metadata.',
      { permanent: true },
    );
  }
  return {
    contentType: metadata.contentType,
    ...(metadata.etag !== undefined && { etag: metadata.etag }),
    kind: 'file',
    ...(metadata.lastModified !== undefined && {
      lastModified: new Date(metadata.lastModified),
    }),
    name: workspaceBasename(path),
    path,
    size: metadata.size,
  };
}

function logicalDirectory(path: string): StorageWorkspaceDirectory {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return {
    kind: 'directory',
    name: normalized.length === 0 ? '' : workspaceBasename(normalized),
    path: normalized,
  };
}

function segmentGlobMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;
  while (valueIndex < value.length) {
    if (
      patternIndex < pattern.length &&
      (pattern[patternIndex] === '?' ||
        pattern[patternIndex] === value[valueIndex])
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex;
      patternIndex += 1;
      starValueIndex = valueIndex;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === '*') {
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

function globMatches(pattern: string, value: string): boolean {
  const patternSegments = pattern.split('/');
  const valueSegments = value.split('/');
  let patternIndex = 0;
  let valueIndex = 0;
  let globstarIndex = -1;
  let globstarValueIndex = -1;
  while (valueIndex < valueSegments.length) {
    const patternSegment = patternSegments[patternIndex];
    const valueSegment = valueSegments[valueIndex];
    if (patternSegment === '**') {
      globstarIndex = patternIndex;
      globstarValueIndex = valueIndex;
      patternIndex += 1;
    } else if (
      patternSegment !== undefined &&
      valueSegment !== undefined &&
      segmentGlobMatches(patternSegment, valueSegment)
    ) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (globstarIndex !== -1) {
      patternIndex = globstarIndex + 1;
      globstarValueIndex += 1;
      valueIndex = globstarValueIndex;
    } else {
      return false;
    }
  }
  while (patternSegments[patternIndex] === '**') {
    patternIndex += 1;
  }
  return patternIndex === patternSegments.length;
}

function searchMatches(
  query: string,
  path: string,
  match: StorageWorkspaceSearchMatch,
  caseInsensitive: boolean,
): boolean {
  const candidate = caseInsensitive ? path.toLowerCase() : path;
  const needle = caseInsensitive ? query.toLowerCase() : query;
  if (match === 'exact') {
    return candidate === needle;
  }
  if (match === 'substring') {
    return candidate.includes(needle);
  }
  return globMatches(needle, candidate);
}

async function collectBoundedText(
  stream: ReadableStream<Uint8Array>,
  announcedSize: number,
  maxBytes: number,
  path: string,
): Promise<string> {
  if (announcedSize > maxBytes) {
    await stream.cancel().catch(() => undefined);
    throw workspaceError(
      StorageErrorCode.LIMIT_EXCEEDED,
      `Workspace file "${path}" exceeds the ${maxBytes}-byte read limit.`,
      { path, permanent: true },
    );
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        throw workspaceError(
          StorageErrorCode.PROVIDER,
          'Storage provider returned an empty non-terminal body chunk.',
          { path, permanent: true },
        );
      }
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw workspaceError(
          StorageErrorCode.LIMIT_EXCEEDED,
          `Workspace file "${path}" exceeded the ${maxBytes}-byte read limit.`,
          { path, permanent: true },
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw workspaceError(
      StorageErrorCode.INVALID_ARGUMENT,
      `Workspace file "${path}" is not valid UTF-8 text.`,
      { path, permanent: true },
    );
  }
}

async function collectBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  announcedSize: number,
  maxBytes: number,
  path: string,
): Promise<Uint8Array> {
  if (announcedSize > maxBytes) {
    await stream.cancel().catch(() => undefined);
    throw workspaceError(
      StorageErrorCode.LIMIT_EXCEEDED,
      `Workspace file "${path}" exceeds the ${maxBytes}-byte copy limit.`,
      { path, permanent: true },
    );
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      if (result.value.byteLength === 0) {
        throw workspaceError(
          StorageErrorCode.PROVIDER,
          'Storage provider returned an empty non-terminal body chunk.',
          { path, permanent: true },
        );
      }
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw workspaceError(
          StorageErrorCode.LIMIT_EXCEEDED,
          `Workspace file "${path}" exceeded the ${maxBytes}-byte copy limit.`,
          { path, permanent: true },
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class StorageWorkspaceImplementation implements StorageWorkspaceContract {
  readonly #state: WorkspaceState;
  readonly #permissions: ReadonlySet<StorageWorkspacePermission>;
  readonly #limits: Readonly<StorageWorkspaceLimits>;

  /** @internal Construct workspaces through {@link mountStorageWorkspace}. */
  constructor(
    constructorToken: symbol,
    state: WorkspaceState,
    permissions: ReadonlySet<StorageWorkspacePermission>,
    limits: Readonly<StorageWorkspaceLimits>,
  ) {
    if (constructorToken !== WORKSPACE_CONSTRUCTOR) {
      throw workspaceError(
        StorageErrorCode.UNAUTHORIZED,
        'StorageWorkspace must be created by mountStorageWorkspace().',
        { permanent: true },
      );
    }
    this.#state = state;
    this.#permissions = permissions;
    this.#limits = limits;
  }

  get permissions(): ReadonlySet<StorageWorkspacePermission> {
    return new Set(this.#permissions);
  }

  get limits(): Readonly<StorageWorkspaceLimits> {
    return Object.freeze({ ...this.#limits });
  }

  allows(permission: StorageWorkspacePermission): boolean {
    return this.#permissions.has(permission);
  }

  async stat(
    path: string,
    options?: StorageOperationOptions,
  ): Promise<StorageWorkspaceFile> {
    this.#require('read');
    const logicalPath = this.#filePath(path);
    try {
      const metadata = await this.#state.client.head(
        this.#scope(logicalPath),
        options,
      );
      this.#assertResultPath(metadata.key, logicalPath);
      return logicalFile(metadata, logicalPath);
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'stat',
        path: logicalPath,
      });
    }
  }

  async readText(
    path: string,
    options?: StorageWorkspaceReadOptions,
  ): Promise<StorageWorkspaceTextFile> {
    this.#require('read');
    const logicalPath = this.#filePath(path);
    const maxBytes = options?.maxBytes ?? this.#limits.maxReadBytes;
    positiveSafeInteger(maxBytes, 'maxBytes');
    if (maxBytes > this.#limits.maxReadBytes) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        `maxBytes cannot exceed the ${this.#limits.maxReadBytes}-byte workspace read limit.`,
        { path: logicalPath, permanent: true },
      );
    }
    try {
      const object = await this.#state.client.downloadStream(
        this.#scope(logicalPath),
        operationOptions(options),
      );
      this.#assertResultPath(object.key, logicalPath);
      const text = await collectBoundedText(
        object.body,
        object.size,
        maxBytes,
        logicalPath,
      );
      return { ...logicalFile(object, logicalPath), text };
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'read',
        path: logicalPath,
      });
    }
  }

  async list(
    options: StorageWorkspaceListOptions = {},
  ): Promise<StorageWorkspacePage> {
    this.#require('list');
    const continuation = options.cursor
      ? this.#state.cursorStore.consume<ListCursorState>(
          options.cursor,
          this.#binding('list'),
        )
      : undefined;
    if (
      continuation !== undefined &&
      ((options.directory !== undefined &&
        options.directory !== continuation.directory) ||
        (options.limit !== undefined && options.limit !== continuation.limit) ||
        (options.recursive !== undefined &&
          options.recursive !== continuation.recursive))
    ) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Workspace cursor conflicts with the supplied list query.',
        { permanent: true },
      );
    }
    const directory = this.#directoryPath(
      continuation?.directory ?? options.directory ?? '',
    );
    const limit = this.#pageLimit(
      continuation?.limit ?? options.limit,
      this.#limits.maxPageSize,
    );
    const recursive = continuation?.recursive ?? options.recursive === true;
    const binding = this.#binding('list');
    const scopedDirectory = this.#scopeDirectory(directory);
    try {
      const page = await this.#state.client.list({
        ...(continuation !== undefined && {
          cursor: continuation.backendCursor,
        }),
        ...(!recursive && { delimiter: '/' }),
        limit,
        ...operationOptions(options),
        prefix: scopedDirectory,
      });
      if (page.items.length + (page.prefixes?.length ?? 0) > limit) {
        this.#malformedPage();
      }
      if (page.cursor !== undefined && page.cursor.length === 0) {
        this.#malformedPage();
      }
      if (
        page.cursor !== undefined &&
        (page.items.length + (page.prefixes?.length ?? 0) === 0 ||
          page.cursor === continuation?.backendCursor)
      ) {
        this.#malformedPage();
      }
      const entries: StorageWorkspaceEntry[] = [];
      for (const item of page.items) {
        const path = this.#unscoped(item.key);
        if (!isPathInside(directory, path)) {
          this.#providerScopeFailure();
        }
        if (!recursive) {
          const relative =
            directory.length === 0 ? path : path.slice(directory.length + 1);
          if (relative.includes('/')) {
            this.#malformedPage();
          }
        }
        entries.push(logicalFile(item, path));
      }
      for (const prefix of page.prefixes ?? []) {
        const path = this.#unscoped(
          prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
        );
        if (!isPathInside(directory, path)) {
          this.#providerScopeFailure();
        }
        if (!recursive) {
          const relative =
            directory.length === 0 ? path : path.slice(directory.length + 1);
          if (relative.includes('/')) {
            this.#malformedPage();
          }
        }
        entries.push(logicalDirectory(path));
      }
      return {
        ...(page.cursor !== undefined && {
          cursor: this.#state.cursorStore.issue(
            binding,
            {
              backendCursor: page.cursor,
              directory,
              limit,
              recursive,
            } satisfies ListCursorState,
            this.#limits.cursorTtlMs,
          ),
        }),
        entries,
      };
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'list',
        ...(directory.length > 0 && { path: directory }),
      });
    }
  }

  async search(
    query: string,
    options: StorageWorkspaceSearchOptions = {},
  ): Promise<StorageWorkspacePage> {
    this.#require('search');
    const continuation = options.cursor
      ? this.#state.cursorStore.consume<SearchCursorState>(
          options.cursor,
          this.#binding('search'),
        )
      : undefined;
    if (
      continuation !== undefined &&
      ((query.length > 0 && query !== continuation.query) ||
        (options.directory !== undefined &&
          options.directory !== continuation.directory) ||
        (options.match !== undefined && options.match !== continuation.match) ||
        (options.caseInsensitive !== undefined &&
          options.caseInsensitive !== continuation.caseInsensitive) ||
        (options.limit !== undefined && options.limit !== continuation.limit))
    ) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Workspace cursor conflicts with the supplied search query.',
        { permanent: true },
      );
    }
    query = continuation?.query ?? query;
    if (typeof query !== 'string' || query.length === 0) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Search query must be a non-empty string.',
        { permanent: true },
      );
    }
    if (query.includes('\\') || containsControlCharacter(query)) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Search query contains forbidden characters.',
        { permanent: true },
      );
    }
    if (encoder.encode(query).byteLength > this.#limits.maxPathBytes) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        'Search query exceeds the workspace path-byte limit.',
        { permanent: true },
      );
    }
    const directory = this.#directoryPath(
      continuation?.directory ?? options.directory ?? '',
    );
    const match = continuation?.match ?? options.match ?? 'glob';
    if (match !== 'glob' && match !== 'substring' && match !== 'exact') {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Search match must be glob, substring, or exact.',
        { permanent: true },
      );
    }
    const caseInsensitive =
      continuation?.caseInsensitive ?? options.caseInsensitive === true;
    const limit = this.#pageLimit(
      continuation?.limit ?? options.limit,
      this.#limits.maxSearchResults,
    );
    const binding = this.#binding('search');
    const prior = continuation ?? {
      backendCursor: undefined,
      caseInsensitive,
      directory,
      limit,
      match,
      query,
      scanned: 0,
    };
    return this.#searchPage(query, {
      binding,
      caseInsensitive,
      directory,
      limit,
      match,
      operation: operationOptions(options),
      state: prior,
    });
  }

  async writeFile(
    path: string,
    body: StorageWorkspaceBody,
    options: StorageWorkspaceWriteOptions,
  ): Promise<StorageWorkspaceFile> {
    this.#require(options.mode);
    const logicalPath = this.#filePath(path);
    if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Workspace writes accept only strings or Uint8Array bodies.',
        { path: logicalPath, permanent: true },
      );
    }
    const size =
      typeof body === 'string'
        ? encoder.encode(body).byteLength
        : body.byteLength;
    if (size > this.#limits.maxWriteBytes) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        `Workspace write exceeds the ${this.#limits.maxWriteBytes}-byte limit.`,
        { path: logicalPath, permanent: true },
      );
    }
    if (options.mode === 'replace') {
      assertEtag(options.etag, this.#limits.maxPathBytes, 'Replace');
    }
    try {
      const common = {
        ...(options.contentType !== undefined && {
          contentType: options.contentType,
        }),
        ...(options.metadata !== undefined && { metadata: options.metadata }),
        ...operationOptions(options),
      };
      const result =
        options.mode === 'create'
          ? await this.#state.client.uploadConditional(
              this.#scope(logicalPath),
              body,
              { ...common, condition: { type: 'create' } },
            )
          : await this.#state.client.uploadConditional(
              this.#scope(logicalPath),
              body,
              {
                ...common,
                condition: { etag: options.etag, type: 'replace' },
              },
            );
      this.#assertResultPath(result.key, logicalPath);
      return logicalFile(result, logicalPath);
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: options.mode,
        path: logicalPath,
      });
    }
  }

  async copyFile(
    source: string,
    destination: string,
    options?: StorageOperationOptions,
  ): Promise<StorageWorkspaceFile> {
    this.#require('copy');
    this.#require('read');
    this.#require('create');
    const sourcePath = this.#filePath(source, 'source path');
    const destinationPath = this.#filePath(destination, 'destination path');
    if (sourcePath === destinationPath) {
      throw workspaceError(
        StorageErrorCode.CONFLICT,
        'Copy destination must differ from its source.',
        { path: destinationPath, permanent: true },
      );
    }
    if (this.#state.client.capabilities.conditionalMutation?.create !== true) {
      throw workspaceError(
        StorageErrorCode.NOT_SUPPORTED,
        'Safe copy requires create-only conditional upload support.',
        { operation: 'copy', path: destinationPath, permanent: true },
      );
    }
    return this.#copyCreate(sourcePath, destinationPath, options);
  }

  async moveFile(
    source: string,
    destination: string,
    options: StorageWorkspaceMutationOptions,
  ): Promise<StorageWorkspaceFile> {
    this.#require('move');
    this.#require('read');
    this.#require('create');
    this.#require('delete');
    const conditional = this.#state.client.capabilities.conditionalMutation;
    if (
      conditional?.create !== true ||
      conditional.delete !== true ||
      conditional.etag !== true
    ) {
      throw workspaceError(
        StorageErrorCode.NOT_SUPPORTED,
        'Safe move requires create-only upload, conditional delete, and upload ETag support.',
        { operation: 'move', permanent: true },
      );
    }
    const sourcePath = this.#filePath(source, 'source path');
    const destinationPath = this.#filePath(destination, 'destination path');
    if (sourcePath === destinationPath) {
      throw workspaceError(
        StorageErrorCode.CONFLICT,
        'Move destination must differ from its source.',
        { path: destinationPath, permanent: true },
      );
    }
    assertEtag(options.etag, this.#limits.maxPathBytes, 'Move');
    const copied = await this.#copyCreate(sourcePath, destinationPath, options);
    if (copied.etag === undefined) {
      throw workspaceError(
        StorageErrorCode.NOT_SUPPORTED,
        'Safe move requires the destination provider to return an etag.',
        { path: destinationPath, permanent: true },
      );
    }
    try {
      await this.#state.client.deleteConditional(this.#scope(sourcePath), {
        condition: { etag: options.etag },
        ...operationOptions(options),
      });
      return copied;
    } catch {
      throw workspaceError(
        StorageErrorCode.CONFLICT,
        `Workspace move could not confirm source deletion; destination "${destinationPath}" was retained. Inspect both paths before retrying.`,
        {
          operation: 'move',
          path: destinationPath,
          permanent: true,
        },
      );
    }
  }

  async deleteFile(
    path: string,
    options: StorageWorkspaceMutationOptions,
  ): Promise<void> {
    this.#require('delete');
    const logicalPath = this.#filePath(path);
    assertEtag(options.etag, this.#limits.maxPathBytes, 'Delete');
    try {
      await this.#state.client.deleteConditional(this.#scope(logicalPath), {
        condition: { etag: options.etag },
        ...operationOptions(options),
      });
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'delete',
        path: logicalPath,
      });
    }
  }

  mount(
    directory: string,
    options: StorageWorkspaceMountOptions = {},
  ): StorageWorkspaceContract {
    const path = this.#directoryPath(directory);
    if (path.length === 0) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'A child workspace mount directory must not be empty.',
        { permanent: true },
      );
    }
    return new StorageWorkspaceImplementation(
      WORKSPACE_CONSTRUCTOR,
      {
        ...this.#state,
        id: `${this.#state.id}/${path}`,
        prefix: joinWorkspacePath(this.#state.prefix, path),
      },
      resolvePermissions(options.permissions, this.#permissions),
      resolveLimits(options.limits, this.#limits),
    );
  }

  async #copyCreate(
    sourcePath: string,
    destinationPath: string,
    options?: StorageOperationOptions,
  ): Promise<StorageWorkspaceFile> {
    try {
      const source = await this.#state.client.downloadStream(
        this.#scope(sourcePath),
        operationOptions(options),
      );
      this.#assertResultPath(source.key, sourcePath);
      const bytes = await collectBoundedBytes(
        source.body,
        source.size,
        this.#limits.maxWriteBytes,
        sourcePath,
      );
      const result = await this.#state.client.uploadConditional(
        this.#scope(destinationPath),
        bytes,
        {
          condition: { type: 'create' },
          contentType: source.contentType,
          ...(source.metadata !== undefined && { metadata: source.metadata }),
          ...operationOptions(options),
        },
      );
      this.#assertResultPath(result.key, destinationPath);
      return logicalFile(result, destinationPath);
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'copy',
        path: destinationPath,
      });
    }
  }

  async #searchPage(
    query: string,
    context: {
      binding: string;
      caseInsensitive: boolean;
      directory: string;
      limit: number;
      match: StorageWorkspaceSearchMatch;
      operation: StorageOperationOptions | undefined;
      state: SearchCursorState;
    },
  ): Promise<StorageWorkspacePage> {
    const entries: StorageWorkspaceEntry[] = [];
    let backendCursor = context.state.backendCursor;
    let scanned = context.state.scanned;
    try {
      while (
        entries.length < context.limit &&
        scanned < this.#limits.maxSearchScan
      ) {
        const remaining = this.#limits.maxSearchScan - scanned;
        const remainingResults = context.limit - entries.length;
        const page = await this.#state.client.list({
          ...(backendCursor !== undefined && { cursor: backendCursor }),
          limit: Math.min(
            this.#limits.maxPageSize,
            remaining,
            remainingResults,
          ),
          ...context.operation,
          prefix: this.#scopeDirectory(context.directory),
        });
        const requested = Math.min(
          this.#limits.maxPageSize,
          remaining,
          remainingResults,
        );
        if (page.items.length > requested) {
          this.#malformedPage();
        }
        if ((page.prefixes?.length ?? 0) > 0) {
          this.#malformedPage();
        }
        if (page.cursor !== undefined && page.cursor.length === 0) {
          this.#malformedPage();
        }
        if (
          page.cursor !== undefined &&
          (page.items.length === 0 || page.cursor === backendCursor)
        ) {
          this.#malformedPage();
        }
        for (let index = 0; index < page.items.length; index += 1) {
          const item = page.items[index];
          if (item === undefined) {
            continue;
          }
          scanned += 1;
          const path = this.#unscoped(item.key);
          if (!isPathInside(context.directory, path)) {
            this.#providerScopeFailure();
          }
          if (
            searchMatches(
              query,
              context.directory.length === 0
                ? path
                : path.slice(context.directory.length + 1),
              context.match,
              context.caseInsensitive,
            )
          ) {
            entries.push(logicalFile(item, path));
          }
          if (
            entries.length === context.limit ||
            scanned === this.#limits.maxSearchScan
          ) {
            break;
          }
        }
        backendCursor = page.cursor;
        if (backendCursor === undefined) {
          break;
        }
      }
      const hasMore = backendCursor !== undefined;
      if (scanned >= this.#limits.maxSearchScan && hasMore) {
        throw workspaceError(
          StorageErrorCode.LIMIT_EXCEEDED,
          `Search exceeded the ${this.#limits.maxSearchScan}-object scan limit.`,
          { permanent: true },
        );
      }
      return {
        ...(hasMore && {
          cursor: this.#state.cursorStore.issue(
            context.binding,
            {
              backendCursor,
              caseInsensitive: context.caseInsensitive,
              directory: context.directory,
              limit: context.limit,
              match: context.match,
              query,
              scanned,
            } satisfies SearchCursorState,
            this.#limits.cursorTtlMs,
          ),
        }),
        entries,
      };
    } catch (error) {
      throw sanitizeWorkspaceError(error, {
        operation: 'search',
        ...(context.directory.length > 0 && { path: context.directory }),
      });
    }
  }

  #require(permission: StorageWorkspacePermission): void {
    if (!this.#permissions.has(permission)) {
      throw workspaceError(
        StorageErrorCode.UNAUTHORIZED,
        `Workspace does not allow ${permission} operations.`,
        { permanent: true },
      );
    }
  }

  #filePath(path: string, label = 'path'): string {
    return assertWorkspacePath(path, this.#limits.maxPathBytes, {
      allowRoot: false,
      label,
    });
  }

  #directoryPath(path: string): string {
    return assertWorkspacePath(path, this.#limits.maxPathBytes, {
      allowRoot: true,
      label: 'directory',
    });
  }

  #scope(path: string): string {
    return `${this.#state.prefix}/${path}`;
  }

  #scopeDirectory(directory: string): string {
    return directory.length === 0
      ? `${this.#state.prefix}/`
      : `${this.#state.prefix}/${directory}/`;
  }

  #unscoped(key: string): string {
    const scoped = `${this.#state.prefix}/`;
    if (!key.startsWith(scoped)) {
      this.#providerScopeFailure();
    }
    const path = key.slice(scoped.length);
    return assertWorkspacePath(path, this.#limits.maxPathBytes, {
      allowRoot: false,
      label: 'backend result path',
    });
  }

  #assertResultPath(key: string, expected: string): void {
    if (this.#unscoped(key) !== expected) {
      this.#providerScopeFailure();
    }
  }

  #providerScopeFailure(): never {
    throw workspaceError(
      StorageErrorCode.PROVIDER,
      'Storage provider returned data outside the mounted workspace.',
      { permanent: true },
    );
  }

  #malformedPage(): never {
    throw workspaceError(
      StorageErrorCode.PROVIDER,
      'Storage provider returned a malformed workspace page.',
      { permanent: true },
    );
  }

  #pageLimit(value: number | undefined, maximum: number): number {
    const limit = value ?? maximum;
    positiveSafeInteger(limit, 'limit');
    if (limit > maximum) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        `limit cannot exceed the workspace maximum of ${maximum}.`,
        { permanent: true },
      );
    }
    return limit;
  }

  #binding(operation: string): string {
    return `${this.#state.id}:${operation}`;
  }
}

export function mountStorageWorkspace(
  client: StorageClient,
  options: MountStorageWorkspaceOptions,
): StorageWorkspaceContract {
  const limits = resolveLimits(options.limits);
  const prefix = assertWorkspacePath(options.prefix, limits.maxPathBytes, {
    allowRoot: false,
    label: 'workspace prefix',
  });
  return new StorageWorkspaceImplementation(
    WORKSPACE_CONSTRUCTOR,
    {
      client,
      cursorStore: new StorageWorkspaceCursorStore(),
      id: `workspace:${crypto.randomUUID()}`,
      prefix,
    },
    resolvePermissions(options.permissions),
    limits,
  );
}

/** @deprecated Prefer {@link mountStorageWorkspace}. */
export const createStorageWorkspace = mountStorageWorkspace;

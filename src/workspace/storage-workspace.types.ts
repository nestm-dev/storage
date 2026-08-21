import type { StorageBody, StorageOperationOptions } from '../storage.types.js';

import type { StorageWorkspaceCursorConfiguration } from './storage-workspace.cursor.js';

export const STORAGE_WORKSPACE_PERMISSIONS = [
  'list',
  'read',
  'search',
  'write',
  'create',
  'replace',
  'copy',
  'move',
  'delete',
] as const;

export type StorageWorkspacePermission =
  (typeof STORAGE_WORKSPACE_PERMISSIONS)[number];

export interface StorageWorkspaceLimits {
  /** Maximum UTF-8 byte length of an opaque continuation cursor. */
  maxCursorBytes: number;
  /** Maximum UTF-8 byte length of a workspace-relative path. */
  maxPathBytes: number;
  /** Maximum bytes returned by one buffered text or binary read. */
  maxReadBytes: number;
  /** Maximum bytes accepted by one write. */
  maxWriteBytes: number;
  /** Maximum entries returned by one list page. */
  maxPageSize: number;
  /** Maximum entries returned by one search page. */
  maxSearchResults: number;
  /** Maximum objects inspected by one search query across all pages. */
  maxSearchScan: number;
  /**
   * Authorization ceiling for an opaque continuation cursor. It does not
   * extend the lifetime or availability of an embedded provider cursor.
   */
  cursorTtlMs: number;
}

export const DEFAULT_STORAGE_WORKSPACE_LIMITS: Readonly<StorageWorkspaceLimits> =
  Object.freeze({
    cursorTtlMs: 5 * 60 * 1000,
    maxCursorBytes: 4_096,
    maxPageSize: 100,
    maxPathBytes: 1024,
    maxReadBytes: 1024 * 1024,
    maxSearchResults: 100,
    maxSearchScan: 1000,
    maxWriteBytes: 1024 * 1024,
  });

export interface StorageWorkspaceFile {
  kind: 'file';
  path: string;
  name: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageWorkspaceDirectory {
  kind: 'directory';
  path: string;
  name: string;
}

export type StorageWorkspaceEntry =
  StorageWorkspaceFile | StorageWorkspaceDirectory;

export interface StorageWorkspaceTextFile extends StorageWorkspaceFile {
  text: string;
}

export interface StorageWorkspaceByteFile extends StorageWorkspaceFile {
  bytes: Uint8Array;
}

export interface StorageWorkspacePage {
  entries: StorageWorkspaceEntry[];
  cursor?: string;
}

export interface StorageWorkspaceMountOptions {
  permissions?: Iterable<StorageWorkspacePermission>;
  limits?: Partial<StorageWorkspaceLimits>;
}

export interface MountStorageWorkspaceOptions extends StorageWorkspaceMountOptions {
  /** Trusted backend namespace. It is never exposed through the workspace. */
  prefix: string;
  /** Stable server-owned cursor configuration shared across serving replicas. */
  cursor?: StorageWorkspaceCursorConfiguration;
}

export interface StorageWorkspaceReadOptions extends StorageOperationOptions {
  maxBytes?: number;
}

export interface StorageWorkspaceListOptions extends StorageOperationOptions {
  directory?: string | undefined;
  recursive?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type StorageWorkspaceSearchMatch = 'glob' | 'substring' | 'exact';

export interface StorageWorkspaceSearchOptions extends StorageOperationOptions {
  directory?: string | undefined;
  match?: StorageWorkspaceSearchMatch | undefined;
  caseInsensitive?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

interface StorageWorkspaceWriteCommon extends StorageOperationOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export type StorageWorkspaceWriteOptions = StorageWorkspaceWriteCommon &
  (
    | { mode: 'create' }
    /** Unconditionally writes the destination through the ordinary Files path. */
    | { mode: 'overwrite' }
    | {
        mode: 'replace';
        etag: string;
      }
  );

export interface StorageWorkspaceMutationOptions extends StorageOperationOptions {
  etag: string;
}

export interface StorageWorkspaceOverwriteOptions extends StorageOperationOptions {
  /** Unconditionally overwrites the destination through the ordinary Files path. */
  mode: 'overwrite';
}

export interface StorageWorkspaceUnconditionalDeleteOptions extends StorageOperationOptions {
  /** Deletes the current destination without an ETag precondition. */
  mode: 'unconditional';
}

export type StorageWorkspaceCopyOptions =
  StorageWorkspaceMutationOptions | StorageWorkspaceOverwriteOptions;

export type StorageWorkspaceDeleteOptions =
  StorageWorkspaceMutationOptions | StorageWorkspaceUnconditionalDeleteOptions;

export type StorageWorkspaceBody = Extract<StorageBody, string | Uint8Array>;

export interface StorageWorkspace {
  readonly permissions: ReadonlySet<StorageWorkspacePermission>;
  readonly limits: Readonly<StorageWorkspaceLimits>;
  allows(permission: StorageWorkspacePermission): boolean;
  stat(
    path: string,
    options?: StorageOperationOptions,
  ): Promise<StorageWorkspaceFile>;
  readText(
    path: string,
    options?: StorageWorkspaceReadOptions,
  ): Promise<StorageWorkspaceTextFile>;
  readBytes(
    path: string,
    options?: StorageWorkspaceReadOptions,
  ): Promise<StorageWorkspaceByteFile>;
  list(options?: StorageWorkspaceListOptions): Promise<StorageWorkspacePage>;
  search(
    query: string,
    options?: StorageWorkspaceSearchOptions,
  ): Promise<StorageWorkspacePage>;
  writeFile(
    path: string,
    body: StorageWorkspaceBody,
    options: StorageWorkspaceWriteOptions,
  ): Promise<StorageWorkspaceFile>;
  copyFile(
    source: string,
    destination: string,
    options: StorageWorkspaceCopyOptions,
  ): Promise<StorageWorkspaceFile>;
  moveFile(
    source: string,
    destination: string,
    options: StorageWorkspaceMutationOptions,
  ): Promise<StorageWorkspaceFile>;
  deleteFile(
    path: string,
    options: StorageWorkspaceDeleteOptions,
  ): Promise<void>;
  mount(
    directory: string,
    options?: StorageWorkspaceMountOptions,
  ): StorageWorkspace;
}

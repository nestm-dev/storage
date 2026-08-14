import type { StorageBody, StorageOperationOptions } from '../storage.types.js';

export const STORAGE_WORKSPACE_PERMISSIONS = [
  'list',
  'read',
  'search',
  'create',
  'replace',
  'copy',
  'move',
  'delete',
] as const;

export type StorageWorkspacePermission =
  (typeof STORAGE_WORKSPACE_PERMISSIONS)[number];

export interface StorageWorkspaceLimits {
  /** Maximum UTF-8 byte length of a workspace-relative path. */
  maxPathBytes: number;
  /** Maximum bytes returned by a buffered text read. */
  maxReadBytes: number;
  /** Maximum bytes accepted by one write. */
  maxWriteBytes: number;
  /** Maximum entries returned by one list page. */
  maxPageSize: number;
  /** Maximum entries returned by one search page. */
  maxSearchResults: number;
  /** Maximum objects inspected by one search query across all pages. */
  maxSearchScan: number;
  /** Lifetime of an opaque in-memory continuation cursor. */
  cursorTtlMs: number;
}

export const DEFAULT_STORAGE_WORKSPACE_LIMITS: Readonly<StorageWorkspaceLimits> =
  Object.freeze({
    cursorTtlMs: 5 * 60 * 1000,
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
    | {
        mode: 'replace';
        etag: string;
      }
  );

export interface StorageWorkspaceMutationOptions extends StorageOperationOptions {
  etag: string;
}

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
    options: StorageWorkspaceMutationOptions,
  ): Promise<StorageWorkspaceFile>;
  moveFile(
    source: string,
    destination: string,
    options: StorageWorkspaceMutationOptions,
  ): Promise<StorageWorkspaceFile>;
  deleteFile(
    path: string,
    options: StorageWorkspaceMutationOptions,
  ): Promise<void>;
  mount(
    directory: string,
    options?: StorageWorkspaceMountOptions,
  ): StorageWorkspace;
}

import type { Readable } from 'node:stream';

import type { StorageError } from './storage.error.js';
import type { StorageUploadControl } from './storage-upload-control.js';

export type StorageBody =
  | Blob
  | File
  | ReadableStream<Uint8Array>
  | Readable
  | ArrayBuffer
  | ArrayBufferView
  | Uint8Array
  | string;

export interface StorageRetryContext {
  attempt: number;
  error: StorageError;
}

export type StorageRetryOptions =
  | number
  | {
      max: number;
      backoff?: (context: StorageRetryContext) => number;
    };

export interface StorageOperationOptions {
  signal?: AbortSignal;
  timeout?: number;
  retries?: StorageRetryOptions;
}

/**
 * Preconditions for promoting a staged object to its final key. At least one
 * source identity must be supplied; unsupported identities fail closed.
 */
export interface StoragePromotionOptions extends StorageOperationOptions {
  /** Copy only the source object whose provider ETag exactly matches. */
  sourceEtag?: string;
  /** Copy this immutable provider version of the source object. */
  sourceVersion?: string;
}

export interface StorageMultipartOptions {
  partSize?: number;
  concurrency?: number;
}

export interface StorageUploadProgress {
  loaded: number;
  total?: number;
}

export interface StorageUploadOptions extends StorageOperationOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  onProgress?: (progress: StorageUploadProgress) => void;
  multipart?: boolean | StorageMultipartOptions;
  control?: StorageUploadControl;
}

export interface StorageUploadResult {
  key: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageObjectMetadata {
  key: string;
  name: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: Date;
  metadata?: Record<string, string>;
}

export interface StorageObject extends StorageObjectMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface StorageByteRange {
  start: number;
  end?: number;
}

export interface StorageDownloadOptions extends StorageOperationOptions {
  range?: StorageByteRange;
}

export interface StorageBufferedDownloadOptions extends StorageDownloadOptions {
  /**
   * Maximum number of bytes buffered in memory. Defaults to 10 MiB.
   * Pass `Infinity` only when the caller has independently bounded the object.
   */
  maxBytes?: number;
}

export interface StorageListOptions extends StorageOperationOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
  delimiter?: string;
}

export interface StorageListResult {
  items: StorageObjectMetadata[];
  prefixes?: string[];
  cursor?: string;
}

export type StorageSearchMatch = 'glob' | 'regex' | 'substring' | 'exact';

export interface StorageSearchOptions extends StorageOperationOptions {
  prefix?: string;
  limit?: number;
  maxResults?: number;
  match?: StorageSearchMatch;
  caseInsensitive?: boolean;
}

export interface StorageSignedDownloadOptions extends StorageOperationOptions {
  expiresIn?: number;
  responseContentDisposition?: string;
}

export interface StorageSignedUploadOptions extends StorageOperationOptions {
  expiresIn: number;
  contentType?: string;
  maxSize?: number;
  minSize?: number;
}

export type StorageSignedUpload =
  | {
      method: 'PUT';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      method: 'POST';
      url: string;
      fields: Record<string, string>;
    };

export interface StorageSignedUrlCapability {
  supported: boolean;
  maxExpiresIn?: number;
}

export interface StorageConditionalCopyCapability {
  supported: boolean;
  etag: boolean;
  version: boolean;
}

export interface StorageSignedUploadPolicyCapability {
  /** The signed request fixes the exact declared content type. */
  contentType: boolean;
  /** The signed request enforces the requested min/max byte range. */
  sizeRange: boolean;
}

export interface StorageSignedDownloadPolicyCapability {
  /** Every generated URL honors the requested expiry. */
  expiresIn: boolean;
}

export interface StorageCapabilities {
  rangeRead: boolean;
  /** True when the provider reports native byte-level upload progress. */
  nativeUploadProgress: boolean;
  delimiter: boolean;
  metadata: boolean;
  cacheControl: boolean;
  resumableUpload: boolean;
  serverSideCopy: boolean;
  /**
   * Conditional server-side copy used to promote an already verified staged
   * object without a validation/copy race. Absent means unsupported for
   * compatibility with drivers built against earlier package versions.
   */
  conditionalCopy?: StorageConditionalCopyCapability;
  signedDownload: StorageSignedUrlCapability;
  /** Expiry guarantees enforced by the provider adapter. */
  signedDownloadPolicy?: StorageSignedDownloadPolicyCapability;
  /**
   * Some providers decide support from credentials or requested constraints,
   * so direct-upload support can only be known when the call is attempted.
   */
  signedUpload: boolean | 'runtime';
  /**
   * Constraints cryptographically/provider-policy enforced by direct upload.
   * Absent means callers must not assume request options are enforced.
   */
  signedUploadPolicy?: StorageSignedUploadPolicyCapability;
}

export interface StorageBulkOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

export interface StorageBulkError {
  key: string;
  error: StorageError;
}

export interface StorageUploadManyItem {
  key: string;
  body: StorageBody;
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
  multipart?: boolean | StorageMultipartOptions;
}

export interface StorageUploadManyOptions
  extends StorageBulkOptions, StorageOperationOptions {
  onProgress?: (progress: StorageUploadProgress & { key: string }) => void;
}

export interface StorageUploadManyResult {
  uploaded: StorageUploadResult[];
  errors?: StorageBulkError[];
}

export interface StorageDownloadManyResult {
  downloaded: StorageObject[];
  errors?: StorageBulkError[];
}

export interface StorageHeadManyResult {
  objects: StorageObjectMetadata[];
  errors?: StorageBulkError[];
}

export interface StorageExistsManyResult {
  existing: string[];
  missing: string[];
  errors?: StorageBulkError[];
}

export interface StorageDeleteManyResult {
  deleted: string[];
  errors?: StorageBulkError[];
}

export type StorageOperationName =
  | 'upload'
  | 'download'
  | 'head'
  | 'exists'
  | 'delete'
  | 'copy'
  | 'move'
  | 'promote'
  | 'list'
  | 'search'
  | 'signDownload'
  | 'signUpload';

export interface StorageOperationContext {
  store: string;
  operation: StorageOperationName;
  key?: string;
  from?: string;
  to?: string;
}

export interface StoragePlugin {
  name?: string;
  /**
   * Runs before the driver and may reject an operation, for example to enforce
   * policy. Hooks run in registration order.
   */
  beforeOperation?: (context: StorageOperationContext) => void | Promise<void>;
  /**
   * Observes a successful operation. Throwing turns the call into a failure,
   * which is useful for mandatory audit sinks.
   *
   * For streaming downloads, success means the provider returned a stream.
   * Later consumption failures are normalized for the stream consumer but do
   * not re-enter plugin hooks.
   */
  afterOperation?: (
    context: StorageOperationContext,
    result: unknown,
  ) => void | Promise<void>;
  /**
   * Best-effort error observation. Hook failures never replace the original
   * storage error.
   */
  onError?: (
    context: StorageOperationContext,
    error: StorageError,
  ) => void | Promise<void>;
}

export interface StorageTransferProgress {
  done: number;
  total: number;
  key: string;
  status: 'transferred' | 'skipped';
}

export interface StorageTransferOptions extends StorageBulkOptions {
  from: string;
  to: string;
  prefix?: string;
  transformKey?: (key: string) => string;
  overwrite?: boolean;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: StorageTransferProgress) => void;
}

export interface StorageTransferResult {
  transferred: string[];
  skipped?: string[];
  errors?: StorageBulkError[];
}

export type StorageSyncCompare =
  | 'etag'
  | 'size'
  | ((
      source: StorageObjectMetadata,
      destination: StorageObjectMetadata,
    ) => boolean);

export interface StorageSyncProgress {
  done: number;
  total: number;
  key: string;
  status: 'uploaded' | 'skipped' | 'deleted';
}

export interface StorageSyncOptions extends StorageBulkOptions {
  from: string;
  to: string;
  prefix?: string;
  destinationPrefix?: string;
  transformKey?: (key: string) => string;
  prune?: boolean;
  compare?: StorageSyncCompare;
  dryRun?: boolean;
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (progress: StorageSyncProgress) => void;
}

export interface StorageSyncResult {
  uploaded: string[];
  skipped: string[];
  deleted?: string[];
  errors?: StorageBulkError[];
}

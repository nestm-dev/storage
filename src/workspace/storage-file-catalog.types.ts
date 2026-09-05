import type {
  StorageTextEdit,
  StorageTextSearchResult,
} from '../core/storage-text.js';
import type { StorageTextWindow } from '../core/storage-streams.js';
import type {
  StorageFileWorkflowOperation,
  StorageFileWorkflowPage,
} from './storage-file-workflow.types.js';

export interface StorageCatalogFile {
  readonly path: string;
  readonly fileId: string;
  readonly etag: string;
  readonly size: number;
  readonly contentType: string;
}
export interface StorageFileCatalogLimits {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxPageSize: number;
  readonly maxSearchScanBytes: number;
  readonly maxSearchMatches: number;
  readonly maxPathBytes: number;
}
export interface StorageCatalogPath extends StorageFileWorkflowOperation {
  readonly path: string;
  readonly expectedEtag?: string | undefined;
}
export interface StorageCatalogPage extends StorageFileWorkflowOperation {
  readonly offset?: number | undefined;
}
export interface StorageCatalogCommand extends StorageCatalogPath {
  /** Opaque host-scoped command identity, stable across response-loss retries. */
  readonly commandId: string;
}
/** Host catalog port. Implementations own persistence, conditional heads and replay. */
export interface StorageFileCatalogCapability<Receipt = unknown> {
  readonly kind: 'storage-file-catalog';
  readonly version: 1;
  readonly limits: StorageFileCatalogLimits;
  allows(permission: 'read' | 'write'): boolean;
  list(
    input: StorageCatalogPage & { readonly directory?: string | undefined },
  ): Promise<StorageFileWorkflowPage<StorageCatalogFile>>;
  stat(input: StorageCatalogPath): Promise<StorageCatalogFile>;
  search(
    input: StorageCatalogPage & { readonly query: string },
  ): Promise<StorageFileWorkflowPage<StorageCatalogFile>>;
  readWindow(input: StorageCatalogPath & StorageCatalogPage): Promise<
    StorageTextWindow & {
      readonly path: string;
      readonly fileId: string;
      readonly etag: string;
      readonly size: number;
      readonly totalBytes: number;
    }
  >;
  searchContent(
    input: StorageCatalogPath &
      StorageCatalogPage & {
        readonly expectedEtag: string;
        readonly query: string;
      },
  ): Promise<
    StorageTextSearchResult & { readonly path: string; readonly etag: string }
  >;
  write(
    input: StorageCatalogCommand & { readonly content: string },
  ): Promise<Receipt>;
  edit(
    input: StorageCatalogCommand & {
      readonly expectedEtag: string;
      readonly change: StorageTextEdit;
    },
  ): Promise<Receipt>;
}

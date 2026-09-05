import type {
  StorageStagedBody,
  StorageStagedContent,
} from '../core/storage-staged-content.js';
import type { StorageTextWindow } from '../core/storage-streams.js';

export type StorageFileWorkflowPermission = 'read' | 'write' | 'commit';
export type StorageFileWorkflowMutation = 'create' | 'replace';
export interface StorageFileWorkflowLimits {
  maxChunkBytes: number;
  maxReadBytes: number;
  maxPageSize: number;
  maxCommitFiles: number;
  maxPathBytes: number;
}
export const DEFAULT_STORAGE_FILE_WORKFLOW_LIMITS: Readonly<StorageFileWorkflowLimits> =
  Object.freeze({
    maxChunkBytes: 262_144,
    maxReadBytes: 4096,
    maxPageSize: 64,
    maxCommitFiles: 20,
    maxPathBytes: 1024,
  });
export interface StorageFileWorkflowOperation {
  readonly signal?: AbortSignal | undefined;
}
export interface StorageFileDraftBegin extends StorageFileWorkflowOperation {
  readonly path: string;
  readonly idempotencyKey: string;
  readonly text: boolean;
  readonly expectedEtag?: string | undefined;
}
export interface StorageFileDraftRequest extends StorageFileWorkflowOperation {
  readonly draftId: string;
}
export interface StorageFileDraftPageRequest extends StorageFileWorkflowOperation {
  readonly offset?: number | undefined;
}
export interface StorageFileDraftAppend extends StorageFileDraftRequest {
  readonly offset: number;
  readonly bytes: Uint8Array;
}
export interface StorageFileDraftCommit {
  readonly draftId: string;
  readonly size: number;
  readonly sha256?: string | undefined;
}
export interface StorageFileWorkflowCommit extends StorageFileWorkflowOperation {
  readonly drafts: readonly StorageFileDraftCommit[];
}
export interface StorageFileDraft<Receipt> {
  readonly id: string;
  readonly path: string;
  readonly expectedEtag: string | null;
  readonly text: boolean;
  readonly status: 'open' | 'sealed' | 'committed' | 'cancelled';
  readonly size: number;
  readonly result: Receipt | null;
  readonly createdAt: string;
}
export interface StorageFileDraftRecord<
  Receipt,
> extends StorageFileDraft<Receipt> {
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  /** Whole-file verified body; persisted only with successful head commit. */
  readonly body: StorageStagedBody | null;
}
export interface StorageFilePartReceipt {
  readonly offset: number;
  readonly size: number;
  readonly sha256: string;
}
export interface StorageFilePartRecord extends StorageFilePartReceipt {
  readonly body: StorageStagedBody;
}
export interface StorageFileWorkflowPage<Item> {
  readonly items: readonly Item[];
  readonly nextOffset: number | null;
}
export interface StorageFileHeadChange<Receipt> {
  readonly draft: StorageFileDraftRecord<Receipt>;
  readonly body: StorageStagedBody;
}

/** All methods execute in the SAME host transaction. Records are detached values. */
export interface StorageFileWorkflowTransaction<Receipt> {
  findDraftByKey(key: string): Promise<StorageFileDraftRecord<Receipt> | null>;
  getDraft(id: string): Promise<StorageFileDraftRecord<Receipt> | null>;
  saveDraft(draft: StorageFileDraftRecord<Receipt>): Promise<void>;
  /** Stable order, at most limit entries; scoped to the authorized principal. */
  listDrafts(
    offset: number,
    limit: number,
  ): Promise<readonly StorageFileDraftRecord<Receipt>[]>;
  /** Ordered by offset; include the part containing offset, then later parts. */
  listParts(
    draftId: string,
    offset: number,
    limit: number,
  ): Promise<readonly StorageFilePartRecord[]>;
  putPart(draftId: string, part: StorageFilePartRecord): Promise<void>;
  /**
   * Compare every expected head/create predicate and update all heads atomically.
   * Return one receipt per change, in the supplied order. Must join this transaction;
   * never implement this as serial provider writes or independent transactions.
   * Paths arrive sorted to permit consistent lock ordering.
   */
  commitHeads(
    changes: readonly StorageFileHeadChange<Receipt>[],
  ): Promise<readonly Receipt[]>;
}
export interface StorageFileWorkflowPersistence<Scope, Receipt> {
  /**
   * Reauthorize scope on EVERY call; lock/serialize its draft/idempotency state
   * before work begins, including across replicas. Roll back ALL callback effects
   * on rejection. Resolve only after durable commit. Do not retry the callback.
   * Check signal before committing; once committed, return its result even if
   * signal subsequently aborts. Lost responses are reconciled by replay.
   */
  transaction<Result>(
    scope: Scope,
    options: StorageFileWorkflowOperation & {
      readonly permission: StorageFileWorkflowPermission;
    },
    work: (
      transaction: StorageFileWorkflowTransaction<Receipt>,
    ) => Promise<Result>,
  ): Promise<Result>;
}
export interface StorageFileWorkflowOptions<Scope, Receipt> {
  readonly persistence: StorageFileWorkflowPersistence<Scope, Receipt>;
  readonly content: StorageStagedContent<Scope>;
}
export interface MountStorageFileWorkflowOptions extends StorageFileWorkflowOperation {
  readonly permissions?: Iterable<StorageFileWorkflowPermission>;
  /** Checked against each persisted draft on append/cancel/commit, including replay. */
  readonly mutations?: Iterable<StorageFileWorkflowMutation>;
  readonly limits?: Partial<StorageFileWorkflowLimits>;
}
/** A host-scope-bound capability. Scope, provider keys and staged bodies stay private. */
export interface StorageFileWorkflowCapability<Receipt = unknown> {
  readonly kind: 'storage-file-workflow';
  readonly version: 1;
  readonly limits: Readonly<StorageFileWorkflowLimits>;
  allows(permission: StorageFileWorkflowPermission): boolean;
  /** Narrow only; cannot change scope, widen grants/limits, or detach parent abort. */
  restrict(
    options: MountStorageFileWorkflowOptions,
  ): StorageFileWorkflowCapability<Receipt>;
  begin(input: StorageFileDraftBegin): Promise<StorageFileDraft<Receipt>>;
  list(
    input?: StorageFileDraftPageRequest,
  ): Promise<StorageFileWorkflowPage<StorageFileDraft<Receipt>>>;
  read(
    input: StorageFileDraftRequest & StorageFileDraftPageRequest,
  ): Promise<StorageFileDraft<Receipt> & StorageTextWindow>;
  append(input: StorageFileDraftAppend): Promise<StorageFileDraft<Receipt>>;
  parts(
    input: StorageFileDraftRequest & StorageFileDraftPageRequest,
  ): Promise<StorageFileWorkflowPage<StorageFilePartReceipt>>;
  cancel(input: StorageFileDraftRequest): Promise<StorageFileDraft<Receipt>>;
  commit(input: StorageFileWorkflowCommit): Promise<readonly Receipt[]>;
}

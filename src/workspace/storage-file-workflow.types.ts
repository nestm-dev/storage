import type {
  StorageStagedBody,
  StorageStagedContent,
} from '../core/storage-staged-content.js';
import type { StorageTextChange } from '../core/storage-text-edit.js';
import type { StorageTextSearchResult } from '../core/storage-text.js';
import type { StorageTextWindow } from '../core/storage-streams.js';

export type StorageFileWorkflowPermission = 'read' | 'write' | 'commit';
export type StorageFileWorkflowMutation = 'create' | 'replace';
export interface StorageFileWorkflowLimits {
  maxChunkBytes: number;
  maxReadBytes: number;
  maxPageSize: number;
  maxCommitFiles: number;
  maxPathBytes: number;
  /** Buffered input and host read ceiling; streamed file edits are not limited by total file size. */
  maxTextBytes: number;
  maxEdits: number;
}
export const DEFAULT_STORAGE_FILE_WORKFLOW_LIMITS: Readonly<StorageFileWorkflowLimits> =
  Object.freeze({
    maxChunkBytes: 262_144,
    maxReadBytes: 4096,
    maxPageSize: 64,
    maxCommitFiles: 20,
    maxPathBytes: 1024,
    maxTextBytes: 16 * 1024 * 1024,
    maxEdits: 64,
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
export interface StorageFileDraftStageText extends Omit<
  StorageFileDraftBegin,
  'text'
> {
  readonly content: string;
}
export interface StorageFileDraftStageStream extends StorageFileDraftBegin {
  /** Stable trusted source identity used to detect conflicting command replay. */
  readonly contentIdentity: string;
  /** Open only after authorization and replay lookup; bytes are never exposed to the model. */
  readonly body: () => ReadableStream<Uint8Array>;
  readonly sourceDraftId?: string | undefined;
  readonly expectedSize?: number | undefined;
}
export interface StorageFileDraftReviseText extends StorageFileDraftRequest {
  /** Optional host request identity, included in replay validation. */
  readonly requestIdentity?: string | undefined;
  readonly expectedSize: number;
  readonly idempotencyKey: string;
  readonly changes: readonly StorageTextChange[];
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
  /** Predecessor checkpoint; null for a new draft or catalog checkout. */
  readonly sourceDraftId: string | null;
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
  /** Atomically save a bounded text buffer as a sealed, resumable checkpoint. */
  stageText(
    input: StorageFileDraftStageText,
  ): Promise<StorageFileDraft<Receipt>>;
  /** Stage arbitrary-size text or binary source in bounded, integrity-checked chunks. */
  stageStream(
    input: StorageFileDraftStageStream,
  ): Promise<StorageFileDraft<Receipt>>;
  /** Save a new sealed checkpoint; preserve the source and original head precondition. */
  reviseText(
    input: StorageFileDraftReviseText,
  ): Promise<StorageFileDraft<Receipt>>;
  /** Recover a host command receipt without reopening its source. */
  lookup(
    input: StorageFileWorkflowOperation & { readonly idempotencyKey: string },
  ): Promise<StorageFileDraft<Receipt> | null>;
  begin(input: StorageFileDraftBegin): Promise<StorageFileDraft<Receipt>>;
  list(
    input?: StorageFileDraftPageRequest,
  ): Promise<StorageFileWorkflowPage<StorageFileDraft<Receipt>>>;
  read(
    input: StorageFileDraftRequest & StorageFileDraftPageRequest,
  ): Promise<StorageFileDraft<Receipt> & StorageTextWindow>;
  searchText(
    input: StorageFileDraftRequest &
      StorageFileDraftPageRequest & {
        readonly expectedSize: number;
        readonly query: string;
      },
  ): Promise<
    StorageTextSearchResult & { readonly path: string; readonly etag: string }
  >;
  /** Buffer one exact text revision within maxTextBytes for host validation. */
  readText(
    input: StorageFileDraftRequest & { readonly expectedSize: number },
  ): Promise<StorageFileDraft<Receipt> & { readonly content: string }>;
  append(input: StorageFileDraftAppend): Promise<StorageFileDraft<Receipt>>;
  parts(
    input: StorageFileDraftRequest & StorageFileDraftPageRequest,
  ): Promise<StorageFileWorkflowPage<StorageFilePartReceipt>>;
  cancel(input: StorageFileDraftRequest): Promise<StorageFileDraft<Receipt>>;
  commit(input: StorageFileWorkflowCommit): Promise<readonly Receipt[]>;
}

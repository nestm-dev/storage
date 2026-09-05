import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from '../storage.error.js';
import { assertWorkspacePath } from './storage-workspace.path.js';
import type { StorageStagedBody } from '../core/storage-staged-content.js';
import {
  collectStorageBytes,
  readStorageTextWindow,
  storageBytesStream,
  storageInteger,
} from '../core/storage-streams.js';
import {
  DEFAULT_STORAGE_FILE_WORKFLOW_LIMITS,
  type MountStorageFileWorkflowOptions,
  type StorageFileDraft,
  type StorageFileDraftRecord,
  type StorageFileWorkflowCapability,
  type StorageFileWorkflowLimits,
  type StorageFileWorkflowOperation,
  type StorageFileWorkflowOptions,
  type StorageFileWorkflowPermission,
  type StorageFileWorkflowMutation,
  type StorageFileWorkflowTransaction,
} from './storage-file-workflow.types.js';

export class StorageFileWorkflow<Scope, Receipt> {
  readonly #options: StorageFileWorkflowOptions<Scope, Receipt>;
  constructor(options: StorageFileWorkflowOptions<Scope, Receipt>) {
    this.#options = options;
  }

  mount(
    scope: Scope,
    options: MountStorageFileWorkflowOptions = {},
  ): StorageFileWorkflowCapability<Receipt> {
    const limits = Object.freeze({
      ...DEFAULT_STORAGE_FILE_WORKFLOW_LIMITS,
      ...options.limits,
    });
    for (const [name, value] of Object.entries(limits))
      storageInteger(value, name, name === 'maxReadBytes' ? 4 : 1);
    const permissions = new Set(
      options.permissions ?? ['read', 'write', 'commit'],
    );
    const mutations = new Set<StorageFileWorkflowMutation>(
      options.mutations ?? ['create', 'replace'],
    );
    const boundSignal = options.signal;
    const requireMutation = (expectedEtag: string | null | undefined) => {
      if (!mutations.has(expectedEtag == null ? 'create' : 'replace'))
        throw new StorageError(
          'Draft mutation is not permitted by this capability.',
          { code: 'UNAUTHORIZED' },
        );
    };
    const operationPermissions = new WeakMap<
      AbortSignal,
      StorageFileWorkflowPermission
    >();
    const allows = (permission: StorageFileWorkflowPermission) =>
      permissions.has(permission) &&
      (permission === 'read' || mutations.size > 0);
    const operation = (
      permission: StorageFileWorkflowPermission,
      input: StorageFileWorkflowOperation,
    ) => {
      if (!allows(permission))
        throw new StorageError('File workflow operation is not permitted.', {
          code: 'UNAUTHORIZED',
        });
      const signals = [boundSignal, input.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      operationPermissions.set(signal, permission);
      return signal;
    };
    const transaction = <T>(
      signal: AbortSignal,
      work: (tx: StorageFileWorkflowTransaction<Receipt>) => Promise<T>,
    ) =>
      this.#transaction(scope, signal, operationPermissions.get(signal)!, work);
    const content = this.#options.content;
    const workflow: StorageFileWorkflowCapability<Receipt> = {
      kind: 'storage-file-workflow',
      version: 1,
      limits,
      allows,
      restrict: (restriction) => {
        const narrowed = { ...limits };
        for (const name of Object.keys(
          limits,
        ) as (keyof StorageFileWorkflowLimits)[]) {
          const requested = restriction.limits?.[name] ?? limits[name];
          storageInteger(requested, name, name === 'maxReadBytes' ? 4 : 1);
          narrowed[name] = Math.min(limits[name], requested);
        }
        return this.mount(scope, {
          limits: narrowed,
          permissions: [...(restriction.permissions ?? permissions)].filter(
            (permission) => permissions.has(permission),
          ),
          mutations: [...(restriction.mutations ?? mutations)].filter(
            (mutation) => mutations.has(mutation),
          ),
          signal: AbortSignal.any(
            [boundSignal, restriction.signal].filter(
              (signal): signal is AbortSignal => signal !== undefined,
            ),
          ),
        });
      },
      begin: async (input) => {
        const signal = operation('write', input);
        requireMutation(input.expectedEtag);
        assertWorkspacePath(input.path, limits.maxPathBytes, {
          allowRoot: false,
        });
        validateIdentity(input.idempotencyKey);
        if (
          typeof input.text !== 'boolean' ||
          (input.expectedEtag !== undefined &&
            (typeof input.expectedEtag !== 'string' ||
              input.expectedEtag.length === 0 ||
              input.expectedEtag.length > 1024))
        )
          invalid('Invalid draft input.');
        const fingerprint = digest(
          new TextEncoder().encode(
            JSON.stringify([
              input.path,
              input.expectedEtag ?? null,
              input.text,
            ]),
          ),
        );
        return transaction(signal, async (tx) => {
          const prior = await tx.findDraftByKey(input.idempotencyKey);
          if (prior !== null) {
            if (prior.requestFingerprint !== fingerprint)
              conflict('Draft key was already used for different input.');
            return summary(prior);
          }
          const record: StorageFileDraftRecord<Receipt> = {
            id: randomUUID(),
            path: input.path,
            expectedEtag: input.expectedEtag ?? null,
            text: input.text,
            status: 'open',
            size: 0,
            result: null,
            createdAt: new Date().toISOString(),
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: fingerprint,
            body: null,
          };
          await tx.saveDraft(record);
          return summary(record);
        });
      },
      list: async (input = {}) => {
        const signal = operation('read', input);
        const offset = input.offset ?? 0;
        storageInteger(offset, 'offset');
        return transaction(signal, async (tx) => {
          const records = await tx.listDrafts(offset, limits.maxPageSize + 1);
          if (records.length > limits.maxPageSize + 1)
            provider('Persistence returned an oversized page.');
          return {
            items: records.slice(0, limits.maxPageSize).map(summary),
            nextOffset:
              records.length > limits.maxPageSize
                ? offset + limits.maxPageSize
                : null,
          };
        });
      },
      read: async (input) => {
        const signal = operation('read', input);
        const draft = await transaction(signal, (tx) =>
          requireDraft(tx, input.draftId),
        );
        if (draft.status === 'cancelled') conflict('Draft is cancelled.');
        const offset = input.offset ?? 0;
        storageInteger(offset, 'offset');
        if (offset > draft.size) invalid('Offset exceeds draft size.');
        const window = draft.text
          ? await readStorageTextWindow(
              async (range) =>
                this.#stream(
                  scope,
                  draft,
                  limits,
                  signal,
                  range.start,
                  range.end + 1,
                ),
              {
                size: draft.size,
                offset,
                maxBytes: limits.maxReadBytes,
                signal,
              },
            )
          : { content: null, offset, nextOffset: null };
        return { ...summary(draft), ...window };
      },
      append: async (input) => {
        const signal = operation('write', input);
        storageInteger(input.offset, 'offset');
        if (
          !(input.bytes instanceof Uint8Array) ||
          input.bytes.byteLength < 1 ||
          input.bytes.byteLength > limits.maxChunkBytes
        )
          throw new StorageError('Append exceeds chunk limits.', {
            code: 'LIMIT_EXCEEDED',
          });
        // Snapshot before any await: callers may reuse or mutate their upload buffer.
        const bytes = input.bytes.slice();
        const sha256 = digest(bytes);
        const prior = await transaction(signal, async (tx) => {
          const draft = await requireDraft(tx, input.draftId);
          requireMutation(draft.expectedEtag);
          return appendState(tx, draft, input.offset, bytes.byteLength, sha256);
        });
        if (prior.replay) return summary(prior.draft);
        if (prior.draft.text) {
          try {
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
              bytes,
            );
          } catch {
            invalid('Text chunks must contain complete UTF-8 characters.');
          }
        }
        const body = await content.write(scope, storageBytesStream(bytes), {
          maxBytes: limits.maxChunkBytes,
          signal,
        });
        if (body.size !== bytes.byteLength || body.sha256 !== sha256)
          provider('Staged chunk receipt does not match input.');
        return transaction(signal, async (tx) => {
          const current = await appendState(
            tx,
            await requireDraft(tx, input.draftId),
            input.offset,
            bytes.byteLength,
            sha256,
          );
          requireMutation(current.draft.expectedEtag);
          if (current.replay) return summary(current.draft);
          const size = current.draft.size + bytes.byteLength;
          storageInteger(size, 'size');
          await tx.putPart(input.draftId, {
            offset: input.offset,
            size: body.size,
            sha256,
            body,
          });
          const draft = { ...current.draft, size };
          await tx.saveDraft(draft);
          return summary(draft);
        });
      },
      parts: async (input) => {
        const signal = operation('read', input);
        const offset = input.offset ?? 0;
        storageInteger(offset, 'offset');
        return transaction(signal, async (tx) => {
          const draft = await requireDraft(tx, input.draftId);
          if (draft.status === 'cancelled') conflict('Draft is cancelled.');
          if (offset > draft.size) invalid('Offset exceeds draft size.');
          const parts = await tx.listParts(
            draft.id,
            offset,
            limits.maxPageSize,
          );
          if (parts.length > limits.maxPageSize)
            provider('Persistence returned an oversized page.');
          const items = parts
            .filter((part) => part.offset + part.size > offset)
            .map(({ offset, size, sha256 }) => ({ offset, size, sha256 }));
          const last = items.at(-1);
          const next =
            last === undefined ? draft.size : last.offset + last.size;
          if (offset < draft.size && (last === undefined || next <= offset))
            provider('Draft contains missing chunks.');
          return { items, nextOffset: next < draft.size ? next : null };
        });
      },
      cancel: async (input) => {
        const signal = operation('write', input);
        return transaction(signal, async (tx) => {
          const draft = await requireDraft(tx, input.draftId);
          requireMutation(draft.expectedEtag);
          if (draft.status === 'committed')
            conflict('Committed draft cannot be cancelled.');
          const cancelled = { ...draft, status: 'cancelled' as const };
          await tx.saveDraft(cancelled);
          return summary(cancelled);
        });
      },
      commit: async (input) => {
        const signal = operation('commit', input);
        if (
          input.drafts.length < 1 ||
          input.drafts.length > limits.maxCommitFiles ||
          new Set(input.drafts.map((draft) => draft.draftId)).size !==
            input.drafts.length
        )
          invalid('Commit requires distinct draft IDs within the batch limit.');
        const requests = input.drafts.map((draft) => ({ ...draft }));
        for (const request of requests) {
          storageInteger(request.size, 'size');
          if (
            request.sha256 !== undefined &&
            !/^[0-9a-f]{64}$/u.test(request.sha256)
          )
            invalid('Invalid SHA-256.');
        }
        const sealed = await transaction(signal, async (tx) => {
          const drafts: StorageFileDraftRecord<Receipt>[] = [];
          for (const request of requests) {
            const draft = await requireDraft(tx, request.draftId);
            requireMutation(draft.expectedEtag);
            if (draft.size !== request.size || draft.status === 'cancelled')
              conflict('Draft is cancelled or has a different byte count.');
            if (
              draft.status === 'committed' &&
              (draft.result === null ||
                draft.body === null ||
                (request.sha256 !== undefined &&
                  request.sha256 !== draft.body.sha256))
            )
              conflict('Committed draft does not match the requested digest.');
            drafts.push(draft);
          }
          if (new Set(drafts.map((draft) => draft.path)).size !== drafts.length)
            conflict('A path may appear only once per commit.');
          if (drafts.every((draft) => draft.status === 'committed'))
            return drafts;
          if (drafts.some((draft) => draft.status === 'committed'))
            conflict('Cannot mix committed and uncommitted drafts.');
          const result = drafts.map((draft) => ({
            ...draft,
            status: 'sealed' as const,
          }));
          for (const draft of result) await tx.saveDraft(draft);
          return result;
        });
        if (sealed.every((draft) => draft.status === 'committed'))
          return sealed.map((draft) => draft.result!);
        const prepared = new Map<string, StorageStagedBody>();
        for (const [index, draft] of sealed.entries()) {
          const body = await content.write(
            scope,
            this.#stream(scope, draft, limits, signal, 0, draft.size, 'commit'),
            { maxBytes: draft.size, signal },
          );
          if (
            body.size !== draft.size ||
            (requests[index]!.sha256 !== undefined &&
              requests[index]!.sha256 !== body.sha256)
          )
            conflict(
              'Completed body does not match the expected byte count or SHA-256.',
            );
          prepared.set(draft.id, body);
        }
        return transaction(signal, async (tx) => {
          const drafts: StorageFileDraftRecord<Receipt>[] = [];
          for (const request of requests) {
            const draft = await requireDraft(tx, request.draftId);
            requireMutation(draft.expectedEtag);
            drafts.push(draft);
          }
          // A competing identical commit may have completed while bodies streamed.
          if (drafts.every((draft) => draft.status === 'committed')) {
            for (const [index, draft] of drafts.entries())
              if (
                draft.result === null ||
                draft.body?.sha256 !== prepared.get(draft.id)?.sha256 ||
                draft.size !== requests[index]!.size
              )
                conflict('Concurrent commit differs from the prepared body.');
            return drafts.map((draft) => draft.result!);
          }
          if (drafts.some((draft) => draft.status !== 'sealed'))
            conflict('Every draft must remain sealed until commit.');
          const ordered = [...drafts].sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
          );
          const results = await tx.commitHeads(
            ordered.map((draft) => ({ draft, body: prepared.get(draft.id)! })),
          );
          if (
            results.length !== ordered.length ||
            results.some((receipt) => receipt === null || receipt === undefined)
          )
            provider('Host must return one non-null receipt per head.');
          const byId = new Map<string, Receipt>();
          for (const [index, draft] of ordered.entries()) {
            const result = results[index]!;
            byId.set(draft.id, result);
            await tx.saveDraft({
              ...draft,
              status: 'committed',
              result,
              body: prepared.get(draft.id)!,
            });
          }
          return requests.map((request) => byId.get(request.draftId)!);
        });
      },
    };
    return Object.freeze(workflow);
  }

  #transaction<Result>(
    scope: Scope,
    signal: AbortSignal,
    permission: StorageFileWorkflowPermission,
    work: (tx: StorageFileWorkflowTransaction<Receipt>) => Promise<Result>,
  ): Promise<Result> {
    signal.throwIfAborted();
    return this.#options.persistence.transaction(
      scope,
      { signal, permission },
      async (tx) => {
        signal.throwIfAborted();
        const result = await work(tx);
        signal.throwIfAborted();
        return result;
      },
    );
  }
  #stream(
    scope: Scope,
    draft: StorageFileDraftRecord<Receipt>,
    limits: StorageFileWorkflowLimits,
    parentSignal: AbortSignal,
    start = 0,
    end = draft.size,
    permission: StorageFileWorkflowPermission = 'read',
  ): ReadableStream<Uint8Array> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    const content = this.#options.content;
    const transaction = <T>(
      work: (tx: StorageFileWorkflowTransaction<Receipt>) => Promise<T>,
    ) => this.#transaction(scope, signal, permission, work);
    const iterator = (async function* () {
      let cursor = start;
      while (cursor < end) {
        const parts = await transaction(async (tx) => {
          const current = await requireDraft(tx, draft.id);
          if (current.status === 'cancelled') conflict('Draft was cancelled.');
          return tx.listParts(draft.id, cursor, limits.maxPageSize);
        });
        if (parts.length > limits.maxPageSize)
          provider('Persistence returned an oversized page.');
        let advanced = false;
        for (const part of parts) {
          if (cursor >= end) break;
          storageInteger(part.offset, 'part.offset');
          storageInteger(part.size, 'part.size', 1);
          if (
            part.size > limits.maxChunkBytes ||
            part.size !== part.body.size ||
            part.sha256 !== part.body.sha256
          )
            provider('Invalid chunk receipt.');
          if (part.offset + part.size <= cursor) continue;
          if (part.offset > cursor) provider('Draft contains a missing chunk.');
          const bytes = await collectStorageBytes(
            await content.read(scope, part.body, { signal }),
            part.size,
            signal,
          );
          if (bytes.byteLength !== part.size || digest(bytes) !== part.sha256)
            conflict('Draft chunk failed integrity verification.');
          const next = Math.min(end, part.offset + part.size);
          yield bytes.subarray(cursor - part.offset, next - part.offset);
          cursor = next;
          advanced = true;
        }
        if (!advanced) provider('Draft is incomplete.');
      }
    })();
    return new ReadableStream(
      {
        async pull(output) {
          try {
            const next = await iterator.next();
            if (next.done) output.close();
            else output.enqueue(next.value);
          } catch (error) {
            output.error(error);
            await iterator.return(undefined);
          }
        },
        async cancel(reason) {
          controller.abort(reason);
          await iterator.return(undefined);
        },
      },
      { highWaterMark: 0 },
    );
  }
}

async function requireDraft<R>(
  tx: StorageFileWorkflowTransaction<R>,
  id: string,
): Promise<StorageFileDraftRecord<R>> {
  validateIdentity(id);
  const draft = await tx.getDraft(id);
  if (draft === null)
    throw new StorageError('Draft is unavailable.', { code: 'NOT_FOUND' });
  return draft;
}
async function appendState<R>(
  tx: StorageFileWorkflowTransaction<R>,
  draft: StorageFileDraftRecord<R>,
  offset: number,
  size: number,
  sha256: string,
) {
  if (draft.status !== 'open') conflict('Draft is closed for writes.');
  if (offset < draft.size) {
    const previous = (await tx.listParts(draft.id, offset, 1))[0];
    if (
      previous?.offset === offset &&
      previous.size === size &&
      previous.sha256 === sha256
    )
      return { draft, replay: true };
    conflict('Different bytes were already appended at this offset.');
  }
  if (offset !== draft.size)
    conflict('Draft offset changed. Read the current size before appending.');
  return { draft, replay: false };
}
function summary<R>(draft: StorageFileDraftRecord<R>): StorageFileDraft<R> {
  const { id, path, expectedEtag, text, status, size, result, createdAt } =
    draft;
  return Object.freeze({
    id,
    path,
    expectedEtag,
    text,
    status,
    size,
    result,
    createdAt,
  });
}
function validateIdentity(value: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256)
    invalid('Invalid workflow identity.');
}
function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function invalid(message: string): never {
  throw new StorageError(message, { code: 'INVALID_ARGUMENT' });
}
function conflict(message: string): never {
  throw new StorageError(message, { code: 'CONFLICT' });
}
function provider(message: string): never {
  throw new StorageError(message, { code: 'PROVIDER' });
}

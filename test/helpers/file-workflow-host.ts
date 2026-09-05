import { StorageError } from '../../src/storage.error.js';
import type { StorageStagedBody } from '../../src/core/storage-staged-content.js';
import type {
  StorageFileDraftRecord,
  StorageFilePartRecord,
  StorageFileWorkflowPersistence,
  StorageFileWorkflowPermission,
  StorageFileWorkflowTransaction,
} from '../../src/workspace/storage-file-workflow.types.js';

export interface TestReceipt {
  path: string;
  etag: string;
  size: number;
}
export interface TestHead extends TestReceipt {
  body: StorageStagedBody;
}
export interface TestState {
  drafts: Record<string, StorageFileDraftRecord<TestReceipt>>;
  parts: Record<string, StorageFilePartRecord[]>;
  heads: Record<string, TestHead>;
  revision: number;
}

/** Test host: copy-on-write metadata transaction; never used as a provider adapter. */
export class TestFileHost implements StorageFileWorkflowPersistence<
  string,
  TestReceipt
> {
  state: TestState = { drafts: {}, parts: {}, heads: {}, revision: 0 };
  admission: StorageFileWorkflowPermission[] = [];
  authorize: (
    scope: string,
    permission: StorageFileWorkflowPermission,
  ) => void = () => {};
  beforeCommit: (() => void | Promise<void>) | undefined;
  persist: ((state: TestState) => void | Promise<void>) | undefined;
  #tail = Promise.resolve();
  async transaction<Result>(
    scope: string,
    options: {
      signal?: AbortSignal | undefined;
      permission: StorageFileWorkflowPermission;
    },
    work: (tx: StorageFileWorkflowTransaction<TestReceipt>) => Promise<Result>,
  ): Promise<Result> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.admission.push(options.permission);
      this.authorize(scope, options.permission);
      options.signal?.throwIfAborted();
      const state = structuredClone(this.state);
      const key = (id: string) => `${scope}/${id}`;
      const result = await work({
        findDraftByKey: async (idempotencyKey) =>
          Object.entries(state.drafts).find(
            ([id, draft]) =>
              id.startsWith(`${scope}/`) &&
              draft.idempotencyKey === idempotencyKey,
          )?.[1] ?? null,
        getDraft: async (id) => state.drafts[key(id)] ?? null,
        saveDraft: async (draft) => {
          state.drafts[key(draft.id)] = structuredClone(draft);
        },
        listDrafts: async (offset, limit) =>
          Object.entries(state.drafts)
            .filter(([id]) => id.startsWith(`${scope}/`))
            .map(([, draft]) => draft)
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(offset, offset + limit),
        listParts: async (id, offset, limit) =>
          (state.parts[key(id)] ?? [])
            .filter((part) => part.offset + part.size > offset)
            .sort((a, b) => a.offset - b.offset)
            .slice(0, limit),
        putPart: async (id, part) => {
          (state.parts[key(id)] ??= []).push(structuredClone(part));
        },
        commitHeads: async (changes) => {
          const result: TestReceipt[] = [];
          for (const { draft, body } of changes) {
            const current = state.heads[key(draft.path)];
            if (
              draft.expectedEtag === null
                ? current !== undefined
                : current?.etag !== draft.expectedEtag
            )
              throw new StorageError('Stale head', { code: 'CONFLICT' });
            const receipt = {
              path: draft.path,
              etag: `revision-${++state.revision}`,
              size: body.size,
            };
            state.heads[key(draft.path)] = { ...receipt, body };
            result.push(receipt);
          }
          return result;
        },
      });
      await this.beforeCommit?.();
      options.signal?.throwIfAborted();
      await this.persist?.(state);
      this.state = state;
      return result;
    } finally {
      release();
    }
  }
}

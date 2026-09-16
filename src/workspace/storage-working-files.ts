import { createHash } from 'node:crypto';
import { StorageError, isStorageError } from '../storage.error.js';
import { storageBytesStream, storageInteger } from '../core/storage-streams.js';
import { editStorageTextStream } from '../core/storage-text-stream-edit.js';
import type {
  StorageFileCatalogCapability,
  StorageCatalogFile,
  StorageCatalogPath,
  StorageCatalogCommand,
  StorageCatalogPage,
} from './storage-file-catalog.types.js';
import type {
  StorageFileDraft,
  StorageFileWorkflowCapability,
  StorageFileWorkflowOperation,
  StorageFileWorkflowPage,
} from './storage-file-workflow.types.js';

export interface StorageWorkingFile extends StorageCatalogFile {
  readonly operation: 'created' | 'updated';
  readonly pending: true;
}
export interface StorageWorkingFileReceipt {
  readonly path: string;
  readonly etag: string;
  readonly size: number;
}

/** A path-based editing view over durable checkpoints. Saved heads change only on commit. */
export class StorageWorkingFiles<Receipt extends StorageWorkingFileReceipt> {
  readonly catalog: StorageFileCatalogCapability<Receipt | StorageWorkingFile>;
  constructor(
    readonly files: StorageFileCatalogCapability<Receipt>,
    readonly workflow: StorageFileWorkflowCapability<Receipt>,
  ) {
    this.catalog = Object.freeze<
      StorageFileCatalogCapability<Receipt | StorageWorkingFile>
    >({
      ...files,
      list: (input) => this.page(input, 'list'),
      search: (input) => this.page(input, 'search'),
      stat: async (input) => {
        const draft = await this.draft(input);
        return draft && draft.status !== 'committed'
          ? this.receipt(draft)
          : files.stat(this.saved(input, draft));
      },
      readWindow: async (input) => {
        const draft = await this.draft(input);
        if (!draft || draft.status === 'committed')
          return files.readWindow(this.saved(input, draft));
        const page = await workflow.read({
          draftId: draft.id,
          offset: input.offset,
          signal: input.signal,
        });
        if (page.size !== draft.size) this.conflict();
        return {
          ...this.receipt(draft),
          content: page.content,
          offset: page.offset,
          nextOffset: page.nextOffset,
          totalBytes: page.size,
        };
      },
      readStream: async (input) => {
        const draft = await this.draft(input);
        if (!draft || draft.status === 'committed')
          return files.readStream(this.saved(input, draft));
        const stream = await workflow.readStream({
          draftId: draft.id,
          expectedSize: draft.size,
          start: input.start,
          end: input.end,
          signal: input.signal,
        });
        return { ...this.receipt(draft), body: stream.body };
      },
      searchContent: async (input) => {
        const draft = await this.draft(input);
        if (!draft || draft.status === 'committed')
          return files.searchContent(this.saved(input, draft));
        return workflow.searchText({
          draftId: draft.id,
          expectedSize: draft.size,
          query: input.query,
          offset: input.offset,
          signal: input.signal,
        });
      },
      write: (input) => this.write(input),
      edit: async (input) => {
        this.requireWrite();
        const changes =
          input.change.kind === 'batch' ? input.change.changes : [input.change];
        this.textLimit(
          changes
            .map((change) =>
              change.kind === 'append'
                ? change.text
                : change.oldText + change.newText,
            )
            .join(''),
        );
        const prior = await workflow.lookup({
          idempotencyKey: input.commandId,
          signal: input.signal,
        });
        const source: StorageFileDraft<Receipt> | null = prior?.sourceDraftId
          ? await workflow.read({
              draftId: prior.sourceDraftId,
              signal: input.signal,
            })
          : await this.draft(input);
        if (!source || (!prior && source.status === 'committed')) {
          const saved = this.saved(input, source);
          const result = await workflow.stageStream({
            path: input.path,
            expectedEtag: saved.expectedEtag,
            text: true,
            signal: input.signal,
            idempotencyKey: input.commandId,
            contentIdentity: createHash('sha256')
              .update(
                JSON.stringify([
                  'catalog-edit',
                  input.path,
                  input.expectedEtag,
                  changes,
                ]),
              )
              .digest('hex'),
            body: async () => {
              const stream = await files.readStream(saved);
              return editStorageTextStream(stream.body, changes, {
                maxEditBytes: files.limits.maxWriteBytes,
                maxEdits: workflow.limits.maxEdits,
                ...(input.signal ? { signal: input.signal } : {}),
              });
            },
          });
          return this.result(result);
        }
        const result = await workflow.reviseText({
          draftId: source.id,
          expectedSize: source.size,
          changes,
          requestIdentity: JSON.stringify([input.path, input.expectedEtag]),
          idempotencyKey: input.commandId,
          signal: input.signal,
        });
        // The workflow fingerprint includes the source, but the host also fences its public path.
        if (result.path !== input.path) this.conflict();
        return this.result(result);
      },
    });
  }

  async write(
    input: StorageCatalogCommand & { readonly content: string },
  ): Promise<Receipt | StorageWorkingFile> {
    this.requireWrite();
    this.textLimit(input.content);
    const prior = await this.workflow.lookup({
      idempotencyKey: input.commandId,
      signal: input.signal,
    });
    let source: StorageFileDraft<Receipt> | null = prior?.sourceDraftId
      ? await this.workflow.read({
          draftId: prior.sourceDraftId,
          signal: input.signal,
        })
      : null;
    let originalEtag = prior?.expectedEtag ?? undefined;
    if (!prior) {
      source = await this.draft(input);
      const saved = this.saved(input, source);
      if (input.expectedEtag === undefined) {
        if (source) this.conflict();
        try {
          await this.files.stat(input);
          this.conflict();
        } catch (error) {
          if (!isStorageError(error) || error.code !== 'NOT_FOUND') throw error;
        }
      } else if (!source || source.status === 'committed') {
        const file = await this.files.stat(saved);
        if (file.etag !== saved.expectedEtag) this.conflict();
      }
      if (source?.status === 'committed') source = null;
      originalEtag = source
        ? (source.expectedEtag ?? undefined)
        : saved.expectedEtag;
    }
    const bytes = new TextEncoder().encode(input.content);
    const result = await this.workflow.stageStream({
      path: input.path,
      text: true,
      idempotencyKey: input.commandId,
      expectedEtag: originalEtag,
      contentIdentity: createHash('sha256')
        .update(JSON.stringify([input.expectedEtag ?? null, input.content]))
        .digest('hex'),
      body: () => storageBytesStream(bytes),
      signal: input.signal,
      ...(source
        ? { sourceDraftId: source.id, expectedSize: source.size }
        : {}),
    });
    return this.result(result);
  }

  /** Resolve an exact candidate (including committed replay) or the unique unfinished leaf. */
  async draft(
    input: StorageCatalogPath,
  ): Promise<StorageFileDraft<Receipt> | null> {
    if (!this.files.allows('read')) this.denied();
    if (input.expectedEtag !== undefined) {
      try {
        const draft = await this.workflow.read({
          draftId: input.expectedEtag,
          signal: input.signal,
        });
        if (draft.path !== input.path || draft.status === 'cancelled')
          this.conflict();
        return draft;
      } catch (error) {
        if (!isStorageError(error) || error.code !== 'NOT_FOUND') throw error;
        return null;
      }
    }
    const matches = (await this.pending(input)).filter(
      (draft) => draft.path === input.path,
    );
    if (matches.length > 1)
      throw new StorageError(
        'Several unfinished revisions exist. Read an exact listed ETag before editing.',
        { code: 'CONFLICT' },
      );
    return matches[0] ?? null;
  }

  /** Discovery derives from persisted lineage, so process restarts need no local registry. */
  async pending(
    input: StorageFileWorkflowOperation,
  ): Promise<StorageFileDraft<Receipt>[]> {
    if (!this.files.allows('read')) this.denied();
    const drafts: StorageFileDraft<Receipt>[] = [];
    let offset: number | null = 0;
    do {
      const page = await this.workflow.list({ offset, signal: input.signal });
      drafts.push(...page.items);
      if (page.nextOffset !== null && page.nextOffset <= offset)
        throw new StorageError('Invalid draft pagination.', {
          code: 'PROVIDER',
        });
      offset = page.nextOffset;
    } while (offset !== null);
    const predecessors = new Set(
      drafts.flatMap((draft) =>
        draft.status !== 'cancelled' && draft.sourceDraftId
          ? [draft.sourceDraftId]
          : [],
      ),
    );
    return drafts.filter(
      (draft) =>
        ['open', 'sealed'].includes(draft.status) &&
        !predecessors.has(draft.id),
    );
  }

  private async page(
    input: StorageCatalogPage & {
      directory?: string | undefined;
      query?: string;
    },
    mode: 'list' | 'search',
  ) {
    const offset = input.offset ?? 0;
    storageInteger(offset, 'offset', 0);
    const pending = await this.pending(input);
    const paths = new Set(pending.map((draft) => draft.path));
    const items: StorageCatalogFile[] = [];
    const savedByPath = new Map<string, StorageCatalogFile>();
    let cursor: number | null = 0;
    do {
      const page: StorageFileWorkflowPage<StorageCatalogFile> =
        mode === 'list'
          ? await this.files.list({ ...input, offset: cursor })
          : await this.files.search({
              ...input,
              query: input.query!,
              offset: cursor,
            });
      for (const file of page.items) savedByPath.set(file.path, file);
      items.push(...page.items.filter((file) => !paths.has(file.path)));
      if (page.nextOffset !== null && page.nextOffset <= cursor)
        throw new StorageError('Invalid catalog pagination.', {
          code: 'PROVIDER',
        });
      cursor = page.nextOffset;
    } while (cursor !== null);
    const directory = input.directory?.replace(/\/$/u, '');
    items.push(
      ...pending
        .filter((draft) =>
          mode === 'search'
            ? draft.path.toLowerCase().includes(input.query!.toLowerCase())
            : !directory ||
              directory === '.' ||
              draft.path.startsWith(`${directory}/`),
        )
        .map((draft) => ({
          ...savedByPath.get(draft.path),
          ...this.receipt(draft),
        })),
    );
    items.sort(
      (a, b) => a.path.localeCompare(b.path) || a.etag.localeCompare(b.etag),
    );
    const next = offset + this.files.limits.maxPageSize;
    return {
      items: items.slice(offset, next),
      nextOffset: next < items.length ? next : null,
    };
  }
  private saved<T extends StorageCatalogPath>(
    input: T,
    draft: StorageFileDraft<Receipt> | null,
  ): T {
    if (draft?.status !== 'committed') return input;
    if (!draft.result || draft.result.path !== input.path) this.conflict();
    return { ...input, expectedEtag: draft.result.etag };
  }
  private result(
    draft: StorageFileDraft<Receipt>,
  ): Receipt | StorageWorkingFile {
    if (draft.status === 'cancelled') this.conflict();
    if (draft.status === 'committed') {
      if (!draft.result) this.conflict();
      return draft.result;
    }
    return this.receipt(draft);
  }
  private receipt(draft: StorageFileDraft<Receipt>): StorageWorkingFile {
    return {
      path: draft.path,
      fileId: draft.id,
      etag: draft.id,
      size: draft.size,
      contentType: draft.text ? 'text/plain' : 'application/octet-stream',
      operation: draft.expectedEtag === null ? 'created' : 'updated',
      pending: true,
    };
  }
  private textLimit(text: string) {
    if (/[\uD800-\uDFFF]/u.test(text))
      throw new StorageError('Text must be well-formed UTF-8.', {
        code: 'INVALID_ARGUMENT',
      });
    if (
      new TextEncoder().encode(text).byteLength >
      this.files.limits.maxWriteBytes
    )
      throw new StorageError('Write exceeds the per-call text limit.', {
        code: 'LIMIT_EXCEEDED',
      });
  }
  private requireWrite() {
    if (!this.files.allows('write')) this.denied();
  }
  private denied(): never {
    throw new StorageError('Working file operation is not permitted.', {
      code: 'UNAUTHORIZED',
    });
  }
  private conflict(): never {
    throw new StorageError(
      'The working file revision changed. Read the current file before editing.',
      { code: 'CONFLICT' },
    );
  }
}

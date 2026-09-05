import assert from 'node:assert/strict';
import {
  collectStorageBytes,
  StorageClient,
  StorageStagedContentStore,
} from '@nestm/storage/core';
import {
  sha256StorageBytes,
  trimStorageUtf8Chunk,
  verifyStorageChunkReceipt,
} from '@nestm/storage/bytes';
import { createMemoryStorageDriver } from '@nestm/storage/testing';
import {
  StorageFileWorkflow,
  getStorageFileWorkflow,
  mountStorageWorkspace,
  protectStorageFileWorkflowWorkspace,
  type StorageFileDraftRecord,
  type StorageFilePartRecord,
  type StorageFileWorkflowPersistence,
  type StorageFileWorkflowTransaction,
} from '@nestm/storage/workspace';

type Receipt = { path: string; etag: string; size: number };
let state = {
  drafts: new Map<string, StorageFileDraftRecord<Receipt>>(),
  parts: new Map<string, StorageFilePartRecord[]>(),
  heads: new Map<string, Receipt>(),
};
const persistence: StorageFileWorkflowPersistence<string, Receipt> = {
  async transaction<Result>(
    scope: string,
    options: Parameters<
      StorageFileWorkflowPersistence<string, Receipt>['transaction']
    >[1],
    work: (tx: StorageFileWorkflowTransaction<Receipt>) => Promise<Result>,
  ): Promise<Result> {
    assert.equal(scope, 'scope');
    options.signal?.throwIfAborted();
    const pending = structuredClone(state);
    const result = await work({
      findDraftByKey: async (key) =>
        [...pending.drafts.values()].find(
          (draft) => draft.idempotencyKey === key,
        ) ?? null,
      getDraft: async (id) => pending.drafts.get(id) ?? null,
      saveDraft: async (draft) => {
        pending.drafts.set(draft.id, draft);
      },
      listDrafts: async (offset, limit) =>
        [...pending.drafts.values()].slice(offset, offset + limit),
      listParts: async (id, offset, limit) =>
        (pending.parts.get(id) ?? [])
          .filter((part) => part.offset + part.size > offset)
          .slice(0, limit),
      putPart: async (id, part) => {
        pending.parts.set(id, [...(pending.parts.get(id) ?? []), part]);
      },
      commitHeads: async (changes) =>
        changes.map(({ draft, body }) => {
          assert.equal(pending.heads.has(draft.path), false);
          const receipt = {
            path: draft.path,
            size: body.size,
            etag: body.sha256,
          };
          pending.heads.set(draft.path, receipt);
          return receipt;
        }),
    });
    options.signal?.throwIfAborted();
    state = pending;
    return result;
  },
};
const client = new StorageClient(
  'packed-workflow',
  createMemoryStorageDriver(),
);
const content = new StorageStagedContentStore({
  client,
  key: (scope: string, id) => `${scope}/${id}`,
});
const controller = new AbortController();
const workspace = protectStorageFileWorkflowWorkspace({
  workspace: mountStorageWorkspace(client, {
    prefix: 'scope',
    permissions: ['read', 'list', 'create', 'replace'],
  }),
  workflows: new StorageFileWorkflow({ content, persistence }).mount('scope'),
  signal: controller.signal,
  authorize: () => {},
});
const workflow = getStorageFileWorkflow<Receipt>(workspace);
const draft = await workflow.begin({
  path: 'file.txt',
  text: true,
  idempotencyKey: 'call',
});
const bytes = new TextEncoder().encode('hello😀');
await workflow.append({ draftId: draft.id, bytes, offset: 0 });
const sha256 = await sha256StorageBytes(bytes, { maxBytes: 100 });
assert.equal(
  await verifyStorageChunkReceipt(
    new Blob([bytes]),
    { offset: 0, size: bytes.length, sha256 },
    { offset: 0, maxBytes: 100 },
  ),
  bytes.length,
);
assert.equal(
  trimStorageUtf8Chunk(bytes.slice(0, 7), { final: false }).byteLength,
  5,
);
const request = { drafts: [{ draftId: draft.id, size: bytes.length, sha256 }] };
const receipts = await workflow.commit(request);
assert.deepEqual(await workflow.commit(request), receipts);
assert.equal(receipts[0]?.etag, sha256);
const body = state.drafts.get(draft.id)?.body;
assert.ok(body);
assert.deepEqual(
  await collectStorageBytes(await content.read('scope', body), 100),
  bytes,
);
controller.abort();
await assert.rejects(workflow.list(), { name: 'AbortError' });
await client.onApplicationShutdown();

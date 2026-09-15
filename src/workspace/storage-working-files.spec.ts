import { StorageClient } from '../storage.client.js';
import { StorageError } from '../storage.error.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';
import {
  readStorageTextWindow,
  storageBytesStream,
} from '../core/storage-streams.js';
import {
  TestFileHost,
  type TestReceipt,
} from '../../test/helpers/file-workflow-host.js';
import { StorageFileWorkflow } from './storage-file-workflow.js';
import { StorageWorkingFiles } from './storage-working-files.js';
import type { StorageFileCatalogCapability } from './storage-file-catalog.types.js';

function setup() {
  const persistence = new TestFileHost();
  const content = new StorageStagedContentStore({
    client: new StorageClient('working', createMemoryStorageDriver()),
    key: (scope: string, id) => `${scope}/${id}`,
  });
  const service = new StorageFileWorkflow({ content, persistence });
  const workflow = service.mount('scope', {
    limits: { maxChunkBytes: 64 * 1024, maxTextBytes: 128, maxReadBytes: 32 },
  });
  const files: StorageFileCatalogCapability<TestReceipt> = {
    kind: 'storage-file-catalog',
    version: 1,
    limits: {
      maxReadBytes: 32,
      maxWriteBytes: 128,
      maxPageSize: 2,
      maxSearchScanBytes: 262144,
      maxSearchMatches: 12,
      maxPathBytes: 1024,
    },
    allows: () => true,
    stat: async (input) => {
      const file = persistence.state.heads[`scope/${input.path}`];
      if (!file) throw new StorageError('Missing', { code: 'NOT_FOUND' });
      if (input.expectedEtag !== undefined && input.expectedEtag !== file.etag)
        throw new StorageError('Stale', { code: 'CONFLICT' });
      return { ...file, fileId: file.path, contentType: 'text/plain' };
    },
    list: async (input) => {
      const all = await Promise.all(
        Object.values(persistence.state.heads).map((file) => files.stat(file)),
      );
      const offset = input.offset ?? 0;
      return {
        items: all.slice(offset, offset + 2),
        nextOffset: offset + 2 < all.length ? offset + 2 : null,
      };
    },
    search: async (input) => files.list(input),
    readWindow: async (input) => {
      const file = await files.stat(input);
      const head = persistence.state.heads[`scope/${input.path}`]!;
      return {
        ...file,
        totalBytes: file.size,
        ...(await readStorageTextWindow(
          (range, signal) =>
            content.read('scope', head.body, { range, signal }),
          { size: file.size, offset: input.offset, maxBytes: 32 },
        )),
      };
    },
    searchContent: async () => {
      throw new Error('Unused');
    },
    write: async () => {
      throw new Error('Must stage');
    },
    edit: async () => {
      throw new Error('Must stage');
    },
  };
  return {
    persistence,
    content,
    service,
    workflow,
    files,
    working: new StorageWorkingFiles(files, workflow),
  };
}

it('resumes path-based writes and edits across instances, rejects changed replay, and finishes once', async () => {
  const { files, workflow, working, persistence } = setup();
  const input = {
    path: 'data.csv',
    commandId: 'write',
    content: 'name,value\nA,1',
  };
  const first = await working.catalog.write(input);
  const resumed = new StorageWorkingFiles(files, workflow);
  expect(await resumed.catalog.write(input)).toEqual(first);
  await expect(
    resumed.catalog.write({ ...input, content: 'changed' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(persistence.state.heads).toEqual({});
  const edit = {
    path: input.path,
    expectedEtag: first.etag,
    commandId: 'edit',
    change: { kind: 'append' as const, text: '\nB,2😀' },
  };
  const second = await resumed.catalog.edit(edit);
  expect(await resumed.catalog.edit(edit)).toEqual(second);
  await expect(
    resumed.catalog.edit({ ...edit, expectedEtag: 'different' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    resumed.catalog.edit({ ...edit, path: 'wrong.csv' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect((await resumed.catalog.readWindow({ path: input.path })).content).toBe(
    input.content + edit.change.text,
  );
  expect((await resumed.pending({})).map((draft) => draft.id)).toEqual([
    second.etag,
  ]);
  const [saved] = await workflow.commit({
    drafts: [{ draftId: second.etag, size: second.size }],
  });
  expect(await resumed.catalog.edit(edit)).toEqual(saved);
  expect(
    (
      await resumed.catalog.stat({
        path: input.path,
        expectedEtag: second.etag,
      })
    ).etag,
  ).toBe(saved!.etag);
  const next = await resumed.catalog.edit({
    ...edit,
    expectedEtag: second.etag,
    commandId: 'next',
  });
  expect(next.etag).not.toBe(saved!.etag);
  const [newSaved] = await workflow.commit({
    drafts: [{ draftId: next.etag, size: next.size }],
  });
  await expect(
    resumed.catalog.readWindow({ path: input.path, expectedEtag: second.etag }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(newSaved!.size).toBe(
    second.size + new TextEncoder().encode(edit.change.text).length,
  );
});

it('keeps merged discovery bounded and preserves saved heads and candidates after failed edits', async () => {
  const { working, workflow } = setup();
  for (let i = 0; i < 5; i++)
    await working.catalog.write({
      path: `${i}.csv`,
      content: 'old,old',
      commandId: `write${i}`,
    });
  const first = await working.catalog.list({});
  expect(first.items).toHaveLength(2);
  const second = await working.catalog.list({ offset: first.nextOffset! });
  const third = await working.catalog.list({ offset: second.nextOffset! });
  expect(
    [...first.items, ...second.items, ...third.items].map((file) => file.path),
  ).toEqual(['0.csv', '1.csv', '2.csv', '3.csv', '4.csv']);
  expect(third.nextOffset).toBeNull();
  const file = first.items[0]!;
  await expect(
    working.catalog.edit({
      path: file.path,
      expectedEtag: file.etag,
      commandId: 'bad',
      change: { kind: 'replace', oldText: 'old', newText: 'new' },
    }),
  ).rejects.toMatchObject({ diagnostic: { reason: 'ambiguous_target' } });
  expect((await working.catalog.stat({ path: file.path })).etag).toBe(
    file.etag,
  );
  await workflow.commit({ drafts: [{ draftId: file.etag, size: file.size }] });
  expect(
    (await working.catalog.list({})).items.map((file) => file.path),
  ).toEqual(['0.csv', '1.csv']);
});

it('streams a file far above the buffered text limit and atomically rejects a failing later edit', async () => {
  const { workflow } = setup();
  const text = 'name,value\n' + 'row,123😀\n'.repeat(100_000) + 'unique,end\n';
  const draft = await workflow.stageStream({
    path: 'large.csv',
    text: true,
    idempotencyKey: 'large',
    contentIdentity: 'large-fixture',
    body: () => storageBytesStream(new TextEncoder().encode(text)),
  });
  expect(draft.size).toBeGreaterThan(1_000_000);
  const changed = await workflow.reviseText({
    draftId: draft.id,
    expectedSize: draft.size,
    idempotencyKey: 'change',
    changes: [
      { kind: 'replace', oldText: 'unique,end', newText: 'unique,done' },
    ],
  });
  const tail = await workflow.read({
    draftId: changed.id,
    offset: changed.size - 12,
  });
  expect(tail.content).toBe('unique,done\n');
  await expect(
    workflow.reviseText({
      draftId: changed.id,
      expectedSize: changed.size,
      idempotencyKey: 'fail',
      changes: [
        { kind: 'replace', oldText: 'unique,done', newText: 'changed' },
        { kind: 'replace', oldText: 'absent', newText: 'x' },
      ],
    }),
  ).rejects.toMatchObject({
    diagnostic: { editIndex: 1, reason: 'missing_target' },
  });
  expect(await workflow.lookup({ idempotencyKey: 'fail' })).toBeNull();
  expect(
    (await workflow.read({ draftId: changed.id, offset: changed.size - 12 }))
      .content,
  ).toBe('unique,done\n');
  const [saved] = await workflow.commit({
    drafts: [{ draftId: changed.id, size: changed.size }],
  });
  expect(saved!.size).toBe(changed.size);
});

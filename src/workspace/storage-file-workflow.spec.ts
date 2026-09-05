import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageClient } from '../storage.client.js';
import { StorageError } from '../storage.error.js';
import { createFsStorageDriver } from '../files-sdk/fs/index.js';
import {
  StorageStagedContentStore,
  type StorageStagedContent,
} from '../core/storage-staged-content.js';
import { storageBytesStream } from '../core/storage-streams.js';
import { TestFileHost } from '../../test/helpers/file-workflow-host.js';
import { StorageFileWorkflow } from './storage-file-workflow.js';

const bytes = (text: string) => new TextEncoder().encode(text);
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-unit-'));
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const driver = createFsStorageDriver({ adapter: { root } });
  const client = new StorageClient('workflow', driver);
  const content = new StorageStagedContentStore({
    client,
    key: (scope: string, id) => `${scope}/${id}`,
  });
  const persistence = new TestFileHost();
  const service = new StorageFileWorkflow({ content, persistence });
  return {
    driver,
    client,
    content,
    persistence,
    service,
    capability: service.mount('scope'),
  };
}

describe('StorageFileWorkflow host transaction protocol', () => {
  it('resumes across service instances; enforces chunk identity, scope and atomic replay', async () => {
    const { service, capability: files, persistence } = setup();
    const draft = await files.begin({
      path: 'hello.txt',
      text: true,
      idempotencyKey: 'begin',
    });
    expect(
      await files.begin({
        path: 'hello.txt',
        text: true,
        idempotencyKey: 'begin',
      }),
    ).toEqual(draft);
    await expect(
      files.begin({ path: 'other.txt', text: true, idempotencyKey: 'begin' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const input = { draftId: draft.id, offset: 0, bytes: bytes('hello😀') };
    await Promise.all([files.append(input), files.append(input)]);
    await expect(
      files.append({ ...input, bytes: bytes('different') }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      service.mount('other').read({ draftId: draft.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const resumed = service.mount('scope');
    expect((await resumed.read({ draftId: draft.id })).content).toBe('hello😀');
    const parts = await resumed.parts({ draftId: draft.id });
    expect(parts.items).toHaveLength(1);
    expect(parts.items[0]).not.toHaveProperty('body');
    const request = { drafts: [{ draftId: draft.id, size: 9 }] };
    const receipt = await resumed.commit(request);
    expect(await files.commit(request)).toEqual(receipt);
    expect(persistence.state.revision).toBe(1);
    await expect(files.cancel({ draftId: draft.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      files.commit({
        drafts: [{ draftId: draft.id, size: 9, sha256: '0'.repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('rolls back an earlier head in a stale multi-file batch; supports retry and cancellation', async () => {
    const { capability: files, persistence } = setup();
    const initial = await files.begin({
      path: 'z.txt',
      text: true,
      idempotencyKey: 'initial',
    });
    await files.commit({ drafts: [{ draftId: initial.id, size: 0 }] });
    const fresh = await files.begin({
      path: 'a.txt',
      text: true,
      idempotencyKey: 'fresh',
    });
    const stale = await files.begin({
      path: 'z.txt',
      text: true,
      expectedEtag: 'stale',
      idempotencyKey: 'stale',
    });
    const request = {
      drafts: [
        { draftId: fresh.id, size: 0 },
        { draftId: stale.id, size: 0 },
      ],
    };
    await expect(files.commit(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(persistence.state.heads['scope/a.txt']).toBeUndefined();
    expect(persistence.state.revision).toBe(1);
    expect((await files.read({ draftId: fresh.id })).status).toBe('sealed');
    await expect(files.commit(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await files.cancel({ draftId: fresh.id });
    await expect(files.commit(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('reauthorizes mutation replay with explicit intent; viewers can still read', async () => {
    const { capability: files, persistence } = setup();
    const begin = { path: 'hello.txt', text: true, idempotencyKey: 'begin' };
    const draft = await files.begin(begin);
    await files.append({ draftId: draft.id, offset: 0, bytes: bytes('a') });
    persistence.authorize = (_, permission) => {
      if (permission !== 'read')
        throw new StorageError('Revoked', { code: 'UNAUTHORIZED' });
    };
    expect((await files.read({ draftId: draft.id })).content).toBe('a');
    await expect(files.begin(begin)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      files.append({ draftId: draft.id, offset: 0, bytes: bytes('a') }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      files.commit({ drafts: [{ draftId: draft.id, size: 1 }] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(persistence.admission.at(-1)).toBe('commit');
  });
  it('fails closed on corrupt staged parts and invalid UTF-8', async () => {
    const setup_ = setup();
    const { content, persistence } = setup_;
    const corrupt: StorageStagedContent<string> = {
      write: content.write.bind(content),
      read: async () => storageBytesStream(bytes('bad')),
    };
    const files = new StorageFileWorkflow({
      content: corrupt,
      persistence,
    }).mount('scope');
    const draft = await files.begin({
      path: 'x',
      text: true,
      idempotencyKey: 'x',
    });
    await expect(
      files.append({
        draftId: draft.id,
        offset: 0,
        bytes: new Uint8Array([0xf0, 0x9f]),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await files.append({ draftId: draft.id, offset: 0, bytes: bytes('yes') });
    await expect(
      files.commit({ drafts: [{ draftId: draft.id, size: 3 }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(persistence.state.heads).toEqual({});
  });
  it('closes retained capabilities on abort and rolls back abort before host commit', async () => {
    const { service, persistence } = setup();
    const controller = new AbortController();
    const files = service.mount('scope', { signal: controller.signal });
    persistence.beforeCommit = () => controller.abort();
    await expect(
      files.begin({ path: 'x', text: true, idempotencyKey: 'x' }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(persistence.state.drafts).toEqual({});
    await expect(files.list()).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('only one concurrent create wins and empty binary drafts commit correctly', async () => {
    const { capability: files, persistence } = setup();
    const drafts = await Promise.all(
      ['a', 'b'].map((idempotencyKey) =>
        files.begin({ path: 'same.bin', text: false, idempotencyKey }),
      ),
    );
    const results = await Promise.allSettled(
      drafts.map((draft) =>
        files.commit({ drafts: [{ draftId: draft.id, size: 0 }] }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(persistence.state.revision).toBe(1);
  });
});

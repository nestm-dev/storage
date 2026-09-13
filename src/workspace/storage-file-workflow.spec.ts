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

describe('recoverable text checkpoints', () => {
  it('retains every checkpoint across services and commits only the selected revision', async () => {
    const { service, persistence } = setup();
    const files = service.mount('scope', { limits: { maxChunkBytes: 7 } });
    const first = await files.stageText({
      path: 'notes.md',
      idempotencyKey: 'stage',
      content: '\uFEFF# Notes\r\n😀 first\r\nkeep',
    });
    expect(first).toMatchObject({ status: 'sealed', sourceDraftId: null });
    const request = {
      draftId: first.id,
      expectedSize: first.size,
      idempotencyKey: 'edit',
      changes: [
        { kind: 'replace' as const, oldText: 'first', newText: 'second' },
      ],
    };
    const revised = await files.reviseText(request);
    expect(revised).toMatchObject({
      sourceDraftId: first.id,
      path: 'notes.md',
      status: 'sealed',
    });
    expect(persistence.state.revision).toBe(0);
    const resumed = service.mount('scope', { limits: { maxChunkBytes: 7 } });
    expect((await resumed.read({ draftId: first.id })).content).toContain(
      'first',
    );
    expect((await resumed.read({ draftId: revised.id })).content).toContain(
      'second',
    );
    expect(await resumed.reviseText(request)).toEqual(revised);
    await expect(
      resumed.append({
        draftId: first.id,
        offset: first.size,
        bytes: bytes('more'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await resumed.commit({
      drafts: [{ draftId: revised.id, size: revised.size }],
    });
    expect(persistence.state.revision).toBe(1);
    expect((await resumed.read({ draftId: first.id })).content).toContain(
      'first',
    );
  });
  it('leaves an open source editable when a batch fails and rejects stale sizes and conflicting keys', async () => {
    const { capability: files } = setup();
    const first = await files.begin({
      path: 'data.csv',
      idempotencyKey: 'start',
      text: true,
    });
    const source = await files.append({
      draftId: first.id,
      offset: 0,
      bytes: bytes('a,b\n1,2'),
    });
    const input = {
      draftId: source.id,
      expectedSize: source.size,
      idempotencyKey: 'edit',
      changes: [
        { kind: 'replace' as const, oldText: '1,2', newText: '3,4' },
        { kind: 'replace' as const, oldText: 'missing', newText: 'new' },
      ],
    };
    await expect(files.reviseText(input)).rejects.toMatchObject({
      diagnostic: { editIndex: 1 },
      applied: false,
    });
    expect((await files.list()).items).toHaveLength(1);
    expect(await files.read({ draftId: source.id })).toMatchObject({
      status: 'open',
      content: 'a,b\n1,2',
    });
    await expect(
      files.reviseText({ ...input, expectedSize: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const good = { ...input, changes: input.changes.slice(0, 1) };
    await files.reviseText(good);
    await expect(
      files.reviseText({
        ...good,
        changes: [{ kind: 'append', text: 'different' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('fences concurrent source appends, revocation and read/write/mutation grants', async () => {
    const { service, capability: files, persistence, content } = setup();
    const source = await files.begin({
      path: 'notes.txt',
      idempotencyKey: 'start',
      text: true,
    });
    await files.append({ draftId: source.id, offset: 0, bytes: bytes('old') });
    const request = {
      draftId: source.id,
      expectedSize: 3,
      idempotencyKey: 'edit',
      changes: [{ kind: 'replace' as const, oldText: 'old', newText: 'new' }],
    };
    await expect(
      service.mount('other').reviseText(request),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      files.restrict({ permissions: ['write'] }).reviseText(request),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      files.restrict({ permissions: ['read'] }).reviseText(request),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      files.restrict({ mutations: ['replace'] }).reviseText(request),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const write = content.write.bind(content);
    const raced = new StorageFileWorkflow({
      persistence,
      content: {
        read: content.read.bind(content),
        write: async (...args) => {
          const body = await write(...args);
          await files.append({
            draftId: source.id,
            offset: 3,
            bytes: bytes('!'),
          });
          return body;
        },
      },
    }).mount('scope');
    await expect(raced.reviseText(request)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await files.list()).items).toHaveLength(1);
    expect((await files.read({ draftId: source.id })).content).toBe('old!');
  });
  it('bounds buffering and handles concurrent replay, cancellation and stale target rollback', async () => {
    const { capability: files, persistence } = setup();
    await expect(
      files
        .restrict({ limits: { maxTextBytes: 3 } })
        .stageText({ path: 'a.txt', content: '😀', idempotencyKey: 'large' }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const original = await files.stageText({
      path: 'z.txt',
      content: 'old',
      idempotencyKey: 'original',
    });
    const [receipt] = await files.commit({
      drafts: [{ draftId: original.id, size: original.size }],
    });
    const staged = await files.stageText({
      path: 'z.txt',
      content: 'next',
      expectedEtag: receipt!.etag,
      idempotencyKey: 'staged',
    });
    const request = {
      draftId: staged.id,
      expectedSize: staged.size,
      idempotencyKey: 'revise',
      changes: [{ kind: 'append' as const, text: '!' }],
    };
    const [a, b] = await Promise.all([
      files.reviseText(request),
      files.reviseText(request),
    ]);
    expect(a.id).toBe(b.id);
    const other = await files.stageText({
      path: 'a.txt',
      content: 'first',
      idempotencyKey: 'other',
    });
    await files.commit({ drafts: [{ draftId: staged.id, size: staged.size }] });
    await expect(
      files.commit({
        drafts: [
          { draftId: other.id, size: other.size },
          { draftId: a.id, size: a.size },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(persistence.state.heads['scope/a.txt']).toBeUndefined();
    await files.cancel({ draftId: a.id });
    await expect(
      files.reviseText({
        ...request,
        draftId: a.id,
        expectedSize: a.size,
        idempotencyKey: 'cancelled',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

it('buffers exact draft text for host validation while enforcing size and scope', async () => {
  const { service, capability: files } = setup();
  const draft = await files.stageText({
    path: 'data.json',
    content: '{"value":"😀"}',
    idempotencyKey: 'json',
  });
  expect(
    await files.readText({ draftId: draft.id, expectedSize: draft.size }),
  ).toMatchObject({ content: '{"value":"😀"}', id: draft.id });
  await expect(
    files.readText({ draftId: draft.id, expectedSize: 0 }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  await expect(
    files
      .restrict({ limits: { maxTextBytes: 2 } })
      .readText({ draftId: draft.id, expectedSize: draft.size }),
  ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await expect(
    service
      .mount('other')
      .readText({ draftId: draft.id, expectedSize: draft.size }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await files.cancel({ draftId: draft.id });
  await expect(
    files.readText({ draftId: draft.id, expectedSize: draft.size }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

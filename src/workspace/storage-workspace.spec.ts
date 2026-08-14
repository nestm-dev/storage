import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFsStorageDriver } from '../files-sdk/fs/index.js';
import { StorageClient } from '../storage.client.js';
import { StorageError, StorageErrorCode } from '../storage.error.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import type { StorageDriver } from '../storage.driver.js';
import type { StorageObject } from '../storage.types.js';

import {
  isStorageWorkspaceError,
  mountStorageWorkspace,
  type StorageWorkspacePermission,
} from './index.js';

const ALL_PERMISSIONS: readonly StorageWorkspacePermission[] = [
  'list',
  'read',
  'search',
  'create',
  'replace',
  'copy',
  'move',
  'delete',
];

const MALICIOUS_ETAGS = [
  '',
  '"etag-a", "etag-b"',
  'etag-a", "etag-b',
  '*',
  'W/"etag"',
  'w/"etag"',
  'unsafe\r\nIf-Match: *',
  '"etag',
  'etag"',
  '""etag""',
  'etag,other',
  'etag\\other',
  ' etag',
  'etag ',
  'x'.repeat(1_025),
] as const;

function mountedFs(root: string) {
  const client = new StorageClient(
    'workspace-tests',
    createFsStorageDriver({ adapter: { root } }),
  );
  return {
    client,
    workspace: mountStorageWorkspace(client, {
      permissions: ALL_PERMISSIONS,
      prefix: 'runs/run-1',
    }),
  };
}

describe('StorageWorkspace', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nestm-workspace-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('defaults to read-only permissions and child mounts only narrow authority', () => {
    const client = new StorageClient('memory', createMemoryStorageDriver());
    const workspace = mountStorageWorkspace(client, { prefix: 'runs/one' });

    expect([...workspace.permissions]).toEqual(['list', 'read', 'search']);
    const exposed = workspace.permissions as Set<StorageWorkspacePermission>;
    exposed.add('delete');
    expect(workspace.allows('delete')).toBe(false);

    const child = workspace.mount('src', {
      limits: { maxReadBytes: 10 },
      permissions: ['read'],
    });
    expect([...child.permissions]).toEqual(['read']);
    expect(child.limits.maxReadBytes).toBe(10);
    expect(() => child.mount('nested', { permissions: ['create'] })).toThrow(
      expect.objectContaining({ code: StorageErrorCode.UNAUTHORIZED }),
    );
    expect(() =>
      child.mount('nested', { limits: { maxReadBytes: 11 } }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
    );
  });

  it.each([
    '',
    '/absolute',
    'a//b',
    'a/./b',
    'a/../b',
    'a\\b',
    'file:stream',
    'CON',
    'aux.txt',
    'dir/name.',
    'dir/name ',
    'dir/\u0000name',
    'e\u0301.txt',
  ])('rejects non-portable file path %j', async (path) => {
    const { workspace } = mountedFs(root);
    await expect(workspace.stat(path)).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
  });

  it('requires a non-empty strict trusted prefix', () => {
    const client = new StorageClient('memory', createMemoryStorageDriver());
    for (const prefix of ['', '/root', 'root\\child', 'root/../child']) {
      expect(() => mountStorageWorkspace(client, { prefix })).toThrow(
        expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
      );
    }
  });

  it('cannot read through a filesystem symlink into a sibling prefix', async () => {
    mkdirSync(join(root, 'runs/run-1'), { recursive: true });
    mkdirSync(join(root, 'runs/other'), { recursive: true });
    writeFileSync(join(root, 'runs/other/secret.txt'), 'secret');
    symlinkSync(
      join(root, 'runs/other/secret.txt'),
      join(root, 'runs/run-1/link.txt'),
      'file',
    );
    const { workspace } = mountedFs(root);

    await expect(workspace.readText('link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    await expect(
      workspace.copyFile('link.txt', 'copied.txt', { etag: 'source-etag' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
  });

  it('creates, conditionally replaces, reads, and conditionally deletes files', async () => {
    const { workspace } = mountedFs(root);
    const created = await workspace.writeFile('src/a.ts', 'export {};', {
      contentType: 'text/typescript',
      metadata: { owner: 'agent' },
      mode: 'create',
    });
    expect(created).toMatchObject({
      contentType: 'text/typescript',
      kind: 'file',
      path: 'src/a.ts',
      size: 10,
    });
    expect(created.etag).toBeTypeOf('string');

    await expect(
      workspace.writeFile('src/a.ts', 'collision', { mode: 'create' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(
      workspace.writeFile('src/a.ts', 'changed', {
        etag: 'stale',
        mode: 'replace',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });

    const replaced = await workspace.writeFile('src/a.ts', 'changed', {
      etag: created.etag ?? '',
      mode: 'replace',
    });
    await expect(workspace.readText('src/a.ts')).resolves.toMatchObject({
      path: 'src/a.ts',
      text: 'changed',
    });
    await workspace.deleteFile('src/a.ts', { etag: replaced.etag ?? '' });
    await expect(workspace.stat('src/a.ts')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });
  });

  it('rejects non-canonical ETags for every conditional mutation', async () => {
    const driver = createFsStorageDriver({ adapter: { root } });
    const workspace = mountStorageWorkspace(
      new StorageClient('canonical-etags', driver),
      { permissions: ALL_PERMISSIONS, prefix: 'scope' },
    );

    for (const etag of MALICIOUS_ETAGS) {
      const label = JSON.stringify(etag.slice(0, 80));
      await expect(
        workspace.writeFile('target.txt', 'replacement', {
          etag,
          mode: 'replace',
        }),
        label,
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      await expect(
        workspace.copyFile('source.txt', 'copy.txt', { etag }),
        label,
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      await expect(
        workspace.moveFile('source.txt', 'move.txt', { etag }),
        label,
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      await expect(
        workspace.deleteFile('target.txt', { etag }),
        label,
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    }
  });

  it('uses the fixed ETag limit independently of the workspace path limit', async () => {
    const driver = createFsStorageDriver({ adapter: { root } });
    const workspace = mountStorageWorkspace(
      new StorageClient('etag-limit', driver),
      {
        limits: { maxPathBytes: 16 },
        permissions: ALL_PERMISSIONS,
        prefix: 'scope',
      },
    );
    await workspace.writeFile('target.txt', 'original', { mode: 'create' });

    await expect(
      workspace.writeFile('target.txt', 'replacement', {
        etag: 'a'.repeat(1_024),
        mode: 'replace',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
  });

  it('fails closed when a provider returns a non-canonical ETag', async () => {
    const driver = createMemoryStorageDriver({
      adapter: { initial: { 'scope/file.txt': 'body' } },
    });
    const originalHead = driver.head.bind(driver);
    driver.head = async (key, options) => ({
      ...(await originalHead(key, options)),
      etag: '"etag-a", "etag-b"',
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('malformed-provider-etag', driver),
      { prefix: 'scope' },
    );

    await expect(workspace.stat('file.txt')).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
    });
  });

  it('bounds reads by streamed bytes even when provider metadata lies', async () => {
    const driver = createMemoryStorageDriver();
    driver.download = async (key): Promise<StorageObject> => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('123'));
          controller.enqueue(new TextEncoder().encode('456'));
          controller.close();
        },
      }),
      contentType: 'text/plain',
      key,
      name: key,
      size: 1,
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('lying', driver),
      { limits: { maxReadBytes: 5 }, prefix: 'scope' },
    );

    await expect(workspace.readText('large.txt')).rejects.toMatchObject({
      code: StorageErrorCode.LIMIT_EXCEEDED,
      key: 'large.txt',
    });
  });

  it('lists and searches relative to a selected directory with opaque cursors', async () => {
    const { workspace } = mountedFs(root);
    for (const path of [
      'src/a.ts',
      'src/b.ts',
      'src/readme.md',
      'other/c.ts',
    ]) {
      await workspace.writeFile(path, path, { mode: 'create' });
    }

    const first = await workspace.list({
      directory: 'src',
      limit: 1,
      recursive: true,
    });
    expect(first.entries).toHaveLength(1);
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    const second = await workspace.list({ cursor: first.cursor });
    expect(second.entries).toHaveLength(1);
    await expect(
      workspace.list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });

    const searched = await workspace.search('*.ts', {
      directory: 'src',
      limit: 1,
    });
    expect(searched.entries[0]?.path).toMatch(/^src\/[ab]\.ts$/u);
    expect(searched.cursor).toBeTypeOf('string');
    const continued = await workspace.search('', { cursor: searched.cursor });
    expect(continued.entries[0]?.path).toMatch(/^src\/[ab]\.ts$/u);
    expect(continued.entries[0]?.path).not.toBe(searched.entries[0]?.path);
  });

  it('binds cursors to one workspace, operation, and query', async () => {
    const { workspace } = mountedFs(root);
    await workspace.writeFile('a.txt', 'a', { mode: 'create' });
    await workspace.writeFile('b.txt', 'b', { mode: 'create' });
    const listed = await workspace.list({ limit: 1, recursive: true });
    expect(listed.cursor).toBeTypeOf('string');

    await expect(
      workspace.search('', { cursor: listed.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });

    const next = await workspace.list({ limit: 1, recursive: true });
    const child = workspace.mount('child');
    await expect(child.list({ cursor: next.cursor })).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    await expect(
      workspace.list({ cursor: '../not-a-token' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
  });

  it('fails closed on out-of-scope and wrong-coordinate provider results', async () => {
    const driver = createMemoryStorageDriver({
      adapter: { initial: { 'scope/requested.txt': 'ok' } },
    });
    driver.head = async () => ({
      contentType: 'text/plain',
      key: 'scope/other.txt',
      name: 'scope/other.txt',
      size: 2,
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('wrong-key', driver),
      { prefix: 'scope' },
    );
    await expect(workspace.stat('requested.txt')).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
    });

    driver.list = async () => ({
      items: [
        {
          contentType: 'text/plain',
          key: 'outside/secret.txt',
          name: 'outside/secret.txt',
          size: 6,
        },
      ],
    });
    await expect(workspace.list()).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
    });
  });

  it('sanitizes spoofed workspace/provider errors without leaking prefix or cause', async () => {
    const driver = createMemoryStorageDriver();
    const secret = new Error('credential secret');
    driver.head = async () => {
      const spoof = new Error('raw provider path scope/private.txt', {
        cause: secret,
      });
      spoof.name = 'StorageWorkspaceError';
      Object.assign(spoof, {
        code: StorageErrorCode.PROVIDER,
        operation: 'stat',
        path: 'scope/private.txt',
        permanent: false,
      });
      throw spoof;
    };
    const workspace = mountStorageWorkspace(
      new StorageClient('provider', driver),
      { prefix: 'scope' },
    );

    const error = await workspace
      .stat('file.txt')
      .catch((caught: unknown) => caught);
    expect(isStorageWorkspaceError(error)).toBe(true);
    expect(error).toMatchObject({
      code: StorageErrorCode.PROVIDER,
      key: 'file.txt',
      message: 'Workspace stat failed for "file.txt".',
      path: 'file.txt',
    });
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).message).not.toContain('scope');
  });

  it('copies create-only with metadata and retains a destination after an unconfirmed source delete', async () => {
    const driver = createFsStorageDriver({ adapter: { root } });
    const originalDelete = driver.deleteConditional.bind(driver);
    let rejectSourceDelete = true;
    driver.deleteConditional = vi.fn(async (key, options) => {
      if (key === 'scope/source.txt' && rejectSourceDelete) {
        rejectSourceDelete = false;
        throw new StorageError('simulated source conflict', {
          code: StorageErrorCode.CONFLICT,
          key,
          permanent: true,
        });
      }
      return originalDelete(key, options);
    });
    const client = new StorageClient('move', driver);
    const workspace = mountStorageWorkspace(client, {
      permissions: ALL_PERMISSIONS,
      prefix: 'scope',
    });
    const source = await workspace.writeFile('source.txt', 'body', {
      contentType: 'text/plain',
      metadata: { copied: 'yes' },
      mode: 'create',
    });

    const copied = await workspace.copyFile('source.txt', 'copy.txt', {
      etag: source.etag ?? '',
    });
    expect(copied.contentType).toBe('text/plain');
    await expect(
      workspace.copyFile('source.txt', 'copy.txt', {
        etag: source.etag ?? '',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(
      workspace.moveFile('source.txt', 'moved.txt', {
        etag: source.etag ?? '',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(workspace.stat('source.txt')).resolves.toBeDefined();
    await expect(workspace.stat('moved.txt')).resolves.toBeDefined();

    const storedCopy = await client.head('scope/copy.txt');
    expect(storedCopy.metadata).toEqual({ copied: 'yes' });
  });

  it('retains a destination when caller cancellation makes source deletion ambiguous', async () => {
    const driver = createFsStorageDriver({ adapter: { root } });
    const originalDelete = driver.deleteConditional.bind(driver);
    const controller = new AbortController();
    driver.deleteConditional = vi.fn(async (key, options) => {
      if (key === 'scope/source.txt') {
        controller.abort(new Error('agent stopped'));
        throw new StorageError('source delete aborted', {
          aborted: true,
          code: StorageErrorCode.ABORTED,
          key,
          permanent: true,
        });
      }
      return originalDelete(key, options);
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('cancelled-move', driver),
      { permissions: ALL_PERMISSIONS, prefix: 'scope' },
    );
    const source = await workspace.writeFile('source.txt', 'body', {
      mode: 'create',
    });

    await expect(
      workspace.moveFile('source.txt', 'moved.txt', {
        etag: source.etag ?? '',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    expect(controller.signal.aborted).toBe(true);
    await expect(workspace.stat('moved.txt')).resolves.toBeDefined();
  });

  it('never deletes both copies when a post-delete plugin reports failure', async () => {
    const driver = createFsStorageDriver({ adapter: { root } });
    const client = new StorageClient('hooked-move', driver, [
      {
        afterOperation(context) {
          if (context.operation === 'delete') {
            throw new Error('mandatory audit sink unavailable');
          }
        },
      },
    ]);
    const workspace = mountStorageWorkspace(client, {
      permissions: ALL_PERMISSIONS,
      prefix: 'scope',
    });
    const source = await workspace.writeFile('source.txt', 'body', {
      mode: 'create',
    });

    await expect(
      workspace.moveFile('source.txt', 'moved.txt', {
        etag: source.etag ?? '',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(workspace.stat('source.txt')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });
    await expect(workspace.stat('moved.txt')).resolves.toMatchObject({
      path: 'moved.txt',
    });
  });

  it('rejects malformed over-returning and repeating backend pages', async () => {
    const driver = createMemoryStorageDriver();
    driver.list = vi.fn(async (options) => ({
      cursor: options?.cursor ?? 'same',
      items: [
        {
          contentType: 'text/plain',
          key: 'scope/a.txt',
          name: 'scope/a.txt',
          size: 1,
        },
        {
          contentType: 'text/plain',
          key: 'scope/b.txt',
          name: 'scope/b.txt',
          size: 1,
        },
      ],
    }));
    const workspace = mountStorageWorkspace(
      new StorageClient('malformed-list', driver),
      { prefix: 'scope' },
    );

    await expect(
      workspace.list({ limit: 1, recursive: true }),
    ).rejects.toMatchObject({ code: StorageErrorCode.PROVIDER });

    driver.list = vi.fn(async (options) => ({
      cursor: options?.cursor ?? 'repeat',
      items: [
        {
          contentType: 'text/plain',
          key: 'scope/a.txt',
          name: 'scope/a.txt',
          size: 1,
        },
      ],
    }));
    const first = await workspace.list({ limit: 1, recursive: true });
    await expect(
      workspace.list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.PROVIDER });
  });

  it('preflights copy and move when atomic capabilities are absent', async () => {
    const driver: StorageDriver = createMemoryStorageDriver({
      adapter: { initial: { 'scope/source.txt': 'body' } },
    });
    const download = vi.spyOn(driver, 'download');
    const workspace = mountStorageWorkspace(
      new StorageClient('unsupported', driver),
      { permissions: ALL_PERMISSIONS, prefix: 'scope' },
    );

    await expect(
      workspace.copyFile('source.txt', 'copy.txt', { etag: 'etag' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.NOT_SUPPORTED });
    await expect(
      workspace.moveFile('source.txt', 'moved.txt', { etag: 'etag' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.NOT_SUPPORTED });
    expect(download).not.toHaveBeenCalled();
  });
});

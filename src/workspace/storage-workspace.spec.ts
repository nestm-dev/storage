import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handlers } from 'files-sdk';
import { encryption } from 'files-sdk/encryption';

import { createFsStorageDriver } from '../files-sdk/fs/index.js';
import { StorageClient } from '../storage.client.js';
import { StorageError, StorageErrorCode } from '../storage.error.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import type { StorageDriver } from '../storage.driver.js';
import type { StorageObject } from '../storage.types.js';

import {
  Aes256GcmStorageWorkspaceCursorCodec,
  isStorageWorkspaceError,
  mountStorageWorkspace,
  type StorageWorkspaceCursorConfiguration,
  type StorageWorkspacePermission,
} from './index.js';

const ALL_PERMISSIONS: readonly StorageWorkspacePermission[] = [
  'list',
  'read',
  'search',
  'write',
  'create',
  'replace',
  'copy',
  'move',
  'delete',
];
const CURSOR_KEY = new Uint8Array(32).fill(0x42);

function cursorConfiguration(
  mountId = 'artifact-files',
  scope = 'organization:one/workspace:one',
): StorageWorkspaceCursorConfiguration {
  return {
    codec: new Aes256GcmStorageWorkspaceCursorCodec({
      activeKeyId: 'test',
      keys: { test: CURSOR_KEY },
    }),
    mountId,
    scope,
  };
}

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
      cursor: cursorConfiguration(),
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
      limits: { maxCursorBytes: 2_048, maxReadBytes: 10 },
      permissions: ['read'],
    });
    expect([...child.permissions]).toEqual(['read']);
    expect(child.limits.maxReadBytes).toBe(10);
    expect(child.limits.maxCursorBytes).toBe(2_048);
    expect(() => child.mount('nested', { permissions: ['create'] })).toThrow(
      expect.objectContaining({ code: StorageErrorCode.UNAUTHORIZED }),
    );
    expect(() =>
      child.mount('nested', { limits: { maxReadBytes: 11 } }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
    );
    expect(() =>
      mountStorageWorkspace(client, {
        limits: { maxCursorBytes: 4_097 },
        prefix: 'runs/two',
      }),
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

  it('fails workspace writes closed when Files plugins cannot intercept conditional operations', async () => {
    const transform = vi.fn();
    const driver = createFsStorageDriver({
      adapter: { root },
      plugins: [
        {
          name: 'body-transform',
          wrap: handlers({
            upload: (operation, next) => {
              transform(operation.body);
              return next({ ...operation, body: 'ciphertext' });
            },
          }),
        },
      ],
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('files-policy', driver),
      { permissions: ALL_PERMISSIONS, prefix: 'runs/run-1' },
    );

    await expect(
      workspace.writeFile('plaintext.txt', 'plaintext', { mode: 'create' }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.NOT_SUPPORTED,
      permanent: true,
    });
    expect(transform).not.toHaveBeenCalled();
    await expect(driver.exists('runs/run-1/plaintext.txt')).resolves.toBe(
      false,
    );
  });

  it('routes overwrite reads and writes through the Files encryption plugin', async () => {
    const driver = createFsStorageDriver({
      adapter: { root },
      plugins: [encryption(new Uint8Array(32).fill(0x5a))],
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('encrypted-overwrite', driver),
      {
        permissions: ['read', 'write', 'copy', 'delete'],
        prefix: 'runs/run-1',
      },
    );

    await workspace.writeFile('protected.txt', 'first plaintext', {
      mode: 'overwrite',
    });
    await workspace.writeFile('protected.txt', 'second plaintext', {
      mode: 'overwrite',
    });

    await expect(workspace.readText('protected.txt')).resolves.toMatchObject({
      text: 'second plaintext',
    });
    const raw = readFileSync(join(root, 'runs/run-1/protected.txt'));
    expect(raw.includes(Buffer.from('first plaintext'))).toBe(false);
    expect(raw.includes(Buffer.from('second plaintext'))).toBe(false);

    await workspace.copyFile('protected.txt', 'copied.txt', {
      mode: 'overwrite',
    });
    await expect(workspace.readText('copied.txt')).resolves.toMatchObject({
      text: 'second plaintext',
    });
    const copiedRaw = readFileSync(join(root, 'runs/run-1/copied.txt'));
    expect(copiedRaw.includes(Buffer.from('second plaintext'))).toBe(false);
    expect(copiedRaw.equals(raw)).toBe(false);

    await workspace.deleteFile('copied.txt', { mode: 'unconditional' });
    await expect(workspace.stat('copied.txt')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });
  });

  it('supports explicit last-write-wins copy and delete variants', async () => {
    const { workspace } = mountedFs(root);
    await workspace.writeFile('source.txt', 'latest', {
      metadata: { owner: 'workspace' },
      mode: 'overwrite',
    });
    await workspace.writeFile('copy.txt', 'stale-copy', { mode: 'overwrite' });

    await expect(
      workspace.copyFile('source.txt', 'copy.txt', { mode: 'overwrite' }),
    ).resolves.toMatchObject({ path: 'copy.txt' });
    await expect(workspace.readText('copy.txt')).resolves.toMatchObject({
      text: 'latest',
    });

    await workspace.deleteFile('copy.txt', { mode: 'unconditional' });
    await expect(workspace.stat('copy.txt')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });
  });

  it('bounds last-write-wins copy by streamed bytes before upload', async () => {
    const driver = createMemoryStorageDriver();
    driver.download = vi.fn(async (key): Promise<StorageObject> => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
          controller.close();
        },
      }),
      contentType: 'application/octet-stream',
      key,
      name: key,
      size: 1,
    }));
    const upload = vi.spyOn(driver, 'upload');
    const workspace = mountStorageWorkspace(
      new StorageClient('bounded-overwrite-copy', driver),
      {
        limits: { maxWriteBytes: 5 },
        permissions: ['copy', 'read', 'write'],
        prefix: 'scope',
      },
    );

    await expect(
      workspace.copyFile('source.bin', 'destination.bin', {
        mode: 'overwrite',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.LIMIT_EXCEEDED });
    expect(upload).not.toHaveBeenCalled();
  });

  it('keeps write authority separate from conditional create and replace', async () => {
    const driver = createMemoryStorageDriver();
    const upload = vi.spyOn(driver, 'upload');
    const client = new StorageClient('write-permission', driver);
    const conditionalOnly = mountStorageWorkspace(client, {
      permissions: ['create', 'replace'],
      prefix: 'conditional',
    });
    const overwriteOnly = mountStorageWorkspace(client, {
      permissions: ['write'],
      prefix: 'overwrite',
    });

    await expect(
      conditionalOnly.writeFile('file.txt', 'body', { mode: 'overwrite' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.UNAUTHORIZED });
    expect(upload).not.toHaveBeenCalled();

    await expect(
      overwriteOnly.writeFile('file.txt', 'body', { mode: 'overwrite' }),
    ).resolves.toMatchObject({ path: 'file.txt' });
    await expect(
      overwriteOnly.writeFile('conditional.txt', 'body', { mode: 'create' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.UNAUTHORIZED });
  });

  it('requires both delete and write before an unconditional delete', async () => {
    const driver = createMemoryStorageDriver({
      adapter: { initial: { 'scope/target.txt': 'body' } },
    });
    const deleteObject = vi.spyOn(driver, 'delete');
    const deleteConditional = vi.spyOn(driver, 'deleteConditional');
    const workspace = mountStorageWorkspace(
      new StorageClient('unconditional-delete-permissions', driver),
      { permissions: ['delete'], prefix: 'scope' },
    );

    await expect(
      workspace.deleteFile('target.txt', { mode: 'unconditional' }),
    ).rejects.toMatchObject({ code: StorageErrorCode.UNAUTHORIZED });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteConditional).not.toHaveBeenCalled();
  });

  it('rejects unknown explicit mutation modes before provider I/O', async () => {
    const driver = createMemoryStorageDriver({
      adapter: { initial: { 'scope/source.txt': 'body' } },
    });
    const upload = vi.spyOn(driver, 'upload');
    const uploadConditional = vi.spyOn(driver, 'uploadConditional');
    const download = vi.spyOn(driver, 'download');
    const deleteObject = vi.spyOn(driver, 'delete');
    const deleteConditional = vi.spyOn(driver, 'deleteConditional');
    const workspace = mountStorageWorkspace(
      new StorageClient('invalid-modes', driver),
      { permissions: ALL_PERMISSIONS, prefix: 'scope' },
    );

    await expect(
      workspace.writeFile('target.txt', 'body', {
        mode: 'unknown',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.copyFile('source.txt', 'copy.txt', {
        mode: 'unknown',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.moveFile('source.txt', 'move.txt', {
        mode: 'unknown',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.deleteFile('source.txt', { mode: 'unknown' } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.writeFile('target.txt', 'body', {
        etag: 'ignored-etag',
        mode: 'create',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.writeFile('target.txt', 'body', {
        etag: 'ignored-etag',
        mode: 'overwrite',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.copyFile('source.txt', 'copy.txt', {
        etag: 'ignored-etag',
        mode: 'overwrite',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.moveFile('source.txt', 'move.txt', {
        mode: 'overwrite',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.moveFile('source.txt', 'move.txt', {
        etag: 'ignored-etag',
        mode: 'overwrite',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      workspace.deleteFile('source.txt', {
        etag: 'ignored-etag',
        mode: 'unconditional',
      } as never),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });

    expect(upload).not.toHaveBeenCalled();
    expect(uploadConditional).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteConditional).not.toHaveBeenCalled();
  });

  it('reads bounded binary files without requiring UTF-8', async () => {
    const { workspace } = mountedFs(root);
    const bytes = new Uint8Array([0, 0xff, 1, 0x80]);
    await workspace.writeFile('binary.dat', bytes, {
      contentType: 'application/octet-stream',
      mode: 'overwrite',
    });

    await expect(workspace.readBytes('binary.dat')).resolves.toMatchObject({
      bytes,
      contentType: 'application/octet-stream',
      path: 'binary.dat',
    });
    await expect(workspace.readText('binary.dat')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
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
    await expect(workspace.readBytes('large.txt')).rejects.toMatchObject({
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
    expect(first.cursor).toMatch(/^swc1\.test\.[A-Za-z0-9_-]+$/u);
    const second = await workspace.list({ cursor: first.cursor });
    expect(second.entries).toHaveLength(1);
    await expect(
      workspace.list({ cursor: first.cursor }),
    ).resolves.toMatchObject({ entries: second.entries });

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
    await expect(workspace.list({ cursor: '' })).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
  });

  it('continues across replicas while binding store, mount, scope, prefix, and limits', async () => {
    const createClient = (name = 'artifacts') =>
      new StorageClient(name, createFsStorageDriver({ adapter: { root } }));
    const client = createClient();
    let defaultClient = client;
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await client.upload(`scope/${name}`, name);
    }
    const mount = (
      overrides: {
        client?: StorageClient;
        mountId?: string;
        prefix?: string;
        scope?: string;
        maxReadBytes?: number;
      } = {},
    ) =>
      mountStorageWorkspace(overrides.client ?? defaultClient, {
        cursor: cursorConfiguration(
          overrides.mountId ?? 'artifact-files',
          overrides.scope ?? 'organization:one/workspace:one',
        ),
        limits: { maxReadBytes: overrides.maxReadBytes ?? 100 },
        prefix: overrides.prefix ?? 'scope',
      });
    const firstMount = mount();
    const first = await firstMount.list({ limit: 1, recursive: true });
    expect(first.cursor).toBeTypeOf('string');
    const searched = await firstMount.search('*.txt', { limit: 1 });
    expect(searched.cursor).toBeTypeOf('string');

    await client.onApplicationShutdown();
    const replicaClient = createClient();
    defaultClient = replicaClient;

    const replica = mount();
    const listedContinuation = await replica.list({ cursor: first.cursor });
    expect(listedContinuation).toMatchObject({
      entries: [expect.objectContaining({ kind: 'file' })],
    });
    expect(listedContinuation.cursor).toBeTypeOf('string');
    const listedDescendant = await replica.list({
      cursor: listedContinuation.cursor,
    });
    const listedReplay = await replica.list({ cursor: first.cursor });
    expect(listedReplay).toMatchObject({ entries: listedContinuation.entries });
    expect(listedReplay.cursor).toBeTypeOf('string');
    await expect(
      replica.list({ cursor: listedReplay.cursor }),
    ).resolves.toMatchObject({ entries: listedDescendant.entries });
    const searchContinuation = await replica.search('', {
      cursor: searched.cursor,
    });
    expect(searchContinuation).toMatchObject({
      entries: [expect.objectContaining({ kind: 'file' })],
    });
    expect(searchContinuation.cursor).toBeTypeOf('string');
    const searchDescendant = await replica.search('', {
      cursor: searchContinuation.cursor,
    });
    const searchReplay = await replica.search('', { cursor: searched.cursor });
    expect(searchReplay).toMatchObject({ entries: searchContinuation.entries });
    expect(searchReplay.cursor).toBeTypeOf('string');
    await expect(
      replica.search('', { cursor: searchReplay.cursor }),
    ).resolves.toMatchObject({ entries: searchDescendant.entries });
    const otherStoreClient = createClient('other-store');
    await expect(
      mount({ client: otherStoreClient }).list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      mount({ mountId: 'other-mount' }).list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      mount({ scope: 'organization:one/workspace:two' }).list({
        cursor: first.cursor,
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      mount({ prefix: 'other-scope' }).list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await expect(
      mount({ maxReadBytes: 99 }).list({ cursor: first.cursor }),
    ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    await otherStoreClient.onApplicationShutdown();
    await replicaClient.onApplicationShutdown();
  });

  it('rejects every explicitly conflicting normalized list and search field', async () => {
    const driver = createMemoryStorageDriver({
      adapter: {
        initial: {
          'scope/src/a.ts': 'a',
          'scope/src/b.ts': 'b',
          'scope/src/c.ts': 'c',
          'scope/other/d.ts': 'd',
        },
      },
    });
    const workspace = mountStorageWorkspace(
      new StorageClient('queries', driver),
      { cursor: cursorConfiguration(), prefix: 'scope' },
    );
    const listed = await workspace.list({
      directory: 'src',
      limit: 1,
      recursive: true,
    });
    expect(listed.cursor).toBeTypeOf('string');
    for (const options of [
      { cursor: listed.cursor, directory: 'other' },
      { cursor: listed.cursor, limit: 2 },
      { cursor: listed.cursor, recursive: false },
    ]) {
      await expect(workspace.list(options)).rejects.toMatchObject({
        code: StorageErrorCode.INVALID_ARGUMENT,
      });
    }

    const searched = await workspace.search('*.ts', {
      caseInsensitive: false,
      directory: 'src',
      limit: 1,
      match: 'glob',
    });
    expect(searched.cursor).toBeTypeOf('string');
    const mismatches = [
      workspace.search('*.md', { cursor: searched.cursor }),
      workspace.search('', { cursor: searched.cursor, directory: 'other' }),
      workspace.search('', { cursor: searched.cursor, limit: 2 }),
      workspace.search('', {
        caseInsensitive: true,
        cursor: searched.cursor,
      }),
      workspace.search('', { cursor: searched.cursor, match: 'substring' }),
    ];
    for (const mismatch of mismatches) {
      await expect(mismatch).rejects.toMatchObject({
        code: StorageErrorCode.INVALID_ARGUMENT,
      });
    }
  });

  it('rejects expired and altered cursors without exposing provider state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    try {
      const driver = createMemoryStorageDriver({
        adapter: {
          initial: { 'private/a.txt': 'a', 'private/b.txt': 'b' },
        },
      });
      const workspace = mountStorageWorkspace(
        new StorageClient('expiry', driver),
        {
          cursor: cursorConfiguration(),
          limits: { cursorTtlMs: 100 },
          prefix: 'private',
        },
      );
      const first = await workspace.list({ limit: 1, recursive: true });
      expect(first.cursor).toBeTypeOf('string');
      expect(first.cursor).not.toContain('private');
      const final = first.cursor?.at(-1);
      const altered = `${first.cursor?.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`;
      await expect(workspace.list({ cursor: altered })).rejects.toMatchObject({
        code: StorageErrorCode.INVALID_ARGUMENT,
      });

      vi.advanceTimersByTime(99);
      await expect(
        workspace.list({ cursor: first.cursor }),
      ).resolves.toBeDefined();
      vi.advanceTimersByTime(1);
      await expect(
        workspace.list({ cursor: first.cursor }),
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires cursor configuration only when a continuation is used', async () => {
    const single = mountStorageWorkspace(
      new StorageClient(
        'single-page',
        createMemoryStorageDriver({
          adapter: { initial: { 'scope/only.txt': 'only' } },
        }),
      ),
      { prefix: 'scope' },
    );
    await expect(single.list({ recursive: true })).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: 'only.txt' })],
    });

    const driver = createMemoryStorageDriver();
    driver.list = vi.fn(async () => ({
      cursor: 'provider-secret-continuation',
      items: [
        {
          contentType: 'text/plain',
          key: 'scope/a.txt',
          name: 'scope/a.txt',
          size: 1,
        },
      ],
    }));
    const unconfigured = mountStorageWorkspace(
      new StorageClient('unconfigured', driver),
      { prefix: 'scope' },
    );
    await expect(
      unconfigured.list({ limit: 1, recursive: true }),
    ).rejects.toMatchObject({ code: StorageErrorCode.NOT_SUPPORTED });
    await expect(unconfigured.list({ cursor: 'opaque' })).rejects.toMatchObject(
      {
        code: StorageErrorCode.NOT_SUPPORTED,
      },
    );
  });

  it('bounds issued cursor state and sanitizes codec failures', async () => {
    const driver = createMemoryStorageDriver();
    driver.list = vi.fn(async () => ({
      cursor: 'p'.repeat(3_000),
      items: [
        {
          contentType: 'text/plain',
          key: 'scope/a.txt',
          name: 'scope/a.txt',
          size: 1,
        },
      ],
    }));
    const workspace = mountStorageWorkspace(
      new StorageClient('oversized', driver),
      { cursor: cursorConfiguration(), prefix: 'scope' },
    );
    await expect(
      workspace.list({ limit: 1, recursive: true }),
    ).rejects.toMatchObject({ code: StorageErrorCode.LIMIT_EXCEEDED });

    driver.list = vi.fn(async () => ({
      cursor: 'provider-cursor',
      items: [
        {
          contentType: 'text/plain',
          key: 'scope/a.txt',
          name: 'scope/a.txt',
          size: 1,
        },
      ],
    }));
    const narrowDecode = vi.fn(() => new Uint8Array([1]));
    const narrow = mountStorageWorkspace(
      new StorageClient('narrow-cursor', driver),
      {
        cursor: {
          codec: {
            decode: narrowDecode,
            encode: () => 'a'.repeat(65),
          },
          mountId: 'artifact-files',
          scope: 'organization:one/workspace:one',
        },
        limits: { maxCursorBytes: 64 },
        prefix: 'scope',
      },
    );
    await expect(
      narrow.list({ limit: 1, recursive: true }),
    ).rejects.toMatchObject({ code: StorageErrorCode.LIMIT_EXCEEDED });
    await expect(narrow.list({ cursor: 'a'.repeat(65) })).rejects.toMatchObject(
      {
        code: StorageErrorCode.INVALID_ARGUMENT,
      },
    );
    expect(narrowDecode).not.toHaveBeenCalled();

    const failing = mountStorageWorkspace(
      new StorageClient('failing-codec', driver),
      {
        cursor: {
          codec: {
            decode: () => {
              throw new Error('private decode failure');
            },
            encode: () => {
              throw new Error('private encode failure');
            },
          },
          mountId: 'artifact-files',
          scope: 'organization:one/workspace:one',
        },
        prefix: 'scope',
      },
    );
    const error = await failing
      .list({ limit: 1, recursive: true })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: StorageErrorCode.PROVIDER });
    expect((error as Error).message).not.toContain('private encode failure');
    await expect(failing.list({ cursor: 'opaque' })).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
    });
  });

  it('rejects malformed decoded envelopes before calling the provider', async () => {
    const driver = createMemoryStorageDriver();
    const list = vi.spyOn(driver, 'list');
    const workspace = mountStorageWorkspace(
      new StorageClient('malformed-envelope', driver),
      {
        cursor: {
          codec: {
            decode: async () =>
              new TextEncoder().encode(
                JSON.stringify({ b: 'forged', e: Date.now() + 1_000, v: 2 }),
              ),
            encode: async () => 'opaque',
          },
          mountId: 'artifact-files',
          scope: 'organization:one/workspace:one',
        },
        prefix: 'scope',
      },
    );

    await expect(workspace.list({ cursor: 'opaque' })).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    expect(list).not.toHaveBeenCalled();
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
      { cursor: cursorConfiguration(), prefix: 'scope' },
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

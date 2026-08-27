import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FilesError } from 'files-sdk';
import { fs } from 'files-sdk/fs';

import { StorageClient } from '../../storage.client.js';
import { StorageErrorCode } from '../../storage.error.js';
import { createFsStorageDriver, withFsConditionalMutation } from './index.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});

describe('createFsStorageDriver', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nestm-storage-fs-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('stores the body verbatim at the key path under the root', async () => {
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );

    await client.upload('nested/page.html', '<html>hi</html>', {
      contentType: 'text/html; charset=utf-8',
    });

    expect(readFileSync(join(root, 'nested/page.html'), 'utf8')).toBe(
      '<html>hi</html>',
    );
    const head = await client.head('nested/page.html');
    expect(head.contentType).toBe('text/html; charset=utf-8');
  });

  it('keeps sidecars out of listings', async () => {
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );
    await client.upload('a.txt', 'a');
    await client.upload('b.txt', 'b');

    const listed = await client.list();

    expect(listed.items.map((item) => item.key).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
  });

  it('scopes every key under the configured prefix', async () => {
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root }, prefix: 'tenant-a' }),
    );

    await client.upload('report.txt', 'scoped');

    expect(readFileSync(join(root, 'tenant-a/report.txt'), 'utf8')).toBe(
      'scoped',
    );
    const listed = await client.list();
    expect(listed.items.map((item) => item.key)).toEqual(['report.txt']);
  });

  it('reports a missing object as NOT_FOUND', async () => {
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );

    await expect(client.downloadBytes('absent.bin')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });
  });

  it('rejects reads through a symlink that aliases another mounted prefix', async () => {
    mkdirSync(join(root, 'scope'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside/secret.txt'), 'secret');
    symlinkSync(
      join(root, 'outside/secret.txt'),
      join(root, 'scope/link.txt'),
      'file',
    );
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );

    await expect(client.downloadText('scope/link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    await expect(client.head('scope/link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    await expect(client.exists('scope/link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
  });

  it('rejects reads through a hard link that aliases another mounted prefix', async () => {
    mkdirSync(join(root, 'scope'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside/secret.txt'), 'secret');
    linkSync(join(root, 'outside/secret.txt'), join(root, 'scope/link.txt'));
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );

    await expect(client.downloadText('scope/link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
    await expect(client.head('scope/link.txt')).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
    });
  });

  it('supports create, replace, and delete with exact ETag preconditions', async () => {
    const client = new StorageClient(
      'artifacts',
      createFsStorageDriver({ adapter: { root } }),
    );

    expect(client.capabilities.conditionalCreate).toEqual({
      resultEtag: true,
    });
    expect(client.capabilities.conditionalReplace).toEqual({
      resultEtag: true,
    });
    expect(client.capabilities.conditionalDelete).toEqual({
      etag: true,
    });
    const created = await client.uploadConditional('note.txt', 'first', {
      condition: { type: 'create' },
    });

    await expect(
      client.uploadConditional('note.txt', 'duplicate', {
        condition: { type: 'create' },
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(
      client.uploadConditional('note.txt', 'wrong', {
        condition: { etag: 'wrong-etag', type: 'replace' },
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(client.downloadText('note.txt')).resolves.toBe('first');

    const replaced = await client.uploadConditional('note.txt', 'second', {
      condition: { etag: created.etag ?? '', type: 'replace' },
    });
    await expect(client.downloadText('note.txt')).resolves.toBe('second');
    await expect(
      client.deleteConditional('note.txt', {
        condition: { etag: created.etag ?? '' },
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });

    await client.deleteConditional('note.txt', {
      condition: { etag: replaced.etag ?? '' },
    });
    await expect(client.exists('note.txt')).resolves.toBe(false);
  });

  it('exposes Files SDK native conditional primitives with normalized results and errors', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    const {
      copy,
      create,
      delete: deleteExact,
      exactRead,
      replace,
    } = adapter.conditional ?? {};
    if (!copy || !create || !deleteExact || !exactRead || !replace) {
      throw new Error('Expected every filesystem conditional primitive.');
    }

    expect(Object.isFrozen(adapter.conditional)).toBe(true);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(copy).toMatchObject({
      atomicSourceDestination: true,
      destinationCreate: true,
      destinationReplace: true,
      sourceEtag: true,
    });

    const created = await create('native.txt', 'first', {
      contentType: 'text/plain',
      metadata: { owner: 'files-sdk' },
    });
    expect(created).toEqual(
      expect.objectContaining({
        contentType: 'text/plain',
        etag: expect.any(String),
        key: 'native.txt',
        lastModified: expect.any(Number),
        size: 5,
      }),
    );
    const exact = await exactRead('native.txt', created.etag);
    await expect(exact.text()).resolves.toBe('first');
    expect(exact).toMatchObject({
      etag: created.etag,
      metadata: { owner: 'files-sdk' },
      type: 'text/plain',
    });

    await expect(replace('native.txt', 'wrong', 'stale-etag')).rejects.toEqual(
      expect.objectContaining<Partial<FilesError>>({
        code: 'Conflict',
        name: 'FilesError',
        permanent: true,
      }),
    );
    const replaced = await replace('native.txt', 'second', created.etag);
    await copy.run('native.txt', 'copy.txt', {
      destination: { type: 'create' },
      source: { etag: replaced.etag },
    });
    await expect(
      (await exactRead('copy.txt', replaced.etag)).text(),
    ).resolves.toBe('second');

    await expect(deleteExact('native.txt', created.etag)).rejects.toEqual(
      expect.objectContaining<Partial<FilesError>>({
        code: 'Conflict',
        name: 'FilesError',
      }),
    );
    await deleteExact('native.txt', replaced.etag);
  });

  it('rejects empty or malformed predicates at the decorated adapter boundary', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));

    await expect(
      adapter.downloadConditional('unsafe-read.txt', {
        condition: {},
      } as never),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
    await expect(
      adapter.promote('unsafe-source.txt', 'unsafe-destination.txt', {}),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
    await expect(
      adapter.uploadConditional('unsafe-upload.txt', 'body', {
        condition: { type: 'invalid' },
      } as never),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
    await expect(
      adapter.deleteConditional('unsafe-delete.txt', {} as never),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
  });

  it('serializes conditional creates across drivers for the same root', async () => {
    const first = new StorageClient(
      'first',
      createFsStorageDriver({ adapter: { root } }),
    );
    const second = new StorageClient(
      'second',
      createFsStorageDriver({ adapter: { root } }),
    );

    const settled = await Promise.allSettled([
      first.uploadConditional('race.txt', 'first', {
        condition: { type: 'create' },
      }),
      second.uploadConditional('race.txt', 'second', {
        condition: { type: 'create' },
      }),
    ]);

    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: StorageErrorCode.CONFLICT } }]);
  });

  it('serializes ordinary uploads with conditional uploads', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    let releaseBody = (): void => undefined;
    let reportBodyRead = (): void => undefined;
    const bodyRead = new Promise<void>((resolve) => {
      reportBodyRead = resolve;
    });
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const conditional = adapter.uploadConditional(
      'nested/shared.txt',
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          reportBodyRead();
          await bodyReleased;
          controller.enqueue(new TextEncoder().encode('conditional'));
          controller.close();
        },
      }),
      { condition: { type: 'create' } },
    );
    await bodyRead;

    let ordinarySettled = false;
    const ordinary = adapter
      .upload('nested//shared.txt', 'ordinary')
      .finally(() => {
        ordinarySettled = true;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ordinarySettled).toBe(false);
    } finally {
      releaseBody();
    }

    await expect(conditional).resolves.toMatchObject({
      key: 'nested/shared.txt',
    });
    await expect(ordinary).resolves.toMatchObject({
      key: 'nested//shared.txt',
    });
    await expect(
      (await adapter.download('nested/shared.txt')).text(),
    ).resolves.toBe('ordinary');
  });

  it('honors aborts and timeouts while conditional calls wait for a filesystem lock', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    let releaseBody = (): void => undefined;
    let reportBodyRead = (): void => undefined;
    const bodyRead = new Promise<void>((resolve) => {
      reportBodyRead = resolve;
    });
    const bodyReleased = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const held = adapter.uploadConditional(
      'queued.txt',
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          reportBodyRead();
          await bodyReleased;
          controller.enqueue(new TextEncoder().encode('held'));
          controller.close();
        },
      }),
      { condition: { type: 'create' } },
    );
    await bodyRead;

    const controller = new AbortController();
    const aborted = adapter.uploadConditional('queued.txt', 'aborted', {
      condition: { type: 'create' },
      signal: controller.signal,
    });
    const timedOut = adapter.uploadConditional('queued.txt', 'timed out', {
      condition: { type: 'create' },
      timeout: 10,
    });
    const queued = Promise.allSettled([aborted, timedOut]);
    controller.abort(new Error('cancel queued upload'));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('queued operations ignored cancellation')),
        500,
      );
    });

    try {
      const settled = await Promise.race([queued, deadline]);
      expect(settled).toMatchObject([
        {
          reason: {
            aborted: true,
            code: StorageErrorCode.ABORTED,
            timedOut: false,
          },
          status: 'rejected',
        },
        {
          reason: {
            code: StorageErrorCode.TIMEOUT,
            timedOut: true,
          },
          status: 'rejected',
        },
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      releaseBody();
    }
    await expect(held).resolves.toMatchObject({ key: 'queued.txt' });
  });

  it('uses a strict lock order for reverse promotions', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    const first = await adapter.uploadConditional('a', 'first', {
      condition: { type: 'create' },
    });
    const second = await adapter.uploadConditional('a\u200b', 'second', {
      condition: { type: 'create' },
    });
    if (first.etag === undefined || second.etag === undefined) {
      throw new Error('Expected canonical ETags from conditional uploads.');
    }
    const promotions = Promise.allSettled([
      adapter.promote('a', 'a\u200b', {
        destination: { etag: second.etag, type: 'replace' },
        sourceEtag: first.etag,
      }),
      adapter.promote('a\u200b', 'a', {
        destination: { etag: first.etag, type: 'replace' },
        sourceEtag: second.etag,
      }),
    ]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('promotion deadlocked')),
        500,
      );
    });

    try {
      const settled = await Promise.race([promotions, timedOut]);
      expect(settled).toHaveLength(2);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  });

  it('marks a conditional upload applied when its sidecar commit fails', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const rename = vi.mocked(fsp.rename);
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('.meta.json')) {
        throw Object.assign(new Error('injected sidecar rename failure'), {
          code: 'EIO',
        });
      }
      await actual.rename(oldPath, newPath);
    });

    try {
      await expect(
        adapter.uploadConditional('partial.txt', 'committed body', {
          condition: { type: 'create' },
        }),
      ).rejects.toMatchObject({
        applied: true,
        appliedEtag: expect.any(String),
        code: StorageErrorCode.PROVIDER,
        permanent: true,
      });
      expect(readFileSync(join(root, 'partial.txt'), 'utf8')).toBe(
        'committed body',
      );
    } finally {
      rename.mockImplementation(actual.rename);
    }
  });

  it('marks a conditional delete applied when sidecar removal fails', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    const created = await adapter.uploadConditional(
      'partial-delete.txt',
      'body',
      { condition: { type: 'create' } },
    );
    if (created.etag === undefined) {
      throw new Error('Expected a canonical ETag from conditional upload.');
    }
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const unlink = vi.mocked(fsp.unlink);
    unlink.mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('.meta.json')) {
        throw Object.assign(new Error('injected sidecar unlink failure'), {
          code: 'EIO',
        });
      }
      await actual.unlink(filePath);
    });

    try {
      await expect(
        adapter.deleteConditional('partial-delete.txt', {
          condition: { etag: created.etag },
        }),
      ).rejects.toMatchObject({
        applied: true,
        appliedEtag: undefined,
        code: StorageErrorCode.PROVIDER,
        permanent: true,
      });
      expect(existsSync(join(root, 'partial-delete.txt'))).toBe(false);
      expect(existsSync(join(root, 'partial-delete.txt.meta.json'))).toBe(true);
    } finally {
      unlink.mockImplementation(actual.unlink);
    }
  });

  it('marks a conditional promotion applied when its sidecar commit fails', async () => {
    const adapter = withFsConditionalMutation(fs({ root }));
    const source = await adapter.uploadConditional(
      'source.txt',
      'source body',
      { condition: { type: 'create' } },
    );
    const destination = await adapter.uploadConditional(
      'destination.txt',
      'destination body',
      { condition: { type: 'create' } },
    );
    if (source.etag === undefined || destination.etag === undefined) {
      throw new Error('Expected canonical ETags from conditional uploads.');
    }
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const rename = vi.mocked(fsp.rename);
    rename.mockImplementation(async (oldPath, newPath) => {
      if (String(newPath).endsWith('destination.txt.meta.json')) {
        throw Object.assign(new Error('injected sidecar rename failure'), {
          code: 'EIO',
        });
      }
      await actual.rename(oldPath, newPath);
    });

    try {
      await expect(
        adapter.promote('source.txt', 'destination.txt', {
          destination: {
            etag: destination.etag,
            type: 'replace',
          },
          sourceEtag: source.etag,
        }),
      ).rejects.toMatchObject({
        applied: true,
        appliedEtag: undefined,
        code: StorageErrorCode.PROVIDER,
        key: 'destination.txt',
        permanent: true,
      });
      expect(readFileSync(join(root, 'destination.txt'), 'utf8')).toBe(
        'source body',
      );
    } finally {
      rename.mockImplementation(actual.rename);
    }
  });

  it('does not advertise conditional mutations from a readonly filesystem driver', () => {
    const driver = createFsStorageDriver({
      adapter: { root },
      readonly: true,
    });

    expect(driver.capabilities.conditionalCreate).toBeUndefined();
    expect(driver.capabilities.conditionalReplace).toBeUndefined();
    expect(driver.capabilities.conditionalDelete).toBeUndefined();
    expect(driver.capabilities.conditionalCopySource).toBeUndefined();
    expect(driver.capabilities.conditionalCopyDestination).toBeUndefined();
    expect(driver.capabilities.conditionalRead).toEqual({
      etag: true,
      version: false,
    });
  });

  it('rejects a parent symlink during conditional create', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nestm-storage-outside-'));
    try {
      symlinkSync(outside, join(root, 'link'), 'dir');
      const client = new StorageClient(
        'artifacts',
        createFsStorageDriver({ adapter: { root } }),
      );

      await expect(
        client.uploadConditional('link/new.txt', 'escaped', {
          condition: { type: 'create' },
        }),
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a body symlink during conditional replace', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nestm-storage-outside-'));
    try {
      const outsideFile = join(outside, 'target.txt');
      writeFileSync(outsideFile, 'outside');
      symlinkSync(outsideFile, join(root, 'note.txt'), 'file');
      writeFileSync(
        join(root, 'note.txt.meta.json'),
        JSON.stringify({
          contentType: 'text/plain',
          etag: 'outside-etag',
          lastModified: Date.now(),
        }),
      );
      const client = new StorageClient(
        'artifacts',
        createFsStorageDriver({ adapter: { root } }),
      );

      await expect(
        client.uploadConditional('note.txt', 'escaped', {
          condition: { etag: 'outside-etag', type: 'replace' },
        }),
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      expect(readFileSync(outsideFile, 'utf8')).toBe('outside');
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });

  it('rejects a sidecar symlink during conditional delete', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nestm-storage-outside-'));
    try {
      const outsideSidecar = join(outside, 'metadata.json');
      writeFileSync(outsideSidecar, '{"etag":"outside-etag"}');
      writeFileSync(join(root, 'note.txt'), 'inside');
      symlinkSync(outsideSidecar, join(root, 'note.txt.meta.json'), 'file');
      const client = new StorageClient(
        'artifacts',
        createFsStorageDriver({ adapter: { root } }),
      );

      await expect(
        client.deleteConditional('note.txt', {
          condition: { etag: 'outside-etag' },
        }),
      ).rejects.toMatchObject({ code: StorageErrorCode.INVALID_ARGUMENT });
      expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('inside');
      expect(readFileSync(outsideSidecar, 'utf8')).toBe(
        '{"etag":"outside-etag"}',
      );
    } finally {
      rmSync(outside, { force: true, recursive: true });
    }
  });
});

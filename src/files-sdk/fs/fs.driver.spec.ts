import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StorageClient } from '../../storage.client.js';
import { StorageErrorCode } from '../../storage.error.js';
import { createFsStorageDriver } from './index.js';

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
});

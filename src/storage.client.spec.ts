import { Readable } from 'node:stream';

import { createMemoryStorageDriver } from './testing/index.js';
import { StorageClient } from './storage.client.js';
import { StorageErrorCode } from './storage.error.js';
import { StorageUploadControl } from './storage-upload-control.js';
import type { StorageObjectMetadata, StoragePlugin } from './storage.types.js';

describe('StorageClient', () => {
  it('streams Node uploads and exposes safe buffered helpers', async () => {
    const client = new StorageClient('media', createMemoryStorageDriver());

    await client.upload(
      'greeting.txt',
      Readable.from(['hello', ' ', Buffer.from('world')]),
      {
        contentType: 'text/plain',
        metadata: { language: 'en' },
      },
    );

    await expect(client.downloadText('greeting.txt')).resolves.toBe(
      'hello world',
    );
    await expect(client.downloadBytes('greeting.txt')).resolves.toEqual(
      new TextEncoder().encode('hello world'),
    );
    await expect(client.head('greeting.txt')).resolves.toMatchObject({
      contentType: 'text/plain',
      key: 'greeting.txt',
      metadata: { language: 'en' },
      size: 11,
    });
  });

  it('enforces the buffer limit while leaving streaming explicit', async () => {
    const client = new StorageClient(
      'media',
      createMemoryStorageDriver({
        adapter: { initial: { 'large.bin': '12345' } },
      }),
    );

    await expect(
      client.downloadBytes('large.bin', { maxBytes: 4 }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.LIMIT_EXCEEDED,
    });

    const object = await client.downloadStream('large.bin');
    expect(object.body).toBeInstanceOf(ReadableStream);
  });

  it('supports ranges, key handles, listing, searching, copy, and move', async () => {
    const client = new StorageClient('media', createMemoryStorageDriver());
    await client.file('photos/one.txt').upload('abcdef');
    await client.file('photos/two.json').upload('{"ok":true}');

    await expect(
      client.downloadText('photos/one.txt', {
        maxBytes: 3,
        range: { start: 1, end: 3 },
      }),
    ).resolves.toBe('bcd');
    await expect(client.file('photos/two.json').text()).resolves.toBe(
      '{"ok":true}',
    );
    await expect(
      client.downloadJson<{ ok: boolean }>('photos/two.json'),
    ).resolves.toEqual({ ok: true });

    const listed = await client.list({
      delimiter: '/',
      prefix: '',
    });
    expect(listed.prefixes).toEqual(['photos/']);

    const matches: StorageObjectMetadata[] = [];
    for await (const object of client.search('photos/*.txt')) {
      matches.push(object);
    }
    expect(matches.map((object) => object.key)).toEqual(['photos/one.txt']);

    await client.copy('photos/one.txt', 'copies/one.txt');
    await client.move('copies/one.txt', 'archive/one.txt');
    await expect(client.exists('copies/one.txt')).resolves.toBe(false);
    await expect(client.exists('archive/one.txt')).resolves.toBe(true);
  });

  it('classifies invalid owned options before calling the provider', async () => {
    const client = new StorageClient('media', createMemoryStorageDriver());

    expect(() => client.list({ delimiter: '' })).toThrow(
      'delimiter must be a non-empty string',
    );
    expect(() => client.search('*', { maxResults: 0 })).toThrow(
      'maxResults must be a positive safe integer',
    );
  });

  it('returns ordered bulk results with normalized partial failures', async () => {
    const client = new StorageClient('media', createMemoryStorageDriver());

    const uploaded = await client.uploadMany([
      { body: 'a', key: 'a.txt' },
      { body: 'b', key: 'b.txt' },
    ]);
    expect(uploaded.uploaded.map((result) => result.key)).toEqual([
      'a.txt',
      'b.txt',
    ]);

    const downloaded = await client.downloadMany([
      'a.txt',
      'missing.txt',
      'b.txt',
    ]);
    expect(downloaded.downloaded.map((object) => object.key)).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(downloaded.errors).toMatchObject([
      {
        error: { code: StorageErrorCode.NOT_FOUND },
        key: 'missing.txt',
      },
    ]);

    const existence = await client.existsMany(['a.txt', 'missing.txt']);
    expect(existence).toEqual({
      existing: ['a.txt'],
      missing: ['missing.txt'],
    });
  });

  it('runs owned plugins around operations without replacing errors', async () => {
    const events: string[] = [];
    const plugin: StoragePlugin = {
      name: 'audit',
      beforeOperation(context) {
        events.push(`before:${context.operation}`);
      },
      afterOperation(context) {
        events.push(`after:${context.operation}`);
      },
      onError(context) {
        events.push(`error:${context.operation}`);
        throw new Error('observer failed');
      },
    };
    const client = new StorageClient('media', createMemoryStorageDriver(), [
      plugin,
    ]);

    await client.upload('ok.txt', 'ok');
    await expect(client.head('missing.txt')).rejects.toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
    });

    expect(events).toEqual([
      'before:upload',
      'after:upload',
      'before:head',
      'error:head',
    ]);
  });

  it('uses opaque resumable tokens and rejects invalid tokens', () => {
    const control = new StorageUploadControl();
    expect(control.status).toBe('idle');
    expect(control.toJSON()).toBeUndefined();
    expect(() =>
      StorageUploadControl.from({
        format: '@nestm/storage/resumable',
        session: {},
        version: 1,
      }),
    ).toThrow('Invalid storage resumable-upload token');
  });
});

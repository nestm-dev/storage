import { StorageClient } from '../storage.client.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import {
  collectStorageBytes,
  storageBytesStream,
} from '../core/storage-streams.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';

describe('memory native conditionals', () => {
  it('supports staged bodies, exact ranges, stale reads and safe deletion', async () => {
    const client = new StorageClient('memory', createMemoryStorageDriver());
    const content = new StorageStagedContentStore({
      client,
      key: (scope: string, id) => `${scope}/${id}`,
    });
    const body = await content.write(
      'scope',
      storageBytesStream(new TextEncoder().encode('hello😀')),
    );
    expect(body).toMatchObject({
      size: 9,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(
      new TextDecoder().decode(
        await collectStorageBytes(
          await content.read('scope', body, { range: { start: 0, end: 4 } }),
          5,
        ),
      ),
    ).toBe('hello');
    await client.upload(`scope/${body.payloadId}`, 'changed');
    await expect(content.read('scope', body)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(content.remove('scope', body)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
  it('compares conditions after async body consumption and publishes synchronously', async () => {
    const client = new StorageClient('memory', createMemoryStorageDriver());
    let release!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        release = controller;
      },
    });
    const delayed = client.uploadConditional('same', body, {
      condition: { type: 'create' },
    });
    const winner = await client.uploadConditional('same', 'winner', {
      condition: { type: 'create' },
    });
    release.enqueue(new TextEncoder().encode('loser'));
    release.close();
    await expect(delayed).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await client.downloadText('same')).toBe('winner');
    let replaceRelease!: ReadableStreamDefaultController<Uint8Array>;
    const pending = client.uploadConditional(
      'same',
      new ReadableStream<Uint8Array>({
        start(controller) {
          replaceRelease = controller;
        },
      }),
      { condition: { type: 'replace', etag: winner.etag! } },
    );
    await client.upload('same', 'ordinary writer');
    replaceRelease.enqueue(new TextEncoder().encode('stale'));
    replaceRelease.close();
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await client.downloadText('same')).toBe('ordinary writer');
  });
});

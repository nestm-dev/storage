import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageClient } from '../src/storage.client.js';
import { StorageStagedContentStore } from '../src/core/storage-staged-content.js';
import {
  collectStorageBytes,
  readStorageTextWindow,
} from '../src/core/storage-streams.js';
import { createFsStorageDriver } from '../src/files-sdk/fs/index.js';
import { StorageFileWorkflow } from '../src/workspace/storage-file-workflow.js';
import { TestFileHost, type TestState } from './helpers/file-workflow-host.js';

it('reopens durable metadata and filesystem bodies, resumes Unicode chunks and streams a multi-megabyte commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-workflow-e2e-'));
  const metadataPath = join(root, 'metadata.json');
  const open = (resume: boolean) => {
    const client = new StorageClient(
      'files',
      createFsStorageDriver({ adapter: { root: join(root, 'bodies') } }),
    );
    const content = new StorageStagedContentStore({
      client,
      key: (scope: string, id) => `${scope}/${id}`,
    });
    const host = new TestFileHost();
    if (resume)
      host.state = JSON.parse(readFileSync(metadataPath, 'utf8')) as TestState;
    host.persist = (state) => {
      writeFileSync(`${metadataPath}.tmp`, JSON.stringify(state));
      renameSync(`${metadataPath}.tmp`, metadataPath);
    };
    const files = new StorageFileWorkflow({ content, persistence: host }).mount(
      'opaque-scope',
    );
    return { client, content, host, files };
  };
  try {
    const chunk = new TextEncoder().encode('😀éline\n'.repeat(4096));
    const parts = 64;
    let current = open(false);
    const draft = await current.files.begin({
      path: 'large.txt',
      text: true,
      idempotencyKey: 'resumable',
    });
    await current.files.append({ draftId: draft.id, offset: 0, bytes: chunk });
    await current.client.onApplicationShutdown();
    current = open(true);
    expect(
      (await current.files.parts({ draftId: draft.id })).items[0],
    ).toMatchObject({ offset: 0, size: chunk.length });
    await current.files.append({ draftId: draft.id, offset: 0, bytes: chunk });
    for (let index = 1; index < parts; index++)
      await current.files.append({
        draftId: draft.id,
        offset: index * chunk.length,
        bytes: chunk,
      });
    const hash = createHash('sha256');
    for (let index = 0; index < parts; index++) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const size = parts * chunk.length;
    const request = { drafts: [{ draftId: draft.id, size, sha256 }] };
    const receipts = await current.files.commit(request);
    expect(receipts[0]?.size).toBeGreaterThan(2 * 1024 * 1024);
    await current.client.onApplicationShutdown();
    current = open(true);
    expect(await current.files.commit(request)).toEqual(receipts);
    const body = current.host.state.heads['opaque-scope/large.txt']!.body;
    const bytes = await collectStorageBytes(
      await current.content.read('opaque-scope', body),
      size,
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    const read = vi.fn((range: { start: number; end: number }) =>
      current.content.read('opaque-scope', body, { range }),
    );
    const window = await readStorageTextWindow(read, {
      size,
      offset: chunk.length,
      maxBytes: 4096,
    });
    expect(window.content?.startsWith('😀éline\n')).toBe(true);
    expect(read).toHaveBeenCalledWith(
      { start: chunk.length, end: chunk.length + 4095 },
      undefined,
    );
    await current.client.onApplicationShutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

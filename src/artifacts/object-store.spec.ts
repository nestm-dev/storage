import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EnvelopeError,
  LocalKeyProvider,
  type StorageCrypto,
} from './crypto/index.js';
import {
  createObjectStore,
  createObjectStoreWithClient,
} from './object-store.js';

const crypto: StorageCrypto = {
  keyProvider: new LocalKeyProvider('spec', randomBytes(32)),
};
const REF = { scope: 'upload:u1' };

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function fsStore(overrides?: Partial<StorageCrypto>) {
  root = mkdtempSync(join(tmpdir(), 'object-store-spec-'));
  return await createObjectStore(
    { provider: 'fs', config: { root } },
    { ...crypto, ...overrides },
  );
}

describe('ObjectStore round-trip (fs backend)', () => {
  it('stores an envelope (no plaintext, no sidecar) and returns the header content type', async () => {
    const store = await fsStore();
    const body = Buffer.from('<html>staged</html>');
    await store.putObject('_staging/u1', body, 'text/html', REF);
    const onDisk = readFileSync(join(root, '_objects', '_staging', 'u1'));
    expect(onDisk.subarray(0, 4).toString()).toBe('CAE1');
    expect(onDisk.includes(body)).toBe(false);
    const out = await store.getObject('_staging/u1', REF);
    expect(out?.body).toEqual(body);
    expect(out?.contentType).toBe('text/html');
  });

  it("asserts the reader's scope and fails closed on tamper", async () => {
    const store = await fsStore();
    await store.putObject('_staging/u1', Buffer.from('x'), 'text/html', REF);
    await expect(
      store.getObject('_staging/u1', { scope: 'upload:other' }),
    ).rejects.toThrow(EnvelopeError);
    const p = join(root, '_objects', '_staging', 'u1');
    const bytes = readFileSync(p);
    bytes.writeUInt8(
      bytes.readUInt8(bytes.length - 1) ^ 0x01,
      bytes.length - 1,
    );
    writeFileSync(p, bytes);
    await expect(store.getObject('_staging/u1', REF)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it('reads a pre-envelope object with its .ct sidecar only under the migration flag', async () => {
    const store = await fsStore({ allowLegacyPlaintext: true });
    const p = join(root, '_objects', 'org-logos', 'o1');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from('png-bytes'));
    writeFileSync(`${p}.ct`, 'image/png');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const out = await store.getObject('org-logos/o1', { scope: 'org:o1' });
      expect(out?.body.toString()).toBe('png-bytes');
      expect(out?.contentType).toBe('image/png');
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
    const strict = await createObjectStore(
      { provider: 'fs', config: { root } },
      crypto,
    );
    await expect(
      strict.getObject('org-logos/o1', { scope: 'org:o1' }),
    ).rejects.toThrow(EnvelopeError);
  });

  it('re-putting over a legacy object removes the stale sidecar', async () => {
    const store = await fsStore();
    const p = join(root, '_objects', 'org-logos', 'o1');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from('old'));
    writeFileSync(`${p}.ct`, 'image/png');
    await store.putObject('org-logos/o1', Buffer.from('new'), 'image/webp', {
      scope: 'org:o1',
    });
    const out = await store.getObject('org-logos/o1', { scope: 'org:o1' });
    expect(out?.contentType).toBe('image/webp');
    expect(await store.listObjects('org-logos/o1')).toEqual(['org-logos/o1']); // no phantom .ct key
  });

  it('reserves the legacy .ct sidecar suffix as a non-addressable key', async () => {
    const store = await fsStore();
    await expect(
      store.putObject('org-logos/logo.ct', Buffer.from('x'), 'text/plain', REF),
    ).rejects.toThrow(/invalid object key/);
    await expect(store.getObject('org-logos/logo.ct', REF)).rejects.toThrow(
      /invalid object key/,
    );
    await expect(store.deleteObject('org-logos/logo.ct')).rejects.toThrow(
      /invalid object key/,
    );
    await expect(
      store.putObject(
        'org-logos/logo.CT /child',
        Buffer.from('x'),
        'text/plain',
        REF,
      ),
    ).rejects.toThrow(/invalid object key/);
  });
});

describe('ObjectStore.sweepObjects (fs backend)', () => {
  it('deletes only objects under the prefix older than the cutoff', async () => {
    const store = await fsStore();
    await store.putObject('_staging/old', Buffer.from('old'), 'text/html', REF);
    await store.putObject(
      '_staging/fresh',
      Buffer.from('fresh'),
      'text/html',
      REF,
    );
    await store.putObject(
      'org-logos/old',
      Buffer.from('keep'),
      'text/html',
      REF,
    );

    // Backdate the "old" objects beyond the cutoff. The driver reports `lastModified` from the
    // object's own metadata rather than the body file's mtime, so the sidecar is what has to move
    // — touching the body alone would leave the sweep looking at the write time.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    for (const rel of ['_objects/_staging/old', '_objects/org-logos/old']) {
      const body = join(root, rel);
      utimesSync(body, past, past);
      const sidecar = `${body}.meta.json`;
      writeFileSync(
        sidecar,
        JSON.stringify({
          ...JSON.parse(readFileSync(sidecar, 'utf8')),
          lastModified: past.getTime(),
        }),
      );
    }

    const deleted = await store.sweepObjects('_staging/', 30 * 60 * 1000);
    expect(deleted).toBe(1);
    expect(await store.getObject('_staging/old', REF)).toBeNull();
    expect(
      (await store.getObject('_staging/fresh', REF))?.body.toString(),
    ).toBe('fresh');
    expect((await store.getObject('org-logos/old', REF))?.body.toString()).toBe(
      'keep',
    );
  });

  it('returns 0 when the prefix directory does not exist', async () => {
    const store = await fsStore();
    expect(await store.sweepObjects('_staging/', 0)).toBe(0);
  });

  it('refuses traversal prefixes', async () => {
    const store = await fsStore();
    await expect(store.sweepObjects('../escape/', 0)).rejects.toThrow(
      /invalid/i,
    );
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an unsafe age: %s',
    async (olderThanMs) => {
      const store = await fsStore();
      await expect(
        store.sweepObjects('_staging/', olderThanMs),
      ).rejects.toThrow(/olderThanMs/);
    },
  );

  it('never deletes objects whose provider timestamp is missing or invalid', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const listAll = vi.fn(() =>
      (async function* () {
        yield { key: '_staging/missing-date', size: 1 };
        yield {
          key: '_staging/invalid-date',
          size: 1,
          lastModified: new Date(Number.NaN),
        };
      })(),
    );
    const store = createObjectStoreWithClient({ provider: 's3' }, crypto, {
      delete: remove,
      listAll,
    } as never);

    await expect(store.sweepObjects('_staging/', 1)).resolves.toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('ObjectStore.listObjects (fs backend)', () => {
  it('lists only keys under the prefix, sorted', async () => {
    const store = await fsStore();
    await store.putObject(
      '_staging/u1.part-00001',
      Buffer.from('b'),
      'text/html',
      REF,
    );
    await store.putObject(
      '_staging/u1.part-00000',
      Buffer.from('a'),
      'text/html',
      REF,
    );
    await store.putObject('_staging/u2', Buffer.from('z'), 'text/html', REF);
    expect(await store.listObjects('_staging/u1.part-')).toEqual([
      '_staging/u1.part-00000',
      '_staging/u1.part-00001',
    ]);
  });

  it('returns [] for an empty prefix dir and excludes legacy .ct sidecars', async () => {
    const store = await fsStore();
    expect(await store.listObjects('_staging/none-')).toEqual([]);
    await store.putObject(
      '_staging/u3.part-00000',
      Buffer.from('a'),
      'text/html',
      REF,
    );
    // A leftover pre-envelope sidecar must not surface as a phantom key.
    writeFileSync(
      join(root, '_objects', '_staging', 'u3.part-00000.ct'),
      'text/html',
    );
    expect(await store.listObjects('_staging/u3.part-')).toEqual([
      '_staging/u3.part-00000',
    ]);
  });

  it('refuses traversal prefixes', async () => {
    const store = await fsStore();
    await expect(store.listObjects('../escape')).rejects.toThrow(/invalid/i);
  });
});

describe('ObjectStore (s3 backend)', () => {
  const s3 = mockClient(S3Client);
  const bucket = new Map<string, { body: Buffer; contentType?: string }>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'object-store-s3-spec-')); // unused; satisfies afterEach
    bucket.clear();
    s3.reset();
    s3.on(PutObjectCommand).callsFake(
      (input: { Key: string; Body: Buffer; ContentType?: string }) => {
        bucket.set(input.Key, {
          body: Buffer.from(input.Body),
          ...(input.ContentType === undefined
            ? {}
            : { contentType: input.ContentType }),
        });
        return {};
      },
    );
    s3.on(GetObjectCommand).callsFake((input: { Key: string }) => {
      const hit = bucket.get(input.Key);
      if (!hit) {
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }
      return {
        Body: {
          transformToByteArray: () => Promise.resolve(new Uint8Array(hit.body)),
          transformToWebStream: () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(hit.body));
                controller.close();
              },
            }),
        },
        ContentLength: hit.body.byteLength,
        ContentType: hit.contentType,
      };
    });
  });

  it('round-trips an envelope and keeps the real content type out of S3 metadata', async () => {
    const store = await createObjectStore(
      {
        provider: 's3',
        config: {
          endpoint: 'http://127.0.0.1:1',
          bucket: 'dummy',
          accessKeyId: 'k',
          secretAccessKey: 's',
          region: 'us-east-1',
        },
      },
      crypto,
    );
    const body = Buffer.from('logo-bytes');
    await store.putObject('org-logos/o1', body, 'image/png', {
      scope: 'org:o1',
    });
    const stored = bucket.get('org-logos/o1')!;
    expect(stored.body.subarray(0, 4).toString()).toBe('CAE1');
    expect(stored.contentType).toBe('application/octet-stream');
    const out = await store.getObject('org-logos/o1', { scope: 'org:o1' });
    expect(out?.body).toEqual(body);
    expect(out?.contentType).toBe('image/png');
    expect(
      await store.getObject('org-logos/missing', { scope: 'org:o1' }),
    ).toBeNull();
  });
});

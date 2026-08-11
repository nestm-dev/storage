import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactBundleLimitError,
  ArtifactReadLimitError,
  createArtifactStorage,
  createArtifactStorageWithClient,
  createObjectStore,
  type ArtifactStorage,
} from './index.js';
import {
  EnvelopeError,
  LocalKeyProvider,
  seal,
  SCOPE_FROM_HEADER,
  type StorageCrypto,
} from './crypto/index.js';

const crypto: StorageCrypto = {
  keyProvider: new LocalKeyProvider('spec', randomBytes(32)),
};
const REF = { scope: 'org:org-1' };
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ARTIFACT_ID = '22222222-2222-4222-8222-222222222222';

// The `fs` backend against a real temp dir: covers the write→read round-trip, ciphertext-at-rest,
// nested-parent creation, the containment guard, and the ADR D6.1 path-as-read contract.
describe('FsArtifactStorage', () => {
  let root: string;
  let storage: ArtifactStorage;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'storage-spec-'));
    storage = await createArtifactStorage(
      { provider: 'fs', config: { root } },
      crypto,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a written file through read()', async () => {
    const body = Buffer.from('{"vendored":true}', 'utf8');
    await storage.writeFile(ARTIFACT_ID, '__meta.json', body, REF);
    expect(await storage.read(ARTIFACT_ID, '__meta.json', REF)).toEqual(body);
  });

  it('bounds the opaque envelope download and decrypted plaintext', async () => {
    const body = Buffer.alloc(257, 0x61);
    await storage.writeFile(ARTIFACT_ID, 'surface.a2ui.json', body, REF);

    await expect(
      storage.read(ARTIFACT_ID, 'surface.a2ui.json', REF, {
        maxPlainBytes: 256,
      }),
    ).rejects.toEqual(new ArtifactReadLimitError(256));
    await expect(
      storage.read(ARTIFACT_ID, 'surface.a2ui.json', REF, {
        maxPlainBytes: 257,
      }),
    ).resolves.toEqual(body);
  });

  it('rejects an oversized object from metadata without downloading its body', async () => {
    const head = vi.fn().mockResolvedValue({ size: 10_000_000 });
    const downloadBytes = vi.fn();
    const bounded = createArtifactStorageWithClient(
      { provider: 's3', config: { bucket: 'unused' } },
      crypto,
      { head, downloadBytes } as never,
    );

    await expect(
      bounded.read(ARTIFACT_ID, 'surface.a2ui.json', REF, {
        maxPlainBytes: 256,
      }),
    ).rejects.toBeInstanceOf(ArtifactReadLimitError);
    expect(head).toHaveBeenCalledWith(`${ARTIFACT_ID}/surface.a2ui.json`);
    expect(downloadBytes).not.toHaveBeenCalled();
  });

  it('never masks a direct object-provider error with an index fallback', async () => {
    const fallback = await seal(
      Buffer.from('<html>fallback</html>'),
      {
        scope: REF.scope,
        artifactId: ARTIFACT_ID,
        version: null,
        path: 'docs/index.html',
      },
      crypto.keyProvider,
      'text/html; charset=utf-8',
    );
    const downloadBytes = vi.fn(async (key: string) => {
      if (key === `${ARTIFACT_ID}/docs`) throw new Error('access denied');
      return fallback;
    });
    const guarded = createArtifactStorageWithClient(
      { provider: 's3' },
      crypto,
      { downloadBytes } as never,
    );

    await expect(guarded.read(ARTIFACT_ID, 'docs', REF)).rejects.toThrow(
      'access denied',
    );
    expect(downloadBytes).toHaveBeenCalledOnce();
  });

  it('stores ciphertext, not plaintext, and nothing on disk but the object and its metadata', async () => {
    const secret = Buffer.from(
      '<html>customer dashboard 4d61726b6572</html>',
      'utf8',
    );
    await storage.writeHtml(ARTIFACT_ID, secret, REF);

    // The filesystem driver keeps a metadata sidecar beside each body — a filesystem has nowhere
    // else to put an ETag or a content type, where an object store has native metadata. It is
    // driver bookkeeping, never a key: `list` and `search` skip it. No legacy `.ct` sidecars and
    // no temp files.
    const files = readdirSync(join(root, ARTIFACT_ID), {
      recursive: true,
    }) as string[];
    expect(files.sort()).toEqual(['index.html', 'index.html.meta.json']);

    const onDisk = readFileSync(join(root, ARTIFACT_ID, 'index.html'));
    expect(onDisk.subarray(0, 4).toString()).toBe('CAE1');
    expect(onDisk.includes(secret)).toBe(false);

    // The sidecar must not become a plaintext side channel: the real content type stays inside
    // the authenticated envelope (ADR-0001), so what lands here is the opaque default.
    const sidecar = readFileSync(
      join(root, ARTIFACT_ID, 'index.html.meta.json'),
      'utf8',
    );
    expect(sidecar.includes(secret.toString())).toBe(false);
    expect(sidecar).not.toContain('text/html');
  });

  it('creates parent directories for a nested relPath', async () => {
    const body = Buffer.from('export const x = 1;', 'utf8');
    await storage.writeFile(ARTIFACT_ID, '__vendor/abc123.js', body, REF);
    expect(existsSync(join(root, ARTIFACT_ID, '__vendor', 'abc123.js'))).toBe(
      true,
    );
    expect(await storage.read(ARTIFACT_ID, '__vendor/abc123.js', REF)).toEqual(
      body,
    );
  });

  it.each(['../escape', 'a/../../escape', '/etc/passwd'])(
    'rejects a path escaping containment: %s',
    async (relPath) => {
      await expect(
        storage.writeFile(ARTIFACT_ID, relPath, Buffer.from('x'), REF),
      ).rejects.toThrow();
      // The `..` cases would resolve to `<root>/escape` (outside the artifact dir) if unguarded.
      expect(existsSync(join(root, 'escape'))).toBe(false);
    },
  );

  it.each([
    '',
    '.',
    '..',
    '../escape',
    'nested/id',
    'nested\\id',
    '_objects',
    '_OBJECTS',
    '_staging',
    'ORG-LOGOS',
  ])(
    'rejects an artifact id that can cross storage namespaces: %j',
    async (artifactId) => {
      await expect(
        storage.writeHtml(artifactId, Buffer.from('x'), REF),
      ).rejects.toThrow(/artifact id|reserved/);
      await expect(storage.remove(artifactId)).rejects.toThrow(
        /artifact id|reserved/,
      );
      await expect(storage.listFiles(artifactId)).rejects.toThrow(
        /artifact id|reserved/,
      );
    },
  );

  it('keeps the filesystem ObjectStore namespace isolated from artifact operations', async () => {
    const objects = await createObjectStore(
      { provider: 'fs', config: { root } },
      crypto,
    );
    await objects.putObject(
      'org-logos/victim',
      Buffer.from('logo'),
      'image/png',
      { scope: 'org:victim' },
    );

    await expect(storage.remove('_objects')).rejects.toThrow(/reserved/);
    await expect(storage.listFiles('_objects')).rejects.toThrow(/reserved/);
    expect(
      (await objects.getObject('org-logos/victim', { scope: 'org:victim' }))
        ?.body,
    ).toEqual(Buffer.from('logo'));
  });

  it("asserts the reader's scope (api-style read)", async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('x'), REF);
    await expect(
      storage.read(ARTIFACT_ID, 'index.html', { scope: 'org:other' }),
    ).rejects.toThrow(EnvelopeError);
  });

  it('decrypts under SCOPE_FROM_HEADER (sandbox-style read)', async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('doc'), REF);
    const out = await storage.read(ARTIFACT_ID, 'index.html', {
      scope: SCOPE_FROM_HEADER,
    });
    expect(out?.toString()).toBe('doc');
  });

  it('returns null for a missing SPA route (fallback stays a miss, not a decrypt error)', async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('doc'), REF);
    expect(await storage.read(ARTIFACT_ID, 'some/spa/route', REF)).toBeNull();
    expect(
      (await storage.read(ARTIFACT_ID, 'index.html', REF))?.toString(),
    ).toBe('doc');
  });

  it("binds the AAD to the path actually read: '' and directory rewrites (ADR D6.1)", async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('root-doc'), REF);
    await storage.writeFile(
      ARTIFACT_ID,
      'app/index.html',
      Buffer.from('app-doc'),
      REF,
    );
    // "" resolves to index.html; "app" (a directory) resolves to app/index.html — both must
    // decrypt because the write bound the same effective path the read resolves to.
    expect((await storage.read(ARTIFACT_ID, '', REF))?.toString()).toBe(
      'root-doc',
    );
    expect((await storage.read(ARTIFACT_ID, 'app', REF))?.toString()).toBe(
      'app-doc',
    );
    expect(
      (
        await storage.read(ARTIFACT_ID, 'app', REF, {
          maxPlainBytes: Buffer.byteLength('app-doc'),
        })
      )?.toString(),
    ).toBe('app-doc');
  });

  it('throws on tampered stored bytes — never serves them and never masks as 404', async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('payload'), REF);
    const file = join(root, ARTIFACT_ID, 'index.html');
    const bytes = readFileSync(file);
    bytes.writeUInt8(
      bytes.readUInt8(bytes.length - 1) ^ 0x01,
      bytes.length - 1,
    );
    writeFileSync(file, bytes);
    await expect(storage.read(ARTIFACT_ID, 'index.html', REF)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it("swapped objects fail closed: another artifact's file cannot be replayed", async () => {
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('a1'), REF);
    await storage.writeHtml(OTHER_ARTIFACT_ID, Buffer.from('a2'), REF);
    writeFileSync(
      join(root, OTHER_ARTIFACT_ID, 'index.html'),
      readFileSync(join(root, ARTIFACT_ID, 'index.html')),
    );
    await expect(
      storage.read(OTHER_ARTIFACT_ID, 'index.html', REF),
    ).rejects.toThrow(EnvelopeError);
  });

  it('reads legacy plaintext only under the explicit migration flag', async () => {
    const legacyStorage = await createArtifactStorage(
      { provider: 'fs', config: { root } },
      { ...crypto, allowLegacyPlaintext: true },
    );
    const legacy = Buffer.from('<html>pre-envelope</html>');
    mkdirSync(join(root, ARTIFACT_ID), { recursive: true });
    writeFileSync(join(root, ARTIFACT_ID, 'index.html'), legacy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await legacyStorage.read(ARTIFACT_ID, 'index.html', REF)).toEqual(
        legacy,
      );
      expect(warn).toHaveBeenCalledOnce();
      await expect(
        storage.read(ARTIFACT_ID, 'index.html', REF),
      ).rejects.toThrow(EnvelopeError);
    } finally {
      warn.mockRestore();
    }
  });

  it('expands bundles into per-entry envelopes', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html>bundle</html>'));
    zip.addFile('assets/app.js', Buffer.from('console.log(1)'));
    await storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF);
    expect(
      (await storage.read(ARTIFACT_ID, 'index.html', REF))?.toString(),
    ).toBe('<html>bundle</html>');
    expect(
      (await storage.read(ARTIFACT_ID, 'assets/app.js', REF))?.toString(),
    ).toBe('console.log(1)');
    const raw = readFileSync(join(root, ARTIFACT_ID, 'assets', 'app.js'));
    expect(raw.subarray(0, 4).toString()).toBe('CAE1');
  });

  it('preflights bundle expansion limits before writing any entry', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('first.txt', Buffer.from('ok'));
    zip.addFile('oversized.txt', Buffer.from('four'));

    await expect(
      storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
        limits: { maxEntryBytes: 3 },
      }),
    ).rejects.toEqual(new ArtifactBundleLimitError('entry-bytes'));
    expect(await storage.listFiles(ARTIFACT_ID)).toEqual([]);
  });

  it('bounds bundle entry count and total expanded bytes', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('one.txt', Buffer.from('12'));
    zip.addFile('two.txt', Buffer.from('34'));

    await expect(
      storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
        limits: { maxEntries: 1 },
      }),
    ).rejects.toEqual(new ArtifactBundleLimitError('entries'));
    await expect(
      storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
        limits: { maxTotalBytes: 3 },
      }),
    ).rejects.toEqual(new ArtifactBundleLimitError('total-bytes'));
    expect(await storage.listFiles(ARTIFACT_ID)).toEqual([]);
  });

  it('rejects case-folded duplicate bundle paths before writing', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('assets/App.js', Buffer.from('first'));
    zip.addFile('assets/app.js', Buffer.from('second'));

    await expect(
      storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF),
    ).rejects.toThrow(/duplicate entry/);
    expect(await storage.listFiles(ARTIFACT_ID)).toEqual([]);
  });

  it('rejects an escaping version id before it can address the object-store namespace', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('victim', Buffer.from('replacement'));
    const objects = await createObjectStore(
      { provider: 'fs', config: { root } },
      crypto,
    );
    await objects.putObject(
      '_staging/victim',
      Buffer.from('original'),
      'text/plain',
      { scope: 'upload:victim' },
    );

    await expect(
      storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
        versionId: '../../_objects/_staging',
      }),
    ).rejects.toThrow(/version id/);
    expect(
      (
        await objects.getObject('_staging/victim', {
          scope: 'upload:victim',
        })
      )?.body,
    ).toEqual(Buffer.from('original'));
  });

  it('rejects traversal in list prefixes and direct version references', async () => {
    await expect(
      storage.listFiles(ARTIFACT_ID, '../_objects/'),
    ).rejects.toThrow(/list prefix/);
    await expect(
      storage.writeFile(
        ARTIFACT_ID,
        'v/../../_objects/victim',
        Buffer.from('x'),
        {
          scope: REF.scope,
          version: '../../_objects',
        },
      ),
    ).rejects.toThrow(/version id|artifact path|path escapes/);
  });

  // ── AP-002 rule 2: path ⇔ version, asserted at the ctx chokepoint ─────────────
  describe('version addressing (VER-02)', () => {
    const VID = '0b3adf87-2c1a-4e9e-9f30-1c6a3a1f0000';
    const VREF = { scope: 'org:org-1', version: VID };

    it('round-trips a versioned object under v/<vid>/ with ctx.version = the vid', async () => {
      const body = Buffer.from('<html>immutable v1</html>');
      await storage.writeFile(ARTIFACT_ID, `v/${VID}/index.html`, body, VREF);
      expect(
        await storage.read(ARTIFACT_ID, `v/${VID}/index.html`, VREF),
      ).toEqual(body);
    });

    it('a versioned object can never be read as a root object (AAD binds the mode)', async () => {
      await storage.writeFile(
        ARTIFACT_ID,
        `v/${VID}/index.html`,
        Buffer.from('x'),
        VREF,
      );
      // Root-mode read of the same bytes at the same key is refused BEFORE any key op — the
      // path/version assertion throws (v/ path with version null is structurally invalid).
      await expect(
        storage.read(ARTIFACT_ID, `v/${VID}/index.html`, REF),
      ).rejects.toThrow(/reserved v\//);
    });

    it('refuses a versioned write outside its own v/<vid>/ prefix', async () => {
      await expect(
        storage.writeFile(ARTIFACT_ID, 'index.html', Buffer.from('x'), VREF),
      ).rejects.toThrow(/must live under/);
      await expect(
        storage.writeFile(
          ARTIFACT_ID,
          'v/other-vid/index.html',
          Buffer.from('x'),
          VREF,
        ),
      ).rejects.toThrow(/must live under/);
      // writeHtml hardcodes the root path — passing a version through it must fail, not
      // silently write a mis-addressed root object.
      await expect(
        storage.writeHtml(ARTIFACT_ID, Buffer.from('x'), VREF),
      ).rejects.toThrow(/must live under/);
    });

    it('refuses a root write into the reserved v/ namespace', async () => {
      await expect(
        storage.writeFile(
          ARTIFACT_ID,
          `v/${VID}/index.html`,
          Buffer.from('x'),
          REF,
        ),
      ).rejects.toThrow(/reserved v\//);
      await expect(
        storage.writeFile(
          ARTIFACT_ID,
          `V/${VID}/index.html`,
          Buffer.from('x'),
          REF,
        ),
      ).rejects.toThrow(/reserved v\//);
    });

    it('writeBundle SKIPS reserved-namespace zip entries instead of throwing mid-write', async () => {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from('<html>b</html>'));
      zip.addFile('v/legacy-asset.js', Buffer.from('evil or just unlucky'));
      zip.addFile('__meta.json', Buffer.from('{"cspTier":"locked"}')); // planted tier marker
      zip.addFile('assets/__hidden.js', Buffer.from('x'));
      zip.addFile('__vendor/abc123.js', Buffer.from('pool-shaped')); // the serving exemption
      await storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF); // must NOT throw
      expect(
        (await storage.read(ARTIFACT_ID, 'index.html', REF))?.toString(),
      ).toBe('<html>b</html>');
      const stored = (await storage.listFiles(ARTIFACT_ID)).map((f) => f.path);
      expect(stored).toEqual(['__vendor/abc123.js', 'index.html']);
    });

    it('listFiles enumerates paths + mtimes, optionally under a version prefix', async () => {
      await storage.writeHtml(ARTIFACT_ID, Buffer.from('root'), REF);
      await storage.writeFile(
        ARTIFACT_ID,
        '__meta.json',
        Buffer.from('{}'),
        REF,
      );
      await storage.writeFile(
        ARTIFACT_ID,
        `v/${VID}/index.html`,
        Buffer.from('v1'),
        VREF,
      );
      const all = await storage.listFiles(ARTIFACT_ID);
      expect(all.map((f) => f.path)).toEqual([
        '__meta.json',
        'index.html',
        `v/${VID}/index.html`,
      ]);
      expect(all.every((f) => f.lastModified instanceof Date)).toBe(true);
      const versioned = await storage.listFiles(ARTIFACT_ID, `v/${VID}/`);
      expect(versioned.map((f) => f.path)).toEqual([`v/${VID}/index.html`]);
      expect(await storage.listFiles('missing-artifact')).toEqual([]);
    });

    // ── VER-03 primitives: the publish copy loop's read/delete/versioned-bundle surface ────────
    it('readWithInfo returns the AUTHENTICATED content type alongside the plaintext', async () => {
      await storage.writeFile(
        ARTIFACT_ID,
        'assets/app.js',
        Buffer.from('console.log(1)'),
        REF,
      );
      const js = await storage.readWithInfo(ARTIFACT_ID, 'assets/app.js', REF);
      expect(js?.plain.toString()).toBe('console.log(1)');
      expect(js?.contentType).toBe('text/javascript; charset=utf-8');
      // Explicit content types survive the round-trip (writeFile's override rides the envelope).
      await storage.writeFile(
        ARTIFACT_ID,
        'data.bin',
        Buffer.from('x'),
        REF,
        'application/x-custom',
      );
      expect(
        (await storage.readWithInfo(ARTIFACT_ID, 'data.bin', REF))?.contentType,
      ).toBe('application/x-custom');
      expect(
        await storage.readWithInfo(ARTIFACT_ID, 'missing.js', REF),
      ).toBeNull();
    });

    it('readWithInfo round-trips a versioned object (the publish copy read)', async () => {
      await storage.writeFile(
        ARTIFACT_ID,
        `v/${VID}/style.css`,
        Buffer.from('body{}'),
        VREF,
      );
      const out = await storage.readWithInfo(
        ARTIFACT_ID,
        `v/${VID}/style.css`,
        VREF,
      );
      expect(out?.plain.toString()).toBe('body{}');
      expect(out?.contentType).toBe('text/css; charset=utf-8');
    });

    it('deleteFiles removes exactly the named files, ignoring misses and traversal', async () => {
      await storage.writeHtml(ARTIFACT_ID, Buffer.from('doc'), REF);
      await storage.writeFile(
        ARTIFACT_ID,
        'assets/app.js',
        Buffer.from('x'),
        REF,
      );
      await storage.writeFile(
        ARTIFACT_ID,
        'assets/old.js',
        Buffer.from('y'),
        REF,
      );
      await storage.deleteFiles(ARTIFACT_ID, [
        'assets/old.js',
        'assets/never-existed.js', // miss → no-op (publish repair re-runs the same prune)
        '../escape', // traversal → skipped, never deletes outside the artifact dir
        '/etc/passwd',
        '',
      ]);
      expect((await storage.listFiles(ARTIFACT_ID)).map((f) => f.path)).toEqual(
        ['assets/app.js', 'index.html'],
      );
    });

    it('writeBundle with versionId lands entries under v/<vid>/ sealed as versioned objects', async () => {
      const AdmZip = (await import('adm-zip')).default;
      const zip = new AdmZip();
      zip.addFile('index.html', Buffer.from('<html>v-bundle</html>'));
      zip.addFile('assets/app.js', Buffer.from('console.log(2)'));
      zip.addFile(
        'v/planted.js',
        Buffer.from('reserved entry — must be skipped, not nested'),
      );
      zip.addFile('__meta.json', Buffer.from('{"cspTier":"locked"}'));
      await storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
        versionId: VID,
      });
      expect(
        (
          await storage.read(ARTIFACT_ID, `v/${VID}/index.html`, VREF)
        )?.toString(),
      ).toBe('<html>v-bundle</html>');
      expect(
        (
          await storage.read(ARTIFACT_ID, `v/${VID}/assets/app.js`, VREF)
        )?.toString(),
      ).toBe('console.log(2)');
      // Reserved entry names are screened on the ENTRY, so nothing lands at v/<vid>/v/… or
      // v/<vid>/__meta.json — and nothing leaks to the root.
      expect((await storage.listFiles(ARTIFACT_ID)).map((f) => f.path)).toEqual(
        [`v/${VID}/assets/app.js`, `v/${VID}/index.html`],
      );
      // The versioned entries are unreadable as root objects (AAD binds the mode).
      await expect(
        storage.read(ARTIFACT_ID, `v/${VID}/index.html`, REF),
      ).rejects.toThrow(/reserved v\//);
    });
  });
});

// The `s3` backend through an in-memory mocked bucket: the same chokepoints (put/read) must
// produce and require envelopes, with the real content type kept out of S3 object metadata.
describe('S3ArtifactStorage', () => {
  const s3 = mockClient(S3Client);
  const bucket = new Map<string, { body: Buffer; contentType?: string }>();

  beforeEach(() => {
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
        // The driver streams rather than buffering, so the stub answers the same way a real
        // GetObject response does. `transformToByteArray` stays for any buffered caller.
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

  function s3Storage(): Promise<ArtifactStorage> {
    return createArtifactStorage(
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
  }

  it('round-trips through the mocked bucket as an opaque envelope', async () => {
    const storage = await s3Storage();
    const secret = Buffer.from('<html>s3 doc</html>');
    await storage.writeHtml(ARTIFACT_ID, secret, REF);
    const stored = bucket.get(`${ARTIFACT_ID}/index.html`)!;
    expect(stored.body.subarray(0, 4).toString()).toBe('CAE1');
    expect(stored.body.includes(secret)).toBe(false);
    // The served content type lives in the authenticated header, not S3 metadata (ADR D2).
    expect(stored.contentType).toBe('application/octet-stream');
    expect(await storage.read(ARTIFACT_ID, 'index.html', REF)).toEqual(secret);
    expect(await storage.read(ARTIFACT_ID, '', REF)).toEqual(secret);
  });

  it('keeps configured object namespaces disjoint on a shared object-store root', async () => {
    const config = {
      provider: 's3' as const,
      config: {
        endpoint: 'http://127.0.0.1:1',
        bucket: 'dummy',
        accessKeyId: 'k',
        secretAccessKey: 's',
        region: 'us-east-1',
      },
    };
    const storage = await createArtifactStorage(config, crypto);
    const objects = await createObjectStore(config, crypto);
    await objects.putObject(
      'org-logos/victim',
      Buffer.from('logo'),
      'image/png',
      { scope: 'org:victim' },
    );

    await expect(storage.remove('org-logos')).rejects.toThrow(/reserved/);
    await expect(storage.listFiles('ORG-LOGOS')).rejects.toThrow(/reserved/);
    expect(
      (
        await objects.getObject('org-logos/victim', {
          scope: 'org:victim',
        })
      )?.body,
    ).toEqual(Buffer.from('logo'));
  });

  it('throws on tampered bucket bytes', async () => {
    const storage = await s3Storage();
    await storage.writeHtml(ARTIFACT_ID, Buffer.from('payload'), REF);
    const stored = bucket.get(`${ARTIFACT_ID}/index.html`)!;
    stored.body.writeUInt8(
      stored.body.readUInt8(stored.body.length - 1) ^ 0x01,
      stored.body.length - 1,
    );
    await expect(storage.read(ARTIFACT_ID, 'index.html', REF)).rejects.toThrow(
      EnvelopeError,
    );
  });

  it('returns null for a miss and rejects traversal before any network call', async () => {
    const storage = await s3Storage();
    expect(await storage.read(ARTIFACT_ID, 'missing.js', REF)).toBeNull();
    await expect(
      storage.writeFile('id', '../x', Buffer.from('x'), REF),
    ).rejects.toThrow();
    expect(await storage.read('id', '../x', REF)).toBeNull();
  });

  it('readWithInfo surfaces the authenticated content type (VER-03)', async () => {
    const storage = await s3Storage();
    await storage.writeFile(ARTIFACT_ID, 'app.css', Buffer.from('body{}'), REF);
    const out = await storage.readWithInfo(ARTIFACT_ID, 'app.css', REF);
    expect(out?.plain.toString()).toBe('body{}');
    expect(out?.contentType).toBe('text/css; charset=utf-8');
    expect(
      await storage.readWithInfo(ARTIFACT_ID, 'missing.css', REF),
    ).toBeNull();
  });

  it('deleteFiles issues key-level deletes, skipping traversal (VER-03)', async () => {
    const storage = await s3Storage();
    const deleted: string[] = [];
    s3.on(DeleteObjectCommand).callsFake((input: { Key: string }) => {
      deleted.push(input.Key);
      bucket.delete(input.Key);
      return {};
    });
    await storage.writeFile(
      ARTIFACT_ID,
      'assets/old.js',
      Buffer.from('y'),
      REF,
    );
    await storage.deleteFiles(ARTIFACT_ID, [
      'assets/old.js',
      '../escape',
      '/abs',
      '',
    ]);
    expect(deleted).toEqual([`${ARTIFACT_ID}/assets/old.js`]);
    expect(await storage.read(ARTIFACT_ID, 'assets/old.js', REF)).toBeNull();
  });

  it('writeBundle with versionId prefixes keys and seals with ctx.version (VER-03)', async () => {
    const storage = await s3Storage();
    const VID = '0b3adf87-2c1a-4e9e-9f30-1c6a3a1f0000';
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<html>v</html>'));
    zip.addFile('v/planted.js', Buffer.from('reserved — skipped'));
    await storage.writeBundle(ARTIFACT_ID, zip.toBuffer(), REF, {
      versionId: VID,
    });
    expect([...bucket.keys()]).toEqual([`${ARTIFACT_ID}/v/${VID}/index.html`]);
    const out = await storage.read(ARTIFACT_ID, `v/${VID}/index.html`, {
      ...REF,
      version: VID,
    });
    expect(out?.toString()).toBe('<html>v</html>');
  });
});

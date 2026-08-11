import { createDecipheriv } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GOLDEN_CTX,
  GOLDEN_ENVELOPE,
  GOLDEN_OBJECT_CTX,
  GOLDEN_OBJECT_ENVELOPE,
  GOLDEN_OBJECT_PLAINTEXT,
  GOLDEN_PLAINTEXT,
} from '../../test/fixtures/cae1-golden.js';

import { createArtifactStorage } from './artifact-storage.js';
import { LocalKeyProvider, type EnvelopeContext } from './crypto/index.js';
import { createObjectStore } from './object-store.js';

const KEK = Buffer.from(
  '2ea36d37ad929a52dd5e0f8ea3669bc7ec7fc2f1d35ff3f9a59495ff70fc36d8',
  'hex',
);
const SCOPE = 'org:compat-org';

interface FrozenLegacyHeader {
  v: number;
  alg: string;
  kid: string;
  wdk: string;
  iv: string;
  ctx: EnvelopeContext;
  ct?: string;
}

function legacyCanonicalJson(ctx: EnvelopeContext): string {
  return JSON.stringify({
    artifactId: ctx.artifactId,
    path: ctx.path,
    scope: ctx.scope,
    version: ctx.version,
  });
}

/**
 * Frozen copy of the pre-consolidation local reader's v1 algorithm. Keep it independent from the
 * production decoder: this is the new-writer → deployed-old-reader half of the compatibility
 * contract, and a symmetric codec change must not make the test pass.
 */
function openWithFrozenLegacyLocalReader(
  bytes: Buffer,
  expectContext: EnvelopeContext,
  kek: Buffer,
  expectedKid: string,
): { plain: Buffer; contentType?: string } {
  if (bytes.subarray(0, 4).toString() !== 'CAE1') {
    throw new Error('legacy reader: bad magic');
  }
  const headerLength = bytes.readUInt32BE(4);
  const header = JSON.parse(
    bytes.subarray(8, 8 + headerLength).toString('utf8'),
  ) as FrozenLegacyHeader;
  if (
    header.v !== 1 ||
    header.alg !== 'A256GCM' ||
    header.kid !== expectedKid ||
    legacyCanonicalJson(header.ctx) !== legacyCanonicalJson(expectContext)
  ) {
    throw new Error('legacy reader: incompatible header');
  }

  const wrappedDataKey = Buffer.from(header.wdk, 'base64');
  const wrapDecipher = createDecipheriv(
    'aes-256-gcm',
    kek,
    wrappedDataKey.subarray(0, 12),
  );
  wrapDecipher.setAAD(Buffer.from(legacyCanonicalJson(header.ctx)));
  wrapDecipher.setAuthTag(wrappedDataKey.subarray(12, 28));
  const dek = Buffer.concat([
    wrapDecipher.update(wrappedDataKey.subarray(28)),
    wrapDecipher.final(),
  ]);
  try {
    const body = bytes.subarray(8 + headerLength);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(header.iv, 'base64'),
    );
    decipher.setAAD(
      Buffer.from(
        header.ct
          ? `${legacyCanonicalJson(header.ctx)}\0${header.ct}`
          : legacyCanonicalJson(header.ctx),
      ),
    );
    decipher.setAuthTag(body.subarray(body.length - 16));
    return {
      plain: Buffer.concat([
        decipher.update(body.subarray(0, body.length - 16)),
        decipher.final(),
      ]),
      ...(header.ct === undefined ? {} : { contentType: header.ct }),
    };
  } finally {
    dek.fill(0);
  }
}

describe('@nestm raw-driver compatibility', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reads artifact bytes written by the legacy raw-layout writer', async () => {
    root = mkdtempSync(join(tmpdir(), 'storage-legacy-to-nestm-'));
    const legacyPath = join(root, GOLDEN_CTX.artifactId, GOLDEN_CTX.path);
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, GOLDEN_ENVELOPE);

    const storage = await createArtifactStorage(
      { provider: 'fs', config: { root } },
      { keyProvider: new LocalKeyProvider('golden', Buffer.alloc(32, 42)) },
    );
    const result = await storage.readWithInfo(
      GOLDEN_CTX.artifactId,
      GOLDEN_CTX.path,
      { scope: GOLDEN_CTX.scope },
    );

    expect(result?.plain.toString()).toBe(GOLDEN_PLAINTEXT);
    expect(result?.contentType).toBe('text/html; charset=utf-8');
    expect(readFileSync(legacyPath)).toEqual(GOLDEN_ENVELOPE);
  });

  it('writes artifact bytes the legacy codec and layout can read unchanged', async () => {
    root = mkdtempSync(join(tmpdir(), 'storage-nestm-to-legacy-'));
    const storage = await createArtifactStorage(
      { provider: 'fs', config: { root } },
      { keyProvider: new LocalKeyProvider('compat', Buffer.from(KEK)) },
    );
    await storage.writeFile(
      'artifact-2',
      'assets/app.js',
      Buffer.from("console.log('compatible')"),
      { scope: SCOPE },
    );

    const raw = readFileSync(join(root, 'artifact-2', 'assets', 'app.js'));
    const legacyRead = openWithFrozenLegacyLocalReader(
      raw,
      {
        scope: SCOPE,
        artifactId: 'artifact-2',
        version: null,
        path: 'assets/app.js',
      },
      Buffer.from(KEK),
      'local:compat',
    );

    expect(raw.subarray(0, 4).toString()).toBe('CAE1');
    expect(legacyRead.plain.toString()).toBe("console.log('compatible')");
    expect(legacyRead.contentType).toBe('text/javascript; charset=utf-8');
  });

  it('preserves the legacy _objects layout and object-store AAD in both directions', async () => {
    root = mkdtempSync(join(tmpdir(), 'object-storage-compat-'));
    const key = GOLDEN_OBJECT_CTX.path;
    const objectPath = join(root, '_objects', key);
    mkdirSync(dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, GOLDEN_OBJECT_ENVELOPE);

    const store = await createObjectStore(
      { provider: 'fs', config: { root } },
      { keyProvider: new LocalKeyProvider('compat', Buffer.from(KEK)) },
    );
    expect(
      (await store.getObject(key, { scope: SCOPE }))?.body.toString(),
    ).toBe(GOLDEN_OBJECT_PLAINTEXT);

    await store.putObject(key, Buffer.from('new-logo'), 'image/webp', {
      scope: SCOPE,
    });
    const legacyRead = openWithFrozenLegacyLocalReader(
      readFileSync(objectPath),
      GOLDEN_OBJECT_CTX,
      Buffer.from(KEK),
      'local:compat',
    );
    expect(legacyRead.plain.toString()).toBe('new-logo');
    expect(legacyRead.contentType).toBe('image/webp');
  });
});

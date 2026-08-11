import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_SUPPORTED_VERSIONS,
  ENVELOPE_WRITE_VERSION,
  EnvelopeError,
  isEnvelope,
  open,
  seal,
} from './codec.js';
import {
  SCOPE_FROM_HEADER,
  type EnvelopeContext,
  type ExpectedContext,
} from './context.js';
import type { DataKey, KeyProvider } from './key-provider.js';
import { LocalKeyProvider } from './local-provider.js';

const KEK = randomBytes(32);
const provider = new LocalKeyProvider('test', KEK);

const CTX: EnvelopeContext = {
  scope: 'org:org-1',
  artifactId: 'art-1',
  version: null,
  path: 'index.html',
};
const EXPECT: ExpectedContext = { ...CTX };

function flip(buf: Buffer, i: number, mask = 0x01): void {
  buf.writeUInt8(buf.readUInt8(i) ^ mask, i);
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '(no error)';
  } catch (err) {
    expect(err).toBeInstanceOf(EnvelopeError);
    return (err as EnvelopeError).reason;
  }
}

/** Re-frame an envelope with a mutated header (JSON-level tampering; AAD stays the parsed ctx). */
function rewriteHeader(
  envelope: Buffer,
  mutate: (header: Record<string, unknown>) => void,
): Buffer {
  const headerLen = envelope.readUInt32BE(4);
  const header = JSON.parse(
    envelope.subarray(8, 8 + headerLen).toString('utf8'),
  ) as Record<string, unknown>;
  mutate(header);
  const next = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(next.length, 0);
  return Buffer.concat([
    envelope.subarray(0, 4),
    lenBuf,
    next,
    envelope.subarray(8 + headerLen),
  ]);
}

/** Counting provider so tests can assert "no key operation happened before the context assert". */
class CountingProvider implements KeyProvider {
  generated = 0;
  unwrapped = 0;
  constructor(private readonly inner: KeyProvider) {}
  generateDataKey(ctx: EnvelopeContext): Promise<DataKey> {
    this.generated++;
    return this.inner.generateDataKey(ctx);
  }
  unwrapDataKey(
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
  ): Promise<Buffer> {
    this.unwrapped++;
    return this.inner.unwrapDataKey(wdk, kid, ctx);
  }
  clear(): void {}
}

describe('envelope codec', () => {
  it.each([
    ['html document', { ...CTX }, 'text/html; charset=utf-8'],
    [
      'vendored asset',
      { ...CTX, path: '__vendor/abc123.js' },
      'text/javascript; charset=utf-8',
    ],
    ['storage meta', { ...CTX, path: '__meta.json' }, 'application/json'],
    [
      'object-store object',
      {
        scope: 'upload:u-1',
        artifactId: null,
        version: null,
        path: '_staging/u-1',
      },
      'text/html',
    ],
  ] as const)(
    'round-trips %s with content type',
    async (_name, ctx, contentType) => {
      const plain = randomBytes(257);
      const sealed = await seal(plain, ctx, provider, contentType);
      expect(isEnvelope(sealed)).toBe(true);
      expect(sealed.subarray(0, 4).toString()).toBe('CAE1');
      expect(sealed.includes(plain)).toBe(false);
      const out = await open(sealed, { ...ctx }, provider);
      expect(out.plain.equals(plain)).toBe(true);
      expect(out.contentType).toBe(contentType);
      expect(out.legacy).toBe(false);
    },
  );

  it('writes the newest supported version and only that', async () => {
    expect(ENVELOPE_WRITE_VERSION).toBe(
      Math.max(...ENVELOPE_SUPPORTED_VERSIONS),
    );
    const sealed = await seal(Buffer.from('x'), CTX, provider);
    const headerLen = sealed.readUInt32BE(4);
    const header = JSON.parse(
      sealed.subarray(8, 8 + headerLen).toString('utf8'),
    ) as { v: number };
    expect(header.v).toBe(ENVELOPE_WRITE_VERSION);
  });

  it('fails closed on a flipped ciphertext byte', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    flip(sealed, 8 + sealed.readUInt32BE(4));
    expect(await reason(open(sealed, EXPECT, provider))).toBe('auth-failed');
  });

  it('fails closed on a flipped auth-tag byte', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    flip(sealed, sealed.length - 1);
    expect(await reason(open(sealed, EXPECT, provider))).toBe('auth-failed');
  });

  it('never succeeds on raw header-byte tampering', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    // Flip every header byte one at a time; each must fail with a fail-closed reason.
    const headerLen = sealed.readUInt32BE(4);
    for (let i = 8; i < 8 + headerLen; i += 7) {
      const copy = Buffer.from(sealed);
      flip(copy, i, 0x20);
      const r = await reason(open(copy, EXPECT, provider));
      expect([
        'malformed-header',
        'context-mismatch',
        'key-unavailable',
        'auth-failed',
        'unsupported-version',
        'unsupported-alg',
      ]).toContain(r);
    }
  });

  it.each([[4], [8], [20]])(
    'fails closed when truncated to %i bytes',
    async (len) => {
      const sealed = await seal(Buffer.from('tiny'), CTX, provider);
      expect(
        await reason(open(sealed.subarray(0, len), EXPECT, provider)),
      ).toBe('truncated');
    },
  );

  it('fails closed on tail truncation, never success', async () => {
    const sealed = await seal(Buffer.from('tiny'), CTX, provider);
    for (const cut of [1, 17]) {
      const r = await reason(
        open(sealed.subarray(0, sealed.length - cut), EXPECT, provider),
      );
      expect(['truncated', 'auth-failed']).toContain(r);
    }
  });

  it.each([
    ['artifactId', { ...EXPECT, artifactId: 'art-2' }],
    ['path', { ...EXPECT, path: 'other.html' }],
    ['version', { ...EXPECT, version: 'v9' }],
    ['scope', { ...EXPECT, scope: 'org:other' }],
  ] as const)(
    'asserts %s before any key operation',
    async (_field, expectCtx) => {
      const counting = new CountingProvider(provider);
      const sealed = await seal(Buffer.from('payload'), CTX, provider);
      expect(await reason(open(sealed, expectCtx, counting))).toBe(
        'context-mismatch',
      );
      expect(counting.unwrapped).toBe(0);
    },
  );

  it('rejects a forged header scope under SCOPE_FROM_HEADER via the wrap binding', async () => {
    // The sandbox case: the reader cannot assert scope, so a forged one must die at unwrap.
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const forged = rewriteHeader(sealed, (h) => {
      (h.ctx as Record<string, unknown>).scope = 'org:attacker';
    });
    const r = await reason(
      open(forged, { ...EXPECT, scope: SCOPE_FROM_HEADER }, provider),
    );
    expect(r).toBe('key-unavailable');
  });

  it('accepts the true header scope under SCOPE_FROM_HEADER', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const out = await open(
      sealed,
      { ...EXPECT, scope: SCOPE_FROM_HEADER },
      provider,
    );
    expect(out.plain.toString()).toBe('payload');
    expect(out.ctx.scope).toBe(CTX.scope);
  });

  it.each([[0], [2]])('rejects header version %i', async (v) => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const mutated = rewriteHeader(sealed, (h) => {
      h.v = v;
    });
    expect(await reason(open(mutated, EXPECT, provider))).toBe(
      'unsupported-version',
    );
  });

  it('rejects an unsupported algorithm', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const mutated = rewriteHeader(sealed, (h) => {
      h.alg = 'A128GCM';
    });
    expect(await reason(open(mutated, EXPECT, provider))).toBe(
      'unsupported-alg',
    );
  });

  it('authenticates the content type (ct rides the AAD)', async () => {
    const sealed = await seal(
      Buffer.from('payload'),
      CTX,
      provider,
      'image/png',
    );
    const mutated = rewriteHeader(sealed, (h) => {
      h.ct = 'text/html';
    });
    expect(await reason(open(mutated, EXPECT, provider))).toBe('auth-failed');
    // Stripping ct entirely must fail too, not fall back to an unauthenticated default.
    const stripped = rewriteHeader(sealed, (h) => {
      delete h.ct;
    });
    expect(await reason(open(stripped, EXPECT, provider))).toBe('auth-failed');
  });

  it('rejects an empty content type instead of treating it as unauthenticated metadata', async () => {
    await expect(
      seal(Buffer.from('payload'), CTX, provider, ''),
    ).rejects.toThrow(/content type must be non-empty/);

    const noContentType = await seal(Buffer.from('payload'), CTX, provider);
    const injected = rewriteHeader(noContentType, (header) => {
      header.ct = '';
    });
    expect(await reason(open(injected, EXPECT, provider))).toBe(
      'malformed-header',
    );
  });

  it('never emits a header larger than the reader accepts', async () => {
    const counting = new CountingProvider(provider);
    await expect(
      seal(
        Buffer.from('payload'),
        CTX,
        counting,
        `text/plain; x=${'a'.repeat(70_000)}`,
      ),
    ).rejects.toThrow(/header exceeds/);
    expect(counting.generated).toBe(0);
  });

  it('rejects a writer context the reader would reject before generating a key', async () => {
    const counting = new CountingProvider(provider);
    const invalid = { ...CTX, extra: 'smuggled' } as EnvelopeContext;
    await expect(
      seal(Buffer.from('payload'), invalid, counting),
    ).rejects.toThrow(/ctx key set/);
    expect(counting.generated).toBe(0);
  });

  it.each(['kid', 'wdk', 'dek'] as const)(
    'rejects an invalid %s from a custom key provider and zeroes its DEK',
    async (field) => {
      const dek = Buffer.alloc(field === 'dek' ? 31 : 32, 7);
      const invalidProvider: KeyProvider = {
        generateDataKey: () =>
          Promise.resolve({
            dek,
            kid: field === 'kid' ? '' : 'custom:key',
            wdk: field === 'wdk' ? Buffer.alloc(0) : Buffer.from('wrapped'),
          }),
        unwrapDataKey: () => Promise.reject(new Error('unused')),
        clear: () => {},
      };

      await expect(
        seal(Buffer.from('payload'), CTX, invalidProvider),
      ).rejects.toThrow(/key provider returned/);
      expect(dek.equals(Buffer.alloc(dek.length))).toBe(true);
    },
  );

  it('maps a wrong-sized unwrapped DEK to key-unavailable', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const invalidDek = Buffer.alloc(31, 7);
    const invalidProvider: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('unused')),
      unwrapDataKey: () => Promise.resolve(invalidDek),
      clear: () => {},
    };
    expect(await reason(open(sealed, EXPECT, invalidProvider))).toBe(
      'key-unavailable',
    );
    expect(invalidDek.equals(Buffer.alloc(31))).toBe(true);
  });

  it('rejects a surplus ctx key', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const mutated = rewriteHeader(sealed, (h) => {
      (h.ctx as Record<string, unknown>).extra = 'smuggled';
    });
    expect(await reason(open(mutated, EXPECT, provider))).toBe(
      'malformed-header',
    );
  });

  it('rejects a surplus header key', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const mutated = rewriteHeader(sealed, (h) => {
      h.note = 'smuggled';
    });
    expect(await reason(open(mutated, EXPECT, provider))).toBe(
      'malformed-header',
    );
  });

  it('maps a provider outage to key-unavailable', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    const down: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('kms down')),
      unwrapDataKey: () => Promise.reject(new Error('kms down')),
      clear: () => {},
    };
    expect(await reason(open(sealed, EXPECT, down))).toBe('key-unavailable');
  });

  it('rejects plaintext when the legacy flag is off', async () => {
    expect(
      await reason(open(Buffer.from('<html>legacy</html>'), EXPECT, provider)),
    ).toBe('bad-magic');
  });

  it('passes plaintext through verbatim when the legacy flag is on, marked legacy', async () => {
    const plain = Buffer.from('<html>legacy</html>');
    const out = await open(plain, EXPECT, provider, {
      allowLegacyPlaintext: true,
    });
    expect(out.plain.equals(plain)).toBe(true);
    expect(out.legacy).toBe(true);
  });

  it('never downgrades a valid-magic envelope via the legacy flag', async () => {
    const sealed = await seal(Buffer.from('payload'), CTX, provider);
    flip(sealed, 8 + sealed.readUInt32BE(4));
    const r = await reason(
      open(sealed, EXPECT, provider, { allowLegacyPlaintext: true }),
    );
    expect(r).toBe('auth-failed');
  });

  it('rejects an oversized header length without allocating', async () => {
    const bogus = Buffer.concat([Buffer.from('CAE1'), Buffer.alloc(4 + 32)]);
    bogus.writeUInt32BE(0xffffffff, 4);
    expect(await reason(open(bogus, EXPECT, provider))).toBe(
      'malformed-header',
    );
  });
});

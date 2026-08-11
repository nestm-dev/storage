import { describe, expect, it } from 'vitest';
import {
  GOLDEN_CTX,
  GOLDEN_ENVELOPE,
  GOLDEN_KEK,
  GOLDEN_PLAINTEXT,
} from '../../../test/fixtures/cae1-golden.js';

import { open } from './codec.js';
import { canonicalJson, SCOPE_FROM_HEADER } from './context.js';
import { LocalKeyProvider } from './local-provider.js';

/**
 * FORMAT-STABILITY GUARD. This envelope was sealed once and is FROZEN: it pins the CAE1 framing,
 * the header key names, the canonicalJson key order, the AAD construction (ctx + content type),
 * and the local wrap layout. If any of these tests fail after a code change, that change silently
 * bricks every already-stored object (the CredentialCipher failure mode ADR-0001 exists to
 * prevent) — fix the code, do NOT regenerate the vector. A deliberate format change is a new
 * envelope version `v`, written alongside continued v1 read support.
 */
describe('CAE1 format stability (golden vector)', () => {
  it('opens the frozen v1 envelope byte-for-byte', async () => {
    const provider = new LocalKeyProvider('golden', GOLDEN_KEK);
    const out = await open(GOLDEN_ENVELOPE, GOLDEN_CTX, provider);
    expect(out.plain.toString('utf8')).toBe(GOLDEN_PLAINTEXT);
    expect(out.contentType).toBe('text/html; charset=utf-8');
    expect(out.legacy).toBe(false);
  });

  it("opens the frozen envelope under the sandbox's header-scope contract too", async () => {
    const provider = new LocalKeyProvider('golden', GOLDEN_KEK);
    const out = await open(
      GOLDEN_ENVELOPE,
      { ...GOLDEN_CTX, scope: SCOPE_FROM_HEADER },
      provider,
    );
    expect(out.ctx.scope).toBe('org:golden-org');
  });

  it('pins the canonical AAD serialization exactly', () => {
    // Sorted key order, no whitespace — SEC-04's rewrap tooling and every stored tag depend on it.
    expect(canonicalJson(GOLDEN_CTX)).toBe(
      '{"artifactId":"golden-artifact","path":"index.html","scope":"org:golden-org","version":null}',
    );
  });

  it('pins the frame layout and header key set', () => {
    expect(GOLDEN_ENVELOPE.subarray(0, 4).toString()).toBe('CAE1');
    const headerLen = GOLDEN_ENVELOPE.readUInt32BE(4);
    const header = JSON.parse(
      GOLDEN_ENVELOPE.subarray(8, 8 + headerLen).toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(header)).toEqual([
      'v',
      'alg',
      'kid',
      'wdk',
      'iv',
      'ctx',
      'ct',
    ]);
    expect(header.v).toBe(1);
    expect(header.alg).toBe('A256GCM');
    expect(header.kid).toBe('local:golden');
  });
});

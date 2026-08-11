import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { type EnvelopeContext } from './context.js';
import { LocalKeyProvider } from './local-provider.js';

const CTX: EnvelopeContext = {
  scope: 'org:o1',
  artifactId: 'a1',
  version: null,
  path: 'index.html',
};

describe('LocalKeyProvider', () => {
  it('round-trips a data key under the same context', async () => {
    const p = new LocalKeyProvider('test', randomBytes(32));
    const { dek, wdk, kid } = await p.generateDataKey(CTX);
    expect(kid).toBe('local:test');
    expect(wdk.includes(dek)).toBe(false);
    const out = await p.unwrapDataKey(wdk, kid, CTX);
    expect(out.equals(dek)).toBe(true);
  });

  it('binds the wrap to the full context — a different scope fails to unwrap', async () => {
    const p = new LocalKeyProvider('test', randomBytes(32));
    const { wdk, kid } = await p.generateDataKey(CTX);
    await expect(
      p.unwrapDataKey(wdk, kid, { ...CTX, scope: 'org:attacker' }),
    ).rejects.toThrow();
  });

  it('rejects a foreign kid without attempting the unwrap', async () => {
    const p = new LocalKeyProvider('test', randomBytes(32));
    const { wdk } = await p.generateDataKey(CTX);
    await expect(p.unwrapDataKey(wdk, 'local:other', CTX)).rejects.toThrow(
      /unknown key id/,
    );
  });

  it('rejects a wdk wrapped under a different KEK', async () => {
    const a = new LocalKeyProvider('test', randomBytes(32));
    const b = new LocalKeyProvider('test', randomBytes(32));
    const { wdk, kid } = await a.generateDataKey(CTX);
    await expect(b.unwrapDataKey(wdk, kid, CTX)).rejects.toThrow();
  });

  it('requires a 32-byte KEK', () => {
    expect(() => new LocalKeyProvider('test', randomBytes(16))).toThrow(
      /32 bytes/,
    );
  });
});

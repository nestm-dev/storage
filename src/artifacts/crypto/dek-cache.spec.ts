import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type EnvelopeContext } from './context.js';
import {
  CachingKeyProvider,
  MAX_DEK_CACHE_ENTRIES,
  MAX_DEK_CACHE_TTL_MS,
} from './dek-cache.js';
import type { DataKey, KeyProvider } from './key-provider.js';

const CTX: EnvelopeContext = {
  scope: 'org:o1',
  artifactId: 'a1',
  version: null,
  path: 'index.html',
};

/** Deterministic inner provider that counts calls and hands out fresh DEK copies. */
function fakeInner() {
  const calls = { generate: 0, unwrap: 0, cleared: 0 };
  const inner: KeyProvider = {
    generateDataKey(_ctx): Promise<DataKey> {
      calls.generate++;
      const dek = randomBytes(32);
      return Promise.resolve({ dek, wdk: Buffer.from(dek), kid: 'fake' });
    },
    unwrapDataKey(wdk, _kid, _ctx): Promise<Buffer> {
      calls.unwrap++;
      return Promise.resolve(Buffer.from(wdk));
    },
    clear(): void {
      calls.cleared++;
    },
  };
  return { inner, calls };
}

describe('CachingKeyProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('caches unwraps for an identical (kid, wdk, ctx) triple', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner);
    const wdk = randomBytes(32);
    const a = await cache.unwrapDataKey(wdk, 'fake', CTX);
    const b = await cache.unwrapDataKey(wdk, 'fake', CTX);
    expect(calls.unwrap).toBe(1);
    expect(a.equals(b)).toBe(true);
    // Callers own their copies: zeroing one must not poison the cache or other callers.
    a.fill(0);
    const c = await cache.unwrapDataKey(wdk, 'fake', CTX);
    expect(calls.unwrap).toBe(1);
    expect(c.equals(b)).toBe(true);
  });

  it('misses for the same wdk under a different context (the scope-enforcement property)', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner);
    const wdk = randomBytes(32);
    await cache.unwrapDataKey(wdk, 'fake', CTX);
    await cache.unwrapDataKey(wdk, 'fake', { ...CTX, scope: 'org:other' });
    // A wdk-only key would have served the second call from cache, bypassing the wrap-layer
    // context check — the exact bypass the sha256(kid‖wdk‖ctx) key exists to prevent.
    expect(calls.unwrap).toBe(2);
  });

  it('length-prefixes cache-key fields so NUL boundaries cannot collide', async () => {
    let unwraps = 0;
    const inner: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('unused')),
      unwrapDataKey: () => Promise.resolve(Buffer.alloc(32, ++unwraps)),
      clear: () => {},
    };
    const cache = new CachingKeyProvider(inner);
    const suffix = randomBytes(31);

    const legitimate = await cache.unwrapDataKey(
      Buffer.concat([Buffer.from([0]), suffix]),
      'K',
      CTX,
    );
    const forgedBoundary = await cache.unwrapDataKey(suffix, 'K\0', CTX);

    expect(unwraps).toBe(2);
    expect(legitimate.equals(forgedBoundary)).toBe(false);
  });

  it('expires entries after the TTL', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner, { ttlMs: 1000 });
    const wdk = randomBytes(32);
    await cache.unwrapDataKey(wdk, 'fake', CTX);
    vi.advanceTimersByTime(1500);
    await cache.unwrapDataKey(wdk, 'fake', CTX);
    expect(calls.unwrap).toBe(2);
  });

  it('zeroes an idle cached DEK when its TTL elapses', async () => {
    const cachedDek = Buffer.alloc(32, 7);
    const inner: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('unused')),
      unwrapDataKey: () => Promise.resolve(cachedDek),
      clear: () => {},
    };
    const cache = new CachingKeyProvider(inner, { ttlMs: 1000 });
    const callerCopy = await cache.unwrapDataKey(randomBytes(32), 'fake', CTX);
    expect(callerCopy.equals(cachedDek)).toBe(true);

    vi.advanceTimersByTime(1000);

    expect(cachedDek.equals(Buffer.alloc(32))).toBe(true);
    expect(callerCopy.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('single-flights concurrent unwraps for the same cache key', async () => {
    let resolveUnwrap: ((dek: Buffer) => void) | undefined;
    const calls = { unwrap: 0 };
    const inner: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('unused')),
      unwrapDataKey: () => {
        calls.unwrap++;
        return new Promise<Buffer>((resolve) => {
          resolveUnwrap = resolve;
        });
      },
      clear: () => {},
    };
    const cache = new CachingKeyProvider(inner);
    const wdk = randomBytes(32);
    const first = cache.unwrapDataKey(wdk, 'fake', CTX);
    const second = cache.unwrapDataKey(wdk, 'fake', CTX);
    expect(calls.unwrap).toBe(1);

    resolveUnwrap?.(Buffer.alloc(32, 9));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('never repopulates the cache from an unwrap that raced clear()', async () => {
    let resolveUnwrap: ((dek: Buffer) => void) | undefined;
    const inner: KeyProvider = {
      generateDataKey: () => Promise.reject(new Error('unused')),
      unwrapDataKey: () =>
        new Promise<Buffer>((resolve) => {
          resolveUnwrap = resolve;
        }),
      clear: () => {},
    };
    const cache = new CachingKeyProvider(inner);
    const pending = cache.unwrapDataKey(randomBytes(32), 'fake', CTX);
    cache.clear();
    const staleDek = Buffer.alloc(32, 5);
    resolveUnwrap?.(staleDek);

    await expect(pending).rejects.toThrow(/cleared during unwrap/);
    expect(staleDek.equals(Buffer.alloc(32))).toBe(true);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_DEK_CACHE_TTL_MS + 1,
  ])('rejects an unsafe cache TTL: %s', (ttlMs) => {
    const { inner } = fakeInner();
    expect(() => new CachingKeyProvider(inner, { ttlMs })).toThrow(/ttlMs/);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, MAX_DEK_CACHE_ENTRIES + 1])(
    'rejects an unsafe cache capacity: %s',
    (max) => {
      const { inner } = fakeInner();
      expect(() => new CachingKeyProvider(inner, { max })).toThrow(/max/);
    },
  );

  it('evicts the least recently used entry at capacity', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner, { max: 2 });
    const [w1, w2, w3] = [randomBytes(32), randomBytes(32), randomBytes(32)];
    await cache.unwrapDataKey(w1, 'fake', CTX);
    await cache.unwrapDataKey(w2, 'fake', CTX);
    await cache.unwrapDataKey(w1, 'fake', CTX); // refresh w1 — w2 becomes LRU
    await cache.unwrapDataKey(w3, 'fake', CTX); // evicts w2
    calls.unwrap = 0;
    await cache.unwrapDataKey(w1, 'fake', CTX);
    expect(calls.unwrap).toBe(0);
    await cache.unwrapDataKey(w2, 'fake', CTX);
    expect(calls.unwrap).toBe(1);
  });

  it('never caches generateDataKey (fresh DEK per write)', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner);
    await cache.generateDataKey(CTX);
    await cache.generateDataKey(CTX);
    expect(calls.generate).toBe(2);
  });

  it('clear() empties the cache and cascades to the inner provider', async () => {
    const { inner, calls } = fakeInner();
    const cache = new CachingKeyProvider(inner);
    const wdk = randomBytes(32);
    await cache.unwrapDataKey(wdk, 'fake', CTX);
    cache.clear();
    expect(calls.cleared).toBe(1);
    await cache.unwrapDataKey(wdk, 'fake', CTX);
    expect(calls.unwrap).toBe(2);
  });
});

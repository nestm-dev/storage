import { createHash } from 'node:crypto';

import { canonicalJson, type EnvelopeContext } from './context.js';
import type { DataKey, KeyProvider } from './key-provider.js';

export interface DekCacheOptions {
  /** Max cached unwrapped DEKs (default 1024). */
  max?: number;
  /** Entry lifetime; ADR-0001 D6.2 caps this at 5 minutes (the default). */
  ttlMs?: number;
}

/** Hard policy bounds for cached plaintext data-encryption keys. */
export const MAX_DEK_CACHE_ENTRIES = 65_536;
export const MAX_DEK_CACHE_TTL_MS = 5 * 60_000;

/**
 * Bounded in-memory LRU of unwrapped DEKs so the sandbox's per-request reads don't turn into a
 * KMS Decrypt per object (ADR-0001 D6.2). Never persisted; cleared on shutdown. Deliberate
 * T4-shaped trade: a compromised runtime could read this cache, but it can already call unwrap.
 *
 * Deviation from the ADR's literal wording, on purpose: the key is a length-prefixed hash of
 * (kid, wdk, ctx), not sha256(wdk) — keying on wdk alone would let a cache hit bypass the very
 * context check (KMS EncryptionContext / local wrap-AAD) that makes header-sourced scope
 * trustworthy. Length prefixes are required because kid may contain NUL and wdk is arbitrary
 * binary; delimiter concatenation would let distinct tuples collide before hashing.
 */
export class CachingKeyProvider implements KeyProvider {
  private readonly cache = new Map<
    string,
    {
      dek: Buffer;
      expiresAt: number;
      timer: ReturnType<typeof setTimeout>;
      token: number;
    }
  >();
  private readonly inFlight = new Map<
    string,
    { generation: number; promise: Promise<Buffer> }
  >();
  private readonly max: number;
  private readonly ttlMs: number;
  private generation = 0;
  private nextToken = 0;

  constructor(
    private readonly inner: KeyProvider,
    opts: DekCacheOptions = {},
  ) {
    this.max = opts.max ?? 1024;
    this.ttlMs = opts.ttlMs ?? MAX_DEK_CACHE_TTL_MS;
    if (
      !Number.isSafeInteger(this.max) ||
      this.max < 1 ||
      this.max > MAX_DEK_CACHE_ENTRIES
    ) {
      throw new RangeError(
        `DEK cache max must be an integer between 1 and ${MAX_DEK_CACHE_ENTRIES}`,
      );
    }
    if (
      !Number.isFinite(this.ttlMs) ||
      this.ttlMs <= 0 ||
      this.ttlMs > MAX_DEK_CACHE_TTL_MS
    ) {
      throw new RangeError(
        `DEK cache ttlMs must be greater than 0 and at most ${MAX_DEK_CACHE_TTL_MS}`,
      );
    }
  }

  generateDataKey(ctx: EnvelopeContext): Promise<DataKey> {
    // Writes always mint a fresh DEK (one per object write) — nothing to cache.
    return this.inner.generateDataKey(ctx);
  }

  async unwrapDataKey(
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
  ): Promise<Buffer> {
    const hash = createHash('sha256');
    for (const part of [
      Buffer.from(kid, 'utf8'),
      wdk,
      Buffer.from(canonicalJson(ctx), 'utf8'),
    ]) {
      const length = Buffer.allocUnsafe(8);
      length.writeBigUInt64BE(BigInt(part.byteLength));
      hash.update(length).update(part);
    }
    const key = hash.digest('hex');
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      // Refresh recency (Map preserves insertion order — oldest entry is the first key).
      this.cache.delete(key);
      this.cache.set(key, hit);
      return Buffer.from(hit.dek);
    }
    if (hit) this.evict(key, hit);

    const existingFlight = this.inFlight.get(key);
    if (
      existingFlight !== undefined &&
      existingFlight.generation === this.generation
    ) {
      const dek = await existingFlight.promise;
      if (existingFlight.generation !== this.generation) {
        throw new Error('DEK cache was cleared during unwrap');
      }
      return Buffer.from(dek);
    }

    const generation = this.generation;
    const flight = {
      generation,
      promise: this.loadAndCache(key, wdk, kid, ctx, generation),
    };
    this.inFlight.set(key, flight);
    try {
      const dek = await flight.promise;
      if (generation !== this.generation) {
        throw new Error('DEK cache was cleared during unwrap');
      }
      return Buffer.from(dek);
    } finally {
      if (this.inFlight.get(key) === flight) this.inFlight.delete(key);
    }
  }

  private async loadAndCache(
    key: string,
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
    generation: number,
  ): Promise<Buffer> {
    const dek = await this.inner.unwrapDataKey(wdk, kid, ctx);
    if (!Buffer.isBuffer(dek) || dek.length !== 32) {
      if (Buffer.isBuffer(dek)) dek.fill(0);
      throw new Error('inner key provider returned an invalid 32-byte DEK');
    }
    if (generation !== this.generation) {
      dek.fill(0);
      throw new Error('DEK cache was cleared during unwrap');
    }
    if (this.cache.size >= this.max) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.evict(oldest, this.cache.get(oldest));
    }
    const token = ++this.nextToken;
    const timer = setTimeout(() => {
      const entry = this.cache.get(key);
      if (entry?.token === token) this.evict(key, entry);
    }, this.ttlMs);
    timer.unref?.();
    this.cache.set(key, {
      dek,
      expiresAt: Date.now() + this.ttlMs,
      timer,
      token,
    });
    return dek;
  }

  clear(): void {
    for (const [key, entry] of this.cache) this.evict(key, entry);
    this.generation++;
    this.inFlight.clear();
    this.inner.clear();
  }

  private evict(
    key: string,
    entry?: { dek: Buffer; timer: ReturnType<typeof setTimeout> },
  ): void {
    if (entry !== undefined) clearTimeout(entry.timer);
    entry?.dek.fill(0);
    this.cache.delete(key);
  }
}

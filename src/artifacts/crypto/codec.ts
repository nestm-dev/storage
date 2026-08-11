import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  canonicalJson,
  SCOPE_FROM_HEADER,
  type EnvelopeContext,
  type ExpectedContext,
} from './context.js';
import type { KeyProvider } from './key-provider.js';

/**
 * Envelope v1 framing (ADR-0001 D2, normative):
 *
 *   bytes 0-3   magic "CAE1"
 *   bytes 4-7   u32 BE headerLen
 *   bytes 8-…   headerJSON (UTF-8, exactly headerLen bytes)
 *   rest        AES-256-GCM ciphertext ‖ 16-byte auth tag
 *
 * The GCM AAD is canonicalJson(ctx); ctx is duplicated in the header for operability (rewrap
 * jobs, debugging) but the BINDING is the AAD — a tampered header fails the tag check.
 */
const MAGIC = Buffer.from('CAE1');
const TAG_LEN = 16;
const IV_LEN = 12;
/** Headers are small (~400 bytes); anything larger is hostile or corrupt. */
const MAX_HEADER_LEN = 64 * 1024;
/** Maximum bytes added around plaintext by a valid CAE1 envelope. Useful for bounded raw reads. */
export const ENVELOPE_MAX_OVERHEAD_BYTES = 8 + MAX_HEADER_LEN + TAG_LEN;

export const ENVELOPE_WRITE_VERSION = 1;
export const ENVELOPE_SUPPORTED_VERSIONS: readonly number[] = [
  ENVELOPE_WRITE_VERSION,
];

export type EnvelopeFailureReason =
  | 'bad-magic'
  | 'truncated'
  | 'malformed-header'
  | 'unsupported-version'
  | 'unsupported-alg'
  | 'context-mismatch'
  | 'key-unavailable'
  | 'auth-failed';

/**
 * Structured decrypt failure. Carries only address metadata, never key material or plaintext —
 * safe to log as-is (the failure-reason counter in the runbook keys off `reason`).
 */
export class EnvelopeError extends Error {
  constructor(
    readonly reason: EnvelopeFailureReason,
    readonly artifactId: string | null,
    readonly path: string,
    detail?: string,
  ) {
    super(
      `envelope ${reason} (artifact=${artifactId ?? '-'} path=${path})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'EnvelopeError';
  }
}

interface EnvelopeHeader {
  v: number;
  alg: string;
  kid: string;
  wdk: string;
  iv: string;
  ctx: EnvelopeContext;
  ct?: string;
}

export interface OpenResult {
  plain: Buffer;
  ctx: EnvelopeContext;
  contentType?: string;
  /** True only when legacy plaintext passed through under the explicit migration flag. */
  legacy: boolean;
}

export interface OpenOptions {
  /**
   * SEC-04's migration-window escape hatch, default off. Consulted ONLY when the magic bytes
   * are absent (a pre-envelope plaintext object) — never for a valid-magic object that fails
   * validation, so the flag cannot downgrade a tampered envelope to a plaintext read.
   */
  allowLegacyPlaintext?: boolean;
}

/**
 * Payload AAD. ADR-0001 D2 specifies canonicalJson(ctx); we additionally bind `ct` (deliberate
 * strengthening, called out in the PR): the content type steers how bytes are SERVED, and it is
 * stable across SEC-04's rewrap (which rewrites only kid/wdk — those stay unbound so rewrap
 * never re-encrypts payloads; their integrity comes from the context-bound wrap itself). If a
 * future v2 coexists with v1, bind `v` too — two live versions make downgrade flips meaningful.
 */
function aadFor(ctx: EnvelopeContext, contentType?: string): Buffer {
  // NUL separator: canonicalJson is self-delimiting JSON and NUL cannot appear in a JSON string
  // or a content type, so distinct (ctx, ct) pairs can never collide into one AAD. FROZEN — the
  // golden-vector spec pins these exact bytes; changing them bricks every stored object.
  return Buffer.from(
    contentType === undefined
      ? canonicalJson(ctx)
      : `${canonicalJson(ctx)}\0${contentType}`,
  );
}

/** Encrypt one object. Mints a fresh DEK per write; the DEK never outlives the call. */
export async function seal(
  plain: Buffer,
  ctx: EnvelopeContext,
  provider: KeyProvider,
  contentType?: string,
): Promise<Buffer> {
  validateContextShape(ctx, (detail) => {
    throw new Error(`seal: invalid context (${detail})`);
  });
  if (
    contentType !== undefined &&
    (typeof contentType !== 'string' || contentType.length === 0)
  ) {
    throw new Error('seal: content type must be non-empty when provided');
  }
  // Reject obviously impossible user metadata before asking KMS to mint a data key. The exact
  // serialized header is checked again once provider-owned kid/wdk fields are available.
  const userMetadataLength = Buffer.byteLength(
    JSON.stringify({ ctx, ...(contentType ? { ct: contentType } : {}) }),
    'utf8',
  );
  if (userMetadataLength > MAX_HEADER_LEN) {
    throw new Error(`seal: envelope header exceeds ${MAX_HEADER_LEN} bytes`);
  }
  const generated = await provider.generateDataKey(ctx);
  const { dek, wdk, kid } = generated;
  try {
    if (!Buffer.isBuffer(dek) || dek.length !== 32) {
      throw new Error('seal: key provider returned an invalid 32-byte DEK');
    }
    if (!Buffer.isBuffer(wdk) || wdk.length === 0) {
      throw new Error('seal: key provider returned an empty wrapped data key');
    }
    if (typeof kid !== 'string' || kid.length === 0) {
      throw new Error('seal: key provider returned an empty key id');
    }
    const iv = randomBytes(IV_LEN);
    const header: EnvelopeHeader = {
      v: ENVELOPE_WRITE_VERSION,
      alg: 'A256GCM',
      kid,
      wdk: wdk.toString('base64'),
      iv: iv.toString('base64'),
      ctx,
      ...(contentType ? { ct: contentType } : {}),
    };
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerJson.length > MAX_HEADER_LEN) {
      throw new Error(`seal: envelope header exceeds ${MAX_HEADER_LEN} bytes`);
    }
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(aadFor(ctx, contentType));
    const body = Buffer.concat([
      cipher.update(plain),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerJson.length, 0);
    return Buffer.concat([MAGIC, lenBuf, headerJson, body]);
  } finally {
    if (Buffer.isBuffer(dek)) dek.fill(0);
  }
}

/** True when the bytes carry the envelope magic (cheap pre-check; open() revalidates). */
export function isEnvelope(bytes: Buffer): boolean {
  return (
    bytes.length >= MAGIC.length &&
    bytes.subarray(0, MAGIC.length).equals(MAGIC)
  );
}

/**
 * Decrypt one object, fail-closed (ADR-0001 D2/D6). Order matters and is normative:
 * frame → header shape → CONTEXT ASSERTION → key unwrap → tag check. The context assertion runs
 * before any key operation so a swapped object costs no KMS call and leaks no oracle; `scope`
 * alone may come from the header (SCOPE_FROM_HEADER) because the wrap layer binds it.
 */
export async function open(
  bytes: Buffer,
  expect: ExpectedContext,
  provider: KeyProvider,
  opts: OpenOptions = {},
): Promise<OpenResult> {
  const fail = (reason: EnvelopeFailureReason, detail?: string): never => {
    throw new EnvelopeError(reason, expect.artifactId, expect.path, detail);
  };

  if (!isEnvelope(bytes)) {
    if (opts.allowLegacyPlaintext)
      return { plain: bytes, ctx: legacyCtx(expect), legacy: true };
    fail('bad-magic');
  }
  if (bytes.length < 8) fail('truncated', 'no header length');
  const headerLen = bytes.readUInt32BE(4);
  if (headerLen > MAX_HEADER_LEN)
    fail('malformed-header', 'header length out of range');
  if (8 + headerLen + TAG_LEN > bytes.length)
    fail('truncated', 'body shorter than header + tag');

  let header: EnvelopeHeader;
  try {
    header = JSON.parse(
      bytes.subarray(8, 8 + headerLen).toString('utf8'),
    ) as EnvelopeHeader;
  } catch {
    return fail('malformed-header', 'header is not valid JSON');
  }
  validateHeaderShape(header, fail);
  if (header.v !== ENVELOPE_WRITE_VERSION) {
    // Reads must support every version in ENVELOPE_SUPPORTED_VERSIONS; with only v1 defined,
    // anything else is unsupported. A future v2 branches here — writes stay on the newest
    // version and never silently downgrade.
    fail('unsupported-version', `v=${String(header.v)}`);
  }
  if (header.alg !== 'A256GCM') fail('unsupported-alg', header.alg);

  const ctx = header.ctx;
  // The anti-swap assertion: every field the reader independently knows must match the header
  // BEFORE any key operation. Only `scope` may be delegated to the header (sandbox), where the
  // wrap binding enforces it instead.
  if (ctx.artifactId !== expect.artifactId)
    fail('context-mismatch', 'artifactId');
  if (ctx.path !== expect.path) fail('context-mismatch', 'path');
  if (ctx.version !== expect.version) fail('context-mismatch', 'version');
  if (expect.scope !== SCOPE_FROM_HEADER && ctx.scope !== expect.scope) {
    fail('context-mismatch', 'scope');
  }

  const iv = Buffer.from(header.iv, 'base64');
  if (iv.length !== IV_LEN) fail('malformed-header', 'iv must be 12 bytes');
  const wdk = Buffer.from(header.wdk, 'base64');
  if (wdk.length === 0) fail('malformed-header', 'empty wrapped data key');

  let unwrapped: unknown;
  try {
    unwrapped = await provider.unwrapDataKey(wdk, header.kid, ctx);
  } catch {
    // Wrong wrap context, foreign kid, or an unavailable key service — indistinguishable by
    // design; serving plaintext because the key layer failed is the vulnerability (ADR D7).
    return fail('key-unavailable');
  }
  if (!Buffer.isBuffer(unwrapped) || unwrapped.length !== 32) {
    if (Buffer.isBuffer(unwrapped)) unwrapped.fill(0);
    return fail('key-unavailable');
  }
  const dek = unwrapped;
  try {
    const body = bytes.subarray(8 + headerLen);
    const tag = body.subarray(body.length - TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aadFor(ctx, header.ct));
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_LEN)),
        decipher.final(),
      ]);
    } catch {
      return fail('auth-failed');
    }
    return {
      plain,
      ctx,
      ...(header.ct === undefined ? {} : { contentType: header.ct }),
      legacy: false,
    };
  } finally {
    dek.fill(0);
  }
}

/** Header-shape validation: exact key sets, exact types. Any surplus key is hostile (ADR D2). */
function validateHeaderShape(
  header: EnvelopeHeader,
  fail: (reason: EnvelopeFailureReason, detail?: string) => never,
): void {
  if (typeof header !== 'object' || header === null)
    fail('malformed-header', 'not an object');
  const allowed = new Set(['v', 'alg', 'kid', 'wdk', 'iv', 'ctx', 'ct']);
  for (const key of Object.keys(header)) {
    if (!allowed.has(key))
      fail('malformed-header', `unexpected header key "${key}"`);
  }
  if (typeof header.v !== 'number') fail('malformed-header', 'v');
  if (typeof header.alg !== 'string') fail('malformed-header', 'alg');
  if (typeof header.kid !== 'string' || header.kid === '')
    fail('malformed-header', 'kid');
  if (typeof header.wdk !== 'string' || header.wdk === '')
    fail('malformed-header', 'wdk');
  if (typeof header.iv !== 'string') fail('malformed-header', 'iv');
  if (
    header.ct !== undefined &&
    (typeof header.ct !== 'string' || header.ct.length === 0)
  )
    fail('malformed-header', 'ct');
  validateContextShape(header.ctx, (detail) =>
    fail('malformed-header', detail),
  );
}

function validateContextShape(
  ctx: unknown,
  fail: (detail: string) => never,
): asserts ctx is EnvelopeContext {
  if (typeof ctx !== 'object' || ctx === null) fail('ctx');
  const ctxKeys = Object.keys(ctx);
  const expected = ['scope', 'artifactId', 'version', 'path'];
  if (
    ctxKeys.length !== expected.length ||
    expected.some((k) => !ctxKeys.includes(k))
  ) {
    // Exactly these four keys: a surplus field could otherwise ride the AAD unexamined.
    fail('ctx key set');
  }
  const c = ctx as Record<string, unknown>;
  if (
    typeof c.scope !== 'string' ||
    c.scope === '' ||
    c.scope === SCOPE_FROM_HEADER
  ) {
    fail('ctx.scope');
  }
  if (c.artifactId !== null && typeof c.artifactId !== 'string')
    fail('ctx.artifactId');
  if (c.version !== null && typeof c.version !== 'string') fail('ctx.version');
  if (typeof c.path !== 'string') fail('ctx.path');
}

/** Descriptive ctx for a legacy plaintext pass-through (nothing was verified). */
function legacyCtx(expect: ExpectedContext): EnvelopeContext {
  return {
    scope:
      expect.scope === SCOPE_FROM_HEADER ? 'legacy:unverified' : expect.scope,
    artifactId: expect.artifactId,
    version: expect.version,
    path: expect.path,
  };
}

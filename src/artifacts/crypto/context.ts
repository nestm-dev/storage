/**
 * The encryption context that binds every stored object to its address (ADR-0001 D2). It is the
 * GCM AAD of the payload AND the wrap context of the data key, so a ciphertext moved to another
 * scope/artifact/path fails closed at decrypt — object swapping and cross-artifact replay are
 * structurally impossible, not policy-checked.
 */
export interface EnvelopeContext {
  /** Owning tenant: `org:<organizationId>` | `user:<ownerUserId>` | `upload:<uploadId>`. */
  scope: string;
  /** The artifact the object belongs to; `null` for non-artifact ObjectStore objects. */
  artifactId: string | null;
  /** Immutable version id; `null` until VER-02 introduces versions. */
  version: string | null;
  /** Storage-relative path AS READ (e.g. `index.html` on the fs directory rewrite — ADR D6.1). */
  path: string;
}

/**
 * Read-side sentinel for callers that cannot independently know the owning scope — the sandbox,
 * which has only the artifactId from the URL and no DB. The reader still asserts every field it
 * DOES know (artifactId, path, version) against the cleartext header before any key operation;
 * `scope` is then taken from the header and enforced cryptographically by the wrap layer: the
 * KMS EncryptionContext / local wrap-AAD includes it, so a forged header scope fails at
 * `unwrapDataKey`, not silently.
 */
export const SCOPE_FROM_HEADER = '@from-header';

/** What a reader knows independently about the object it expects (the anti-swap assertion). */
export interface ExpectedContext {
  // `string` absorbs the literal for the checker, but the sentinel is domain vocabulary
  // here — collapsing the union would erase what @from-header means to a reader.
  // eslint-disable-next-line typescript/no-redundant-type-constituents
  scope: string | typeof SCOPE_FROM_HEADER;
  artifactId: string | null;
  version: string | null;
  path: string;
}

/** Scope for an artifact: the owning org when there is one, else the owning user. */
export function artifactScope(owner: {
  organizationId?: string | null;
  ownerUserId: string;
}): string {
  return owner.organizationId
    ? `org:${owner.organizationId}`
    : `user:${owner.ownerUserId}`;
}

/** Scope for organization-owned non-artifact objects (logos). */
export function orgScope(organizationId: string): string {
  return `org:${organizationId}`;
}

/** Scope for staged upload objects (`_staging/*`) — short-lived but still customer plaintext. */
export function uploadScope(uploadId: string): string {
  return `upload:${uploadId}`;
}

/**
 * Canonical serialization used as the payload AAD and the local wrap AAD: fixed sorted key
 * order, no whitespace. Rebuilt from parsed values so header key ORDER never matters, while the
 * key SET is pinned by the codec's strict header validation.
 */
export function canonicalJson(ctx: EnvelopeContext): string {
  return JSON.stringify({
    artifactId: ctx.artifactId,
    path: ctx.path,
    scope: ctx.scope,
    version: ctx.version,
  });
}

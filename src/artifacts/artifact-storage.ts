import {
  StorageErrorCode,
  isStorageError,
  type StorageClient,
} from '../core/index.js';
import AdmZip from 'adm-zip';
import { extname } from 'node:path';

import {
  ENVELOPE_MAX_OVERHEAD_BYTES,
  open,
  seal,
  SCOPE_FROM_HEADER,
  type EnvelopeContext,
  type StorageCrypto,
} from './crypto/index.js';
import {
  createArtifactStorageClient,
  DEFAULT_OBJECT_NAMESPACES,
  resolveObjectNamespaces,
  type ArtifactStorageConfig,
} from './storage-driver.js';

export {
  assertStorageProvider,
  defaultFsRoot,
  type ArtifactStorageConfig,
} from './storage-driver.js';

/**
 * Storage for uploaded artifact files, keyed `<artifactId>/<path>` (e.g. `<id>/index.html`,
 * `<id>/assets/app.js`). The api writes; the sandbox reads. The `fs` provider keeps both pointed
 * at one directory (fine for a single host / shared volume); any object-store provider — S3, GCS,
 * Azure, R2, and the rest — lets the two services share storage without a shared volume, which is
 * what running them on separate hosts (as on ECS) requires.
 *
 * Every object is stored as a CAE1 encryption envelope (ADR-0001, SEC-03): callers must say who
 * owns what they write (`ScopeRef`) and what they expect to read (`ReadRef`) — the codec binds
 * ciphertext to `{scope, artifactId, version, path}` so a swapped or replayed object fails closed.
 */
export interface ArtifactStorage {
  /** Single self-contained HTML artifact → `<id>/index.html`. */
  writeHtml(artifactId: string, buffer: Buffer, ref: ScopeRef): Promise<void>;
  /**
   * Pre-built SPA bundle (a zip whose root contains index.html). Encrypted per extracted entry.
   * With `opts.versionId` (VER-03), entries land under `v/<versionId>/…` and are sealed with
   * `ctx.version = versionId` (the caller's `ref.version` is overridden to match — the path⇔version
   * biconditional is derived, never trusted). Reserved-namespace screening applies to the zip
   * ENTRY name in both modes: a bundle shipping `v/…` or `__…` files has those skipped, not nested.
   */
  writeBundle(
    artifactId: string,
    zipBuffer: Buffer,
    ref: ScopeRef,
    opts?: WriteBundleOptions,
  ): Promise<void>;
  /**
   * Write an arbitrary file within the artifact (e.g. `__vendor/<hash>.js`, `__meta.json`).
   * Rejects any `relPath` escaping the artifact directory. `contentType` rides the envelope
   * header (authenticated) on both backends.
   */
  writeFile(
    artifactId: string,
    relPath: string,
    buffer: Buffer,
    ref: ScopeRef,
    contentType?: string,
  ): Promise<void>;
  /** Server-rendered PNG preview → reserved key `<id>/__thumb.png`. */
  writeThumbnail(
    artifactId: string,
    pngBuffer: Buffer,
    ref: ScopeRef,
  ): Promise<void>;
  /** Delete every file under the artifact (includes the thumbnail). */
  remove(artifactId: string): Promise<void>;
  /**
   * Read a file within the artifact; `relPath === ""` resolves to index.html. `null` if absent.
   * Throws `EnvelopeError` on any decrypt failure — a corrupt or swapped object must never be
   * mistaken for a missing one (no SPA fallback over tampering).
   */
  read(
    artifactId: string,
    relPath: string,
    ref: ReadRef,
    options?: ArtifactReadOptions,
  ): Promise<Buffer | null>;
  /**
   * Like `read`, but also returns the envelope's AUTHENTICATED content type (VER-03). This is the
   * read primitive for publish/CoW copy loops: a decrypt→re-encrypt copy must re-seal with the
   * same `ct` it opened (the type is AAD-bound and steers serving), and `read()` discards it.
   * `contentType` is undefined only for legacy plaintext pass-throughs (nothing was verified).
   */
  readWithInfo(
    artifactId: string,
    relPath: string,
    ref: ReadRef,
    options?: ArtifactReadOptions,
  ): Promise<StoredObject | null>;
  /**
   * Delete specific files under the artifact (VER-03: publish prunes root paths removed by the
   * newly-materialized version). Paths escaping the artifact directory and missing paths are
   * ignored (idempotent — publish repair re-runs the same prune).
   */
  deleteFiles(artifactId: string, relPaths: string[]): Promise<void>;
  /**
   * List stored objects under the artifact (optionally under `subPrefix`, e.g. `v/<versionId>/`).
   * Returns artifact-relative forward-slash paths + last-modified stamps, sorted by path. Reads
   * no object bodies and needs no crypto — it serves the sweepers/invariants (version-prefix
   * existence, orphan-prefix age, canonical bundle enumeration), never the serving plane.
   */
  listFiles(artifactId: string, subPrefix?: string): Promise<StoredFileInfo[]>;
}

/** One listed storage object (metadata only — the body stays sealed). */
export interface StoredFileInfo {
  /** Artifact-relative path, forward slashes (e.g. `index.html`, `v/<vid>/index.html`). */
  path: string;
  lastModified: Date;
}

/** A decrypted object plus the authenticated content type it was sealed with (see readWithInfo). */
export interface StoredObject {
  plain: Buffer;
  /** From the envelope header (`ct`, AAD-bound); undefined for legacy plaintext pass-throughs. */
  contentType?: string;
}

/** Bounds decrypted data while also bounding the opaque envelope downloaded before decryption. */
export interface ArtifactReadOptions {
  readonly maxPlainBytes?: number;
}

/** Permanent, address-independent read rejection safe for callers to map to a bounded 4xx. */
export class ArtifactReadLimitError extends Error {
  constructor(readonly maxPlainBytes: number) {
    super(`artifact plaintext exceeds the ${maxPlainBytes} byte read limit`);
    this.name = 'ArtifactReadLimitError';
  }
}

/** Permanent rejection for a ZIP whose declared expansion exceeds the public protocol limits. */
export class ArtifactBundleLimitError extends Error {
  constructor(readonly reason: 'entries' | 'entry-bytes' | 'total-bytes') {
    super(`artifact bundle exceeds the ${reason} limit`);
    this.name = 'ArtifactBundleLimitError';
  }
}

export const ARTIFACT_BUNDLE_MAX_ENTRIES = 1_000;
export const ARTIFACT_BUNDLE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const ARTIFACT_BUNDLE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Reserved storage path for the generated PNG preview, served by the sandbox as `<id>/__thumb.png`. */
export const THUMBNAIL_KEY = '__thumb.png';

/** Options for writeBundle (VER-03 versioned bundle writes). */
export interface WriteBundleOptions {
  /** Write entries under `v/<versionId>/…` with `ctx.version = versionId` instead of the root. */
  versionId?: string;
  /** Optional stricter limits; values may lower, but never raise, the protocol hard limits. */
  limits?: {
    maxEntries?: number;
    maxEntryBytes?: number;
    maxTotalBytes?: number;
  };
}

/** Who owns an object being written; `version` stays null until VER-02 introduces versions. */
export interface ScopeRef {
  /** `org:<organizationId>` | `user:<ownerUserId>` | `upload:<uploadId>` — see artifactScope(). */
  scope: string;
  version?: string | null;
}

/**
 * What the reader independently knows. The api asserts the scope it fetched from the DB; the
 * sandbox — which only knows the artifactId — passes SCOPE_FROM_HEADER and relies on the wrap
 * layer to enforce scope cryptographically (see crypto/context.ts).
 */
export interface ReadRef {
  // `string` absorbs the literal for the checker, but the sentinel is domain vocabulary
  // here — collapsing the union would erase what @from-header means to a reader.
  // eslint-disable-next-line typescript/no-redundant-type-constituents
  scope: string | typeof SCOPE_FROM_HEADER;
  version?: string | null;
}

export async function createArtifactStorage(
  cfg: ArtifactStorageConfig,
  crypto: StorageCrypto,
): Promise<ArtifactStorage> {
  return createArtifactStorageWithClient(
    cfg,
    crypto,
    await createArtifactStorageClient(cfg),
  );
}

/** Framework-neutral domain adapter used by both direct consumers and the Nest composition entry. */
export function createArtifactStorageWithClient(
  cfg: ArtifactStorageConfig,
  crypto: StorageCrypto,
  client: StorageClient,
): ArtifactStorage {
  return new ClientArtifactStorage(
    crypto,
    client,
    resolveObjectNamespaces(cfg.objectNamespaces ?? DEFAULT_OBJECT_NAMESPACES),
    cfg.provider === 'fs',
  );
}

/**
 * Storage path prefix for a version's objects (AP-002): `""` for a backfilled `canonical_v1`
 * version (its bytes ARE the canonical root objects) and `v/<versionId>/` for a `versioned` one.
 */
export function versionPrefix(
  layout: 'canonical_v1' | 'versioned',
  versionId: string,
): string {
  assertVersionId(versionId);
  return layout === 'canonical_v1' ? '' : `v/${versionId}/`;
}

/**
 * Envelope `ctx.version` for a version's objects (AP-002): `null` for `canonical_v1` (root AAD —
 * the serving plane is version-free forever) and the version UUID, byte-identical to the path
 * segment, for `versioned`.
 */
export function versionAad(
  layout: 'canonical_v1' | 'versioned',
  versionId: string,
): string | null {
  assertVersionId(versionId);
  return layout === 'canonical_v1' ? null : versionId;
}

/** Artifact ids are one storage segment; `_objects` is the filesystem object-store namespace. */
export function assertArtifactId(artifactId: string): void {
  assertStorageSegment(artifactId, 'artifact id');
  if (artifactId.toLowerCase() === '_objects') {
    throw new Error('storage: artifact id "_objects" is reserved');
  }
}

/** Version ids are one storage segment because they are interpolated under `v/<id>/`. */
export function assertVersionId(versionId: string): void {
  assertStorageSegment(versionId, 'version id');
}

function assertStorageSegment(value: string, label: string): void {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > 255
  ) {
    throw new Error(`storage: invalid ${label} ${JSON.stringify(value)}`);
  }
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function isUnsafeRelativePath(
  path: string,
  allowEmpty = false,
  allowTrailingSlash = false,
): boolean {
  if (path === '') return !allowEmpty;
  if (path.startsWith('/') || path.includes('\0')) {
    return true;
  }
  const segments = path.split('/');
  if (allowTrailingSlash && segments.at(-1) === '') segments.pop();
  return segments.some(
    (segment) => segment === '' || segment === '.' || segment === '..',
  );
}

/**
 * Is this artifact-relative path inside the namespaces VER-02 reserves for the platform — the
 * `v/` version prefix and the `__`-internal families (meta/thumb/source/snapshot/overflow) —
 * with the one serving exemption, top-level single-segment `__vendor/<name>` pool assets?
 * User-supplied bundle entries matching this are SKIPPED at write time (writeBundle), exactly
 * like zip-slip entries: the sandbox deny-guard will never serve them, and letting them through
 * to the seal chokepoint would turn a hostile/quirky zip into a mid-write throw.
 */
export function isReservedArtifactPath(relPath: string): boolean {
  const segments = relPath.split('/');
  if (segments[0]?.toLowerCase() === 'v') return true;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined || !seg.startsWith('__')) continue;
    if (
      i === 0 &&
      seg === '__vendor' &&
      segments.length === 2 &&
      segments[1] !== ''
    )
      continue;
    return true;
  }
  return false;
}

/**
 * AP-002 storage rule 2: `path.startsWith("v/" + version + "/") ⇔ version !== null`. Root objects
 * never live under the reserved `v/` namespace and versioned objects never live anywhere else —
 * asserted at the single ctx chokepoint (covers reads and writes, both backends), so a
 * mis-addressed artifact object is impossible rather than unlikely. Throws (fail-closed): this is
 * a programming error, never user input — every USER-named path (zip entries) is screened by
 * `isReservedArtifactPath` before it can reach this assertion.
 */
export function assertVersionPath(path: string, version: string | null): void {
  if (isUnsafeRelativePath(path)) {
    throw new Error(`storage: invalid artifact path ${JSON.stringify(path)}`);
  }
  if (version !== null) {
    assertVersionId(version);
    if (!path.startsWith(`v/${version}/`)) {
      throw new Error(
        `storage: versioned object path "${path}" must live under "v/${version}/" (AP-002 rule 2)`,
      );
    }
  } else if (path.split('/', 1)[0]?.toLowerCase() === 'v') {
    throw new Error(
      `storage: root object path "${path}" is inside the reserved v/ namespace (AP-002 rule 2)`,
    );
  }
}

type RawRead =
  | { kind: 'hit'; raw: Buffer; rel: string }
  | { kind: 'miss' }
  | { kind: 'error'; error: unknown };

interface PreparedBundleEntry {
  name: string;
  body: Buffer;
}

function bundleLimit(
  requested: number | undefined,
  hardLimit: number,
  name: string,
): number {
  const value = requested ?? hardLimit;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
    throw new RangeError(
      `${name} must be an integer between 1 and ${hardLimit}`,
    );
  }
  return value;
}

function prepareBundle(
  zipBuffer: Buffer,
  limits: WriteBundleOptions['limits'],
): PreparedBundleEntry[] {
  const maxEntries = bundleLimit(
    limits?.maxEntries,
    ARTIFACT_BUNDLE_MAX_ENTRIES,
    'maxEntries',
  );
  const maxEntryBytes = bundleLimit(
    limits?.maxEntryBytes,
    ARTIFACT_BUNDLE_MAX_ENTRY_BYTES,
    'maxEntryBytes',
  );
  const maxTotalBytes = bundleLimit(
    limits?.maxTotalBytes,
    ARTIFACT_BUNDLE_MAX_TOTAL_BYTES,
    'maxTotalBytes',
  );
  const entries = new AdmZip(zipBuffer).getEntries();
  if (entries.length > maxEntries) {
    throw new ArtifactBundleLimitError('entries');
  }

  const accepted: Array<{ entry: (typeof entries)[number]; name: string }> = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = normalizeRelativePath(entry.entryName).replace(/^\/+/, '');
    if (isUnsafeRelativePath(name) || isReservedArtifactPath(name)) {
      continue;
    }
    const portableName = name.toLowerCase();
    if (names.has(portableName)) {
      throw new Error(`artifact bundle contains duplicate entry "${name}"`);
    }
    names.add(portableName);
    const declaredSize = entry.header.size;
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > maxEntryBytes
    ) {
      throw new ArtifactBundleLimitError('entry-bytes');
    }
    declaredTotal += declaredSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > maxTotalBytes) {
      throw new ArtifactBundleLimitError('total-bytes');
    }
    accepted.push({ entry, name });
  }

  // Inflate and validate every accepted entry before the first storage write. This bounds peak
  // memory by maxTotalBytes and prevents a late malformed/oversized entry from leaving a partial
  // bundle behind.
  const prepared: PreparedBundleEntry[] = [];
  let actualTotal = 0;
  for (const { entry, name } of accepted) {
    const body = entry.getData();
    if (body.length > maxEntryBytes) {
      throw new ArtifactBundleLimitError('entry-bytes');
    }
    actualTotal += body.length;
    if (!Number.isSafeInteger(actualTotal) || actualTotal > maxTotalBytes) {
      throw new ArtifactBundleLimitError('total-bytes');
    }
    prepared.push({ name, body });
  }
  return prepared;
}

/** Envelope context for an artifact-relative path. */
function artifactCtx(
  artifactId: string,
  path: string,
  ref: ScopeRef | ReadRef,
): EnvelopeContext {
  assertArtifactId(artifactId);
  const version = ref.version ?? null;
  assertVersionPath(path, version);
  return { scope: ref.scope as string, artifactId, version, path };
}

/** Structured, greppable trace of a legacy plaintext pass-through (SEC-04 migration window). */
export function warnLegacyRead(where: string, key: string): void {
  // `console` is deliberate: this package is consumed by apps/sandbox as well as the Nest API,
  // so a framework logger is not available here. It is the only portable sink.
  // eslint-disable-next-line no-console
  console.warn(
    `[storage] legacy plaintext read (${where}): ${key} — pending SEC-04 backfill`,
  );
}

// ── storage-client backend ───────────────────────────────────────────────────
/**
 * The one implementation, for every provider. It reaches storage only through `StorageClient`,
 * so filesystem, S3, GCS, Azure, R2 and the rest differ by driver, not by code path here. The
 * filesystem once had a parallel implementation that resolved real paths and probed with
 * `existsSync`; it is gone, and with it the chance of the two drifting on reserved namespaces,
 * version prefixes, or traversal guards.
 */
class ClientArtifactStorage implements ArtifactStorage {
  constructor(
    private readonly crypto: StorageCrypto,
    private readonly client: StorageClient,
    private readonly objectNamespaces: ReadonlySet<string>,
    private readonly filesystemLayout: boolean,
  ) {}

  private assertArtifactId(artifactId: string): void {
    assertArtifactId(artifactId);
    if (this.objectNamespaces.has(artifactId.toLowerCase())) {
      throw new Error(
        `storage: artifact id ${JSON.stringify(artifactId)} is a reserved object namespace`,
      );
    }
  }

  async writeHtml(
    artifactId: string,
    buffer: Buffer,
    ref: ScopeRef,
  ): Promise<void> {
    await this.put(
      artifactId,
      'index.html',
      buffer,
      ref,
      'text/html; charset=utf-8',
    );
  }

  async writeBundle(
    artifactId: string,
    zipBuffer: Buffer,
    ref: ScopeRef,
    opts?: WriteBundleOptions,
  ): Promise<void> {
    this.assertArtifactId(artifactId);
    // Versioned mode (VER-03): mirror the fs backend — prefix + derived ctx.version, entry-name
    // screening unchanged.
    const versionId = opts?.versionId;
    if (versionId !== undefined) assertVersionId(versionId);
    const prefix = versionId === undefined ? '' : `v/${versionId}/`;
    const effRef: ScopeRef =
      versionId === undefined ? ref : { ...ref, version: versionId };
    const entries = prepareBundle(zipBuffer, opts?.limits);
    for (const { name, body } of entries) {
      // `__vendor/<name>` stays ROOT-scoped in versioned mode — see the fs backend.
      if (prefix !== '' && /^__vendor\/[^/]+$/.test(name)) {
        await this.put(
          artifactId,
          name,
          body,
          { scope: ref.scope },
          contentTypeFor(name),
        );
        continue;
      }
      await this.put(
        artifactId,
        prefix + name,
        body,
        effRef,
        contentTypeFor(name),
      );
    }
  }

  async writeFile(
    artifactId: string,
    relPath: string,
    buffer: Buffer,
    ref: ScopeRef,
    contentType?: string,
  ): Promise<void> {
    const name = normalizeRelativePath(relPath);
    // containment guard at the key level: reject absolute paths, empty, or any traversal segment.
    if (isUnsafeRelativePath(name)) {
      throw new Error(`writeFile: path escapes artifact directory: ${relPath}`);
    }
    await this.put(
      artifactId,
      name,
      buffer,
      ref,
      contentType ?? contentTypeFor(name),
    );
  }

  async writeThumbnail(
    artifactId: string,
    pngBuffer: Buffer,
    ref: ScopeRef,
  ): Promise<void> {
    await this.put(artifactId, THUMBNAIL_KEY, pngBuffer, ref, 'image/png');
  }

  async remove(artifactId: string): Promise<void> {
    this.assertArtifactId(artifactId);
    for await (const object of this.client.listAll({
      prefix: `${artifactId}/`,
    })) {
      await this.client.delete(object.key);
    }
  }

  async listFiles(
    artifactId: string,
    subPrefix = '',
  ): Promise<StoredFileInfo[]> {
    this.assertArtifactId(artifactId);
    const normalizedPrefix = normalizeRelativePath(subPrefix);
    if (isUnsafeRelativePath(normalizedPrefix, true, true)) {
      throw new Error(
        `storage: invalid artifact list prefix ${JSON.stringify(subPrefix)}`,
      );
    }
    const base = `${artifactId}/`;
    const out: StoredFileInfo[] = [];
    for await (const object of this.client.listAll({
      prefix: `${base}${normalizedPrefix}`,
    })) {
      if (!object.key.startsWith(base)) continue;
      out.push({
        path: object.key.slice(base.length),
        lastModified: object.lastModified ?? new Date(0),
      });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(
    artifactId: string,
    relPath: string,
    ref: ReadRef,
    options?: ArtifactReadOptions,
  ): Promise<Buffer | null> {
    const out = await this.readWithInfo(artifactId, relPath, ref, options);
    return out === null ? null : out.plain;
  }

  /**
   * Raw bytes for one artifact-relative path. Reports a plain miss and a provider failure
   * separately so the caller can retry a directory-shaped key without ever turning a genuine
   * backend failure into a 404.
   */
  private async fetchRaw(
    artifactId: string,
    rel: string,
    options: ArtifactReadOptions | undefined,
    preflight = true,
  ): Promise<RawRead> {
    const key = `${artifactId}/${rel}`;
    if (preflight && !(await preflightRawRead(this.client, key, options)))
      return { kind: 'miss' };
    try {
      const bytes = await this.client.downloadBytes(key, {
        maxBytes: rawReadLimit(options),
      });
      return { kind: 'hit', raw: Buffer.from(bytes), rel };
    } catch (error) {
      if (isStorageError(error) && error.code === StorageErrorCode.NOT_FOUND) {
        return { kind: 'miss' };
      }
      // A read limit is the caller's own bound, not a backend condition: it must surface as
      // itself rather than as a miss the index.html rewrite would paper over.
      if (
        isStorageError(error) &&
        error.code === StorageErrorCode.LIMIT_EXCEEDED
      ) {
        throw new ArtifactReadLimitError(requirePlainReadLimit(options));
      }
      return { kind: 'error', error };
    }
  }

  async readWithInfo(
    artifactId: string,
    relPath: string,
    ref: ReadRef,
    options?: ArtifactReadOptions,
  ): Promise<StoredObject | null> {
    this.assertArtifactId(artifactId);
    const normalized = normalizeRelativePath(relPath)
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+|\/+$/g, '');
    const rel = normalized === '' ? 'index.html' : normalized;
    if (isUnsafeRelativePath(rel)) return null;

    // A directory-shaped request ("" or "docs") serves that directory's index.html. Providers
    // disagree on how a directory key fails — an object store has no such key at all, while the
    // filesystem reports reading a directory as its own error — so the rewrite is driven by the
    // miss, not by probing the backend. The AAD binds to the path actually read, never to the
    // one requested (ADR D6.1).
    // A filesystem HEAD cannot distinguish a file from a directory candidate. Skip that one
    // preflight so a directory inode size cannot trigger the caller's plaintext limit before we
    // try its bounded `index.html`; downloadBytes still enforces the raw-byte ceiling.
    const direct = await this.fetchRaw(
      artifactId,
      rel,
      options,
      !this.filesystemLayout,
    );
    if (direct.kind === 'error' && !this.filesystemLayout) {
      throw direct.error;
    }
    let resolved = direct;
    if (resolved.kind !== 'hit') {
      const fallback = await this.fetchRaw(
        artifactId,
        `${rel}/index.html`,
        options,
      );
      if (fallback.kind === 'error') throw fallback.error;
      if (fallback.kind === 'miss') {
        if (direct.kind === 'error') throw direct.error;
        return null;
      }
      resolved = fallback;
    }

    const out = await open(
      resolved.raw,
      artifactCtx(artifactId, resolved.rel, ref),
      this.crypto.keyProvider,
      this.crypto.allowLegacyPlaintext === undefined
        ? {}
        : { allowLegacyPlaintext: this.crypto.allowLegacyPlaintext },
    );
    enforcePlainReadLimit(out.plain, options);
    if (out.legacy) warnLegacyRead('storage', `${artifactId}/${resolved.rel}`);
    return {
      plain: out.plain,
      ...(out.contentType === undefined
        ? {}
        : { contentType: out.contentType }),
    };
  }

  async deleteFiles(artifactId: string, relPaths: string[]): Promise<void> {
    this.assertArtifactId(artifactId);
    for (const relPath of relPaths) {
      const name = normalizeRelativePath(relPath);
      // containment at the key level: reject absolute/empty paths and traversal segments.
      if (isUnsafeRelativePath(name)) {
        continue;
      }
      await this.client.delete(`${artifactId}/${name}`);
    }
  }

  /** The single s3 write primitive; enveloped objects are opaque octet streams to the bucket. */
  private async put(
    artifactId: string,
    relPath: string,
    body: Buffer,
    ref: ScopeRef,
    contentType: string,
  ): Promise<void> {
    this.assertArtifactId(artifactId);
    const sealed = await seal(
      body,
      artifactCtx(artifactId, relPath, ref),
      this.crypto.keyProvider,
      contentType,
    );
    await this.client.upload(`${artifactId}/${relPath}`, sealed, {
      // The real content type is authenticated inside CAE1 and must not leak through S3 metadata.
      contentType: 'application/octet-stream',
    });
  }
}

function requirePlainReadLimit(
  options: ArtifactReadOptions | undefined,
): number {
  const limit = options?.maxPlainBytes;
  if (limit === undefined || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('maxPlainBytes must be a non-negative safe integer');
  }
  return limit;
}

function rawReadLimit(options: ArtifactReadOptions | undefined): number {
  if (options?.maxPlainBytes === undefined) return Infinity;
  return requirePlainReadLimit(options) + ENVELOPE_MAX_OVERHEAD_BYTES;
}

async function preflightRawRead(
  client: StorageClient,
  key: string,
  options: ArtifactReadOptions | undefined,
): Promise<boolean> {
  if (options?.maxPlainBytes === undefined) return true;
  try {
    const metadata = await client.head(key);
    if (metadata.size > rawReadLimit(options)) {
      throw new ArtifactReadLimitError(requirePlainReadLimit(options));
    }
    return true;
  } catch (error) {
    if (isStorageError(error) && error.code === StorageErrorCode.NOT_FOUND)
      return false;
    throw error;
  }
}

function enforcePlainReadLimit(
  plain: Buffer,
  options: ArtifactReadOptions | undefined,
): void {
  if (options?.maxPlainBytes === undefined) return;
  const limit = requirePlainReadLimit(options);
  if (plain.length > limit) throw new ArtifactReadLimitError(limit);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** content-type for an artifact file path, falling back to octet-stream. */
export function contentTypeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

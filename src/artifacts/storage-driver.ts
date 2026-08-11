import { StorageClient, type StorageDriver } from '../core/index.js';
import {
  createProviderStorageDriver,
  isStorageProvider,
  listStorageProviders,
  type StorageProviderConfig,
  type StorageProviderName,
} from '../files-sdk/provider/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ARTIFACT_STORAGE_CLIENT_NAME = 'artifacts';
export const OBJECT_STORAGE_CLIENT_NAME = 'objects';
export const DEFAULT_OBJECT_NAMESPACES = ['_staging', 'org-logos'] as const;

/**
 * Where the generic object store lives relative to the artifact store on a filesystem. Artifact
 * keys are `<artifactId>/<path>`, so an unprefixed object key like `org-logos/x.png` would read
 * back as an artifact directory named `org-logos` — listing, sweeping, and removal would all
 * cross the two. Filesystems therefore retain the historical `_objects` directory. Object-store
 * providers retain their historical unprefixed keys; the configured top-level namespace
 * allowlist keeps those keys disjoint from artifact ids without a rolling-deploy layout change.
 */
export const OBJECT_STORE_PREFIX = '_objects';

/**
 * Which store backs artifacts, and how to reach it. `provider` is any slug `@nestm/storage`
 * can build — `fs`, `s3`, `gcs`, `azure`, `r2`, `minio`, `supabase`, and ~40 more — so a
 * deployment picks its store from the environment instead of the platform shipping a driver
 * per backend. Only the selected provider's SDK is ever imported.
 */
export interface ArtifactStorageConfig {
  provider: StorageProviderName;
  /** Key prefix so artifacts can share a bucket (or a directory tree) with other apps. */
  prefix?: string;
  /**
   * Flat provider settings: `bucket`/`region`/`endpoint` for an object store, `root` for the
   * filesystem, `accountName`/`container` for Azure. Each provider reads what it needs.
   * Credentials may be omitted wherever the provider's SDK resolves its own chain — on AWS that
   * is the ECS task role, so S3 needs no long-lived keys in env.
   */
  config?: StorageProviderConfig;
  /**
   * Allowed top-level ObjectStore namespaces. Artifact ids matching one of these values are
   * rejected, keeping the two public facades disjoint on providers where they share a key root.
   */
  objectNamespaces?: readonly string[];
}

/** Default filesystem root, shared by the api and the sandbox so zero-config dev lines up. */
export function defaultFsRoot(): string {
  return join(tmpdir(), 'concepta-artifacts-artifacts');
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '');
}

/** Resolve and validate the case-insensitive top-level ObjectStore namespace allowlist. */
export function resolveObjectNamespaces(
  namespaces: readonly string[] = DEFAULT_OBJECT_NAMESPACES,
): ReadonlySet<string> {
  const resolved = new Set<string>();
  for (const namespace of namespaces) {
    const normalized = namespace.toLowerCase();
    if (
      namespace === '' ||
      namespace === '.' ||
      namespace === '..' ||
      namespace.includes('/') ||
      namespace.includes('\\') ||
      namespace.includes('\0') ||
      Buffer.byteLength(namespace, 'utf8') > 255 ||
      normalized === OBJECT_STORE_PREFIX ||
      resolved.has(normalized)
    ) {
      throw new Error(
        `invalid or duplicate object namespace: ${JSON.stringify(namespace)}`,
      );
    }
    resolved.add(normalized);
  }
  if (resolved.size === 0) {
    throw new Error('at least one object namespace is required');
  }
  return resolved;
}

function joinPrefix(...parts: Array<string | undefined>): string | undefined {
  const joined = parts
    .flatMap((part) => (part === undefined ? [] : [trimSlashes(part)]))
    .filter((part) => part.length > 0)
    .join('/');
  return joined.length === 0 ? undefined : joined;
}

/** Fail fast on an unknown slug with the full list, rather than at the first upload. */
export function assertStorageProvider(provider: string): StorageProviderName {
  if (!isStorageProvider(provider)) {
    const known = listStorageProviders()
      .map((candidate) => candidate.slug)
      .join(', ');
    throw new Error(
      `Unknown storage provider ${JSON.stringify(provider)}. Known providers: ${known}`,
    );
  }
  return provider;
}

function providerConfig(cfg: ArtifactStorageConfig): StorageProviderConfig {
  if (cfg.provider !== 'fs') return cfg.config ?? {};
  // The filesystem adapter needs a root; every other provider names its store some other way.
  return { root: defaultFsRoot(), ...cfg.config };
}

function driver(
  cfg: ArtifactStorageConfig,
  prefix: string | undefined,
): Promise<StorageDriver> {
  return createProviderStorageDriver({
    provider: cfg.provider,
    config: providerConfig(cfg),
    ...(prefix === undefined ? {} : { prefix }),
  });
}

export function createArtifactStorageDriver(
  cfg: ArtifactStorageConfig,
): Promise<StorageDriver> {
  return driver(cfg, joinPrefix(cfg.prefix));
}

export function createObjectStorageDriver(
  cfg: ArtifactStorageConfig,
): Promise<StorageDriver> {
  return driver(
    cfg,
    joinPrefix(cfg.prefix, cfg.provider === 'fs' ? OBJECT_STORE_PREFIX : ''),
  );
}

export async function createArtifactStorageClient(
  cfg: ArtifactStorageConfig,
): Promise<StorageClient> {
  return new StorageClient(
    ARTIFACT_STORAGE_CLIENT_NAME,
    await createArtifactStorageDriver(cfg),
  );
}

export async function createObjectStorageClient(
  cfg: ArtifactStorageConfig,
): Promise<StorageClient> {
  return new StorageClient(
    OBJECT_STORAGE_CLIENT_NAME,
    await createObjectStorageDriver(cfg),
  );
}

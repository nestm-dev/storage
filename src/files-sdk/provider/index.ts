import type { Adapter } from 'files-sdk';
import { loadFiles, type LoadFilesOptions } from 'files-sdk/loader';
import {
  PROVIDER_NAMES,
  getProvider,
  getSecretEnvVars,
  listEnvVars,
  type EnvVar,
  type Provider,
  type ProviderSlug,
} from 'files-sdk/providers';

import { StorageError, StorageErrorCode } from '../../storage.error.js';
import {
  createFilesSdkDriver,
  mapFilesSdkError,
  type FilesSdkDriverOptions,
  type FilesSdkStorageDriver,
} from '../files-sdk.driver.js';

/** Slug of a storage provider this package can build a driver for. */
export type StorageProviderName = ProviderSlug;

/**
 * Flat, provider-specific settings — `bucket` and `region` for an object store,
 * `root` for the filesystem, `accountName` and `container` for Azure, and so
 * on. Every provider reads what it needs and ignores the rest, so one config
 * shape serves a deployment that switches providers by name.
 *
 * Credentials may be omitted for any provider whose SDK resolves its own chain
 * (an IAM role, Application Default Credentials, a shared profile).
 */
export type StorageProviderConfig = Omit<LoadFilesOptions, 'provider'>;

export interface ProviderStorageDriverOptions extends Omit<
  FilesSdkDriverOptions<Adapter>,
  'adapter'
> {
  /** Which provider to build. Validate untrusted input with {@link isStorageProvider}. */
  provider: StorageProviderName;
  config?: StorageProviderConfig;
}

/**
 * Builds a {@link FilesSdkStorageDriver} for a provider named at runtime,
 * importing that provider's adapter — and only that one — on demand. A
 * deployment selects its store with a string (`'s3'`, `'gcs'`, `'azure'`,
 * `'r2'`, `'fs'`, …) and installs one native SDK, instead of the application
 * hard-coding a driver per backend.
 *
 * The `s3` slug additionally gets the conditional-promotion and signed-policy
 * capabilities {@link createS3StorageDriver} attaches; every other provider
 * exposes exactly what its adapter declares. Import
 * `@nestm/storage/files-sdk/s3` directly when the provider is known at build
 * time and the extra indirection buys nothing.
 *
 * @throws StorageError `INVALID_ARGUMENT` for an unknown slug, and whatever the
 * adapter reports (mapped) when required config or credentials are missing.
 */
export async function createProviderStorageDriver(
  options: ProviderStorageDriverOptions,
): Promise<FilesSdkStorageDriver> {
  const { provider, config, ...filesOptions } = options;
  if (!isStorageProvider(provider)) {
    throw unknownProvider(provider);
  }

  // `loadFiles` owns the slug → adapter mapping and keeps the import lazy; the
  // client it returns is discarded so the caller's own driver options (prefix,
  // hooks, plugins, readonly, retries) apply to the instance the bridge builds.
  const adapter = await resolveAdapter(provider, config);
  return createFilesSdkDriver({ ...filesOptions, adapter });
}

async function resolveAdapter(
  provider: StorageProviderName,
  config: StorageProviderConfig | undefined,
): Promise<Adapter> {
  let resolved;
  try {
    resolved = await loadFiles({ ...config, provider });
  } catch (error) {
    throw mapFilesSdkError(error);
  }
  const { adapter } = resolved.files;
  if (provider === 'fs') {
    const { withFsConditionalMutation } = await import('../fs/index.js');
    return withFsConditionalMutation(
      adapter as Parameters<typeof withFsConditionalMutation>[0],
    );
  }
  if (provider !== 's3') {
    return adapter;
  }
  // Built by `s3(...)`, so its `raw` is an S3Client and the promotion path
  // holds. The S3-compatible wrappers keep only what they declare themselves.
  const { withS3Capabilities } = await import('../s3/index.js');
  return withS3Capabilities(
    adapter as Parameters<typeof withS3Capabilities>[0],
    {
      ...(typeof config?.endpoint === 'string' && {
        endpoint: config.endpoint,
      }),
      ...(config?.publicBaseUrl !== undefined && {
        publicBaseUrl: config.publicBaseUrl,
      }),
    },
  );
}

function unknownProvider(provider: string): StorageError {
  return new StorageError(
    `Unknown storage provider: ${JSON.stringify(provider)}. Known providers: ${PROVIDER_NAMES.join(', ')}.`,
    { code: StorageErrorCode.INVALID_ARGUMENT, permanent: true },
  );
}

/** Narrows an untrusted string — an env var, a config file — to a known slug. */
export function isStorageProvider(value: string): value is StorageProviderName {
  return getProvider(value) !== undefined;
}

/** Every provider that can be named, sorted by slug. */
export function listStorageProviders(): readonly Provider[] {
  return PROVIDER_NAMES.flatMap((slug) => getProvider(slug) ?? []);
}

/** One provider's display name, description, native SDKs, and env contract. */
export function getStorageProvider(slug: string): Provider | undefined {
  return getProvider(slug);
}

/**
 * Every environment variable a provider reads, flattened across required, all
 * credential modes, and optional. Useful for validating a deployment's config
 * before the first upload rather than at it.
 */
export function listStorageProviderEnvVars(slug: string): EnvVar[] {
  return listEnvVars(slug);
}

/** The subset of {@link listStorageProviderEnvVars} that carries secrets. */
export function listStorageProviderSecretEnvVars(slug: string): EnvVar[] {
  return getSecretEnvVars(slug);
}

export type {
  EnvVar as StorageProviderEnvVar,
  Provider as StorageProviderInfo,
} from 'files-sdk/providers';

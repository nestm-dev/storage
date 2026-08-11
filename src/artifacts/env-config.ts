import type { StorageProviderConfig } from '../files-sdk/provider/index.js';

import {
  assertStorageProvider,
  defaultFsRoot,
  type ArtifactStorageConfig,
} from './storage-driver.js';

/**
 * Shared env→storage-config validation for every service that constructs storage (the api's
 * zod-validated env delegates here with normalized values; the sandbox passes process.env
 * directly). One source of truth for the rules — the two services once drifted by
 * re-implementing them independently.
 *
 * `STORAGE_PROVIDER` names any provider `@nestm/storage` can build (`fs`, `s3`, `gcs`, `azure`,
 * `r2`, `minio`, `supabase`, …); the `STORAGE_*` values below are one flat bag that each provider
 * reads what it needs from. The platform is not S3-only: it used to be, because storage shipped
 * exactly two hand-written drivers, and the old `ARTIFACT_STORAGE=fs|s3` switch chose between
 * them. Those names are still accepted so a deployment can migrate without a coordinated restart.
 */
export function artifactStorageConfigFromEnv(
  env: NodeJS.ProcessEnv,
): ArtifactStorageConfig {
  const provider = assertStorageProvider(
    env.STORAGE_PROVIDER || legacyProvider(env) || 'fs',
  );
  const prefix = env.STORAGE_PREFIX || env.S3_PREFIX || undefined;
  const config = flatConfig(env);

  // Both-or-neither: both set → static credentials (an IAM user, or any S3-compatible store);
  // both unset → the provider SDK's own chain (the ECS task role, Application Default
  // Credentials, a shared profile) so no long-lived keys sit in env.
  if (!config.accessKeyId !== !config.secretAccessKey) {
    throw new Error(
      "STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together (omit both to use the provider's default credential chain)",
    );
  }

  if (provider === 'fs') {
    return {
      provider,
      ...(prefix ? { prefix } : {}),
      config: { root: config.root ?? defaultFsRoot() },
    };
  }

  // `root` is filesystem-only, and the api's schema always defaults one. Carrying it onto an
  // object-store provider would both litter the config and make the guard below think a bucketless
  // deployment was configured.
  const { root: _fsOnly, ...objectStoreConfig } = config;

  // Generic "you configured nothing" guard. Which field a provider actually needs is the
  // adapter's business — it fails closed on its own — but an empty config is always a
  // deployment mistake, and catching it here names the variable to set.
  if (!identifiesAStore(objectStoreConfig)) {
    throw new Error(
      `STORAGE_PROVIDER=${provider} needs somewhere to write: set STORAGE_BUCKET (or the container/store field that provider uses)`,
    );
  }

  return { provider, ...(prefix ? { prefix } : {}), config: objectStoreConfig };
}

/** The retired `ARTIFACT_STORAGE=fs|s3` switch, mapped onto a provider slug. */
function legacyProvider(env: NodeJS.ProcessEnv): string | undefined {
  return env.ARTIFACT_STORAGE || undefined;
}

function identifiesAStore(config: StorageProviderConfig): boolean {
  return [
    config.bucket,
    config.container,
    config.connectionString,
    config.storeName,
    config.token,
    config.url,
  ].some((value) => typeof value === 'string' && value.length > 0);
}

/**
 * One flat bag of provider settings, assembled from `STORAGE_*` with the retired `S3_*` and
 * `ARTIFACTS_DIR` names as fallbacks. Absent values are omitted rather than set to `undefined`,
 * so a provider's own credential chain stays reachable.
 */
function flatConfig(env: NodeJS.ProcessEnv): StorageProviderConfig {
  const entries: Array<[string, string | boolean | undefined]> = [
    ['accessKeyId', env.STORAGE_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID],
    ['accountId', env.STORAGE_ACCOUNT_ID],
    ['accountKey', env.STORAGE_ACCOUNT_KEY],
    ['accountName', env.STORAGE_ACCOUNT_NAME],
    ['bucket', env.STORAGE_BUCKET || env.S3_BUCKET],
    ['connectionString', env.STORAGE_CONNECTION_STRING],
    ['container', env.STORAGE_CONTAINER],
    ['endpoint', env.STORAGE_ENDPOINT || env.S3_ENDPOINT],
    ['keyFilename', env.STORAGE_KEY_FILENAME],
    ['projectId', env.STORAGE_PROJECT_ID],
    ['publicBaseUrl', env.STORAGE_PUBLIC_BASE_URL],
    ['region', env.STORAGE_REGION || env.S3_REGION],
    ['root', env.STORAGE_ROOT || env.ARTIFACTS_DIR],
    [
      'secretAccessKey',
      env.STORAGE_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY,
    ],
    ['serviceRoleKey', env.STORAGE_SERVICE_ROLE_KEY],
    ['sessionToken', env.STORAGE_SESSION_TOKEN],
    ['siteId', env.STORAGE_SITE_ID],
    ['storeName', env.STORAGE_STORE_NAME],
    ['token', env.STORAGE_TOKEN],
    ['url', env.STORAGE_URL],
  ];

  const forcePathStyle =
    env.STORAGE_FORCE_PATH_STYLE || env.S3_FORCE_PATH_STYLE;
  if (forcePathStyle)
    entries.push(['forcePathStyle', forcePathStyle === 'true']);

  // One dynamic bag by design: the fields are provider-specific and the union is wider than any
  // one deployment uses, so it is assembled by name rather than spelled out per provider.
  return Object.fromEntries(
    entries.flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : [[key, value]],
    ),
  ) as StorageProviderConfig;
}

import { CachingKeyProvider, type DekCacheOptions } from './dek-cache.js';
import {
  keyProviderConfigFromEnv,
  type KeyProvider,
  type KeyProviderConfig,
} from './key-provider.js';
import { KmsKeyProvider } from './kms-provider.js';
import { LocalKeyProvider } from './local-provider.js';

export {
  artifactScope,
  canonicalJson,
  orgScope,
  SCOPE_FROM_HEADER,
  uploadScope,
  type EnvelopeContext,
  type ExpectedContext,
} from './context.js';
export {
  ENVELOPE_SUPPORTED_VERSIONS,
  ENVELOPE_WRITE_VERSION,
  ENVELOPE_MAX_OVERHEAD_BYTES,
  EnvelopeError,
  isEnvelope,
  open,
  seal,
  type EnvelopeFailureReason,
  type OpenOptions,
  type OpenResult,
} from './codec.js';
export { CachingKeyProvider, type DekCacheOptions } from './dek-cache.js';
export {
  KEK_GENERATE_HINT,
  keyProviderConfigFromEnv,
  type DataKey,
  type KeyProvider,
  type KeyProviderConfig,
} from './key-provider.js';
export { KmsKeyProvider } from './kms-provider.js';
export { LocalKeyProvider } from './local-provider.js';

/** Everything a storage backend needs to encrypt/decrypt. Required — there is no plaintext mode. */
export interface StorageCrypto {
  keyProvider: KeyProvider;
  /** SEC-04's migration-window flag; see OpenOptions.allowLegacyPlaintext. Default off. */
  allowLegacyPlaintext?: boolean;
}

/** Build the configured provider wrapped in the process-wide DEK cache (ADR-0001 D6.2). */
export function createKeyProvider(
  cfg: KeyProviderConfig,
  opts?: { cache?: DekCacheOptions },
): KeyProvider {
  const inner =
    cfg.kind === 'kms'
      ? new KmsKeyProvider(cfg.keyId, cfg.region)
      : new LocalKeyProvider(cfg.name, cfg.kek);
  return new CachingKeyProvider(inner, opts?.cache);
}

/**
 * One-call env→crypto resolution shared by the api and the sandbox (each constructs storage from
 * env separately; this keeps their validation identical). Throws on misconfiguration — callers
 * fail boot, following the SEC-00 gating pattern.
 */
export function storageCryptoFromEnv(env: NodeJS.ProcessEnv): StorageCrypto {
  return {
    keyProvider: createKeyProvider(keyProviderConfigFromEnv(env)),
    allowLegacyPlaintext: env.ARTIFACT_ENCRYPTION_READ_LEGACY === 'true',
  };
}

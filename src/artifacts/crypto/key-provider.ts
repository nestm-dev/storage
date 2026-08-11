import type { EnvelopeContext } from './context.js';

/** A fresh per-object data key: the plaintext DEK plus its wrapped form and the wrapping key id. */
export interface DataKey {
  /** 32-byte AES-256 key. Callers own this buffer and must zero it after use. */
  dek: Buffer;
  /** The DEK wrapped by the provider's KEK/CMK; safe to persist in the envelope header. */
  wdk: Buffer;
  /** Wrapping key identifier (`local:<name>` or the KMS key ARN). */
  kid: string;
}

/**
 * Pluggable wrap/unwrap of per-object DEKs (ADR-0001 D4). Both operations take the full
 * EnvelopeContext and MUST bind it to the wrap (KMS EncryptionContext / local wrap-AAD): that
 * binding is what makes the sandbox's header-sourced `scope` trustworthy — see SCOPE_FROM_HEADER.
 * There is deliberately no `none` implementation; unenveloped writes must not exist.
 */
export interface KeyProvider {
  generateDataKey(ctx: EnvelopeContext): Promise<DataKey>;
  /**
   * Unwrap a stored DEK. Must reject a `kid` that does not belong to this provider's configured
   * key — a hostile header can never select the decrypting key. Returns a caller-owned copy.
   */
  unwrapDataKey(
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
  ): Promise<Buffer>;
  /** Drop and zero any cached key material (shutdown hook). */
  clear(): void;
}

export type KeyProviderConfig =
  | { kind: 'local'; name: string; kek: Buffer }
  | { kind: 'kms'; keyId: string; region?: string };

/** One-liner shown wherever a missing/invalid KEK aborts boot. */
export const KEK_GENERATE_HINT =
  "generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\"";

/**
 * Shared env→config validation for the api and the sandbox (both construct storage from env
 * separately; this is the single source of truth, same role as the S3 both-or-neither rule).
 * Throws on any misconfiguration — boot must fail, never degrade to plaintext (ADR D4).
 */
export function keyProviderConfigFromEnv(
  env: NodeJS.ProcessEnv,
): KeyProviderConfig {
  const provider = env.ARTIFACT_KEY_PROVIDER;
  if (provider === 'local') {
    if (!env.ARTIFACT_KEK) {
      throw new Error(
        `ARTIFACT_KEY_PROVIDER=local requires ARTIFACT_KEK (base64, 32 bytes); ${KEK_GENERATE_HINT}`,
      );
    }
    const kek = Buffer.from(env.ARTIFACT_KEK, 'base64');
    // Round-trip the decode: Buffer.from(_, "base64") silently tolerates garbage.
    if (
      kek.length !== 32 ||
      kek.toString('base64').replace(/=+$/, '') !==
        env.ARTIFACT_KEK.replace(/=+$/, '')
    ) {
      throw new Error(
        `ARTIFACT_KEK must be exactly 32 random bytes, base64-encoded; ${KEK_GENERATE_HINT}`,
      );
    }
    return { kind: 'local', name: env.ARTIFACT_KEK_NAME || 'default', kek };
  }
  if (provider === 'kms') {
    if (!env.ARTIFACT_KMS_KEY_ID) {
      throw new Error(
        'ARTIFACT_KEY_PROVIDER=kms requires ARTIFACT_KMS_KEY_ID (KMS key id, ARN, or alias)',
      );
    }
    const region = env.ARTIFACT_KMS_REGION || env.S3_REGION;
    return {
      kind: 'kms',
      keyId: env.ARTIFACT_KMS_KEY_ID,
      ...(region === undefined ? {} : { region }),
    };
  }
  throw new Error(
    'ARTIFACT_KEY_PROVIDER must be "local" or "kms" — artifact storage is always encrypted and has no plaintext mode (ADR-0001)',
  );
}

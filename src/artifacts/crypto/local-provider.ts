import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { canonicalJson, type EnvelopeContext } from './context.js';
import type { DataKey, KeyProvider } from './key-provider.js';

// wdk layout: 12-byte IV ‖ 16-byte GCM tag ‖ 32-byte wrapped DEK.
const IV_LEN = 12;
const TAG_LEN = 16;
const DEK_LEN = 32;

/**
 * Static-KEK provider for dev, CI, and self-hosted fs deployments (ADR-0001 D4). The wrap is
 * AES-256-GCM with the canonical context as AAD, so a wdk replayed under a different
 * scope/artifact/path fails to unwrap — the same property KMS EncryptionContext gives the `kms`
 * provider, and the property the sandbox's header-sourced scope relies on.
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly kid: string;

  constructor(
    name: string,
    private readonly kek: Buffer,
  ) {
    if (kek.length !== 32)
      throw new Error('local KEK must be exactly 32 bytes');
    this.kid = `local:${name}`;
  }

  generateDataKey(ctx: EnvelopeContext): Promise<DataKey> {
    const dek = randomBytes(DEK_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(Buffer.from(canonicalJson(ctx)));
    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
    const wdk = Buffer.concat([iv, cipher.getAuthTag(), wrapped]);
    return Promise.resolve({ dek, wdk, kid: this.kid });
  }

  unwrapDataKey(
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
  ): Promise<Buffer> {
    // A hostile header must never select the key: only our own kid is accepted.
    if (kid !== this.kid) {
      return Promise.reject(
        new Error(`unknown key id "${kid}" (configured: "${this.kid}")`),
      );
    }
    if (wdk.length !== IV_LEN + TAG_LEN + DEK_LEN) {
      return Promise.reject(new Error('malformed wrapped data key'));
    }
    const iv = wdk.subarray(0, IV_LEN);
    const tag = wdk.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const wrapped = wdk.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAAD(Buffer.from(canonicalJson(ctx)));
    decipher.setAuthTag(tag);
    try {
      return Promise.resolve(
        Buffer.concat([decipher.update(wrapped), decipher.final()]),
      );
    } catch {
      // GCM cannot distinguish wrong-context from corruption; both are "this key is not
      // available for this context" — fail closed without detail.
      return Promise.reject(
        new Error('wrapped data key failed to unwrap for this context'),
      );
    }
  }

  clear(): void {
    // Stateless: the KEK itself must outlive clear() (it is the provider's configuration).
  }
}

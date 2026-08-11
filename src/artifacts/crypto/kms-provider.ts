import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';

import type { EnvelopeContext } from './context.js';
import type { DataKey, KeyProvider } from './key-provider.js';

/**
 * KMS EncryptionContext for the wrap (ADR-0001 D3): `{scope, artifactId}` — so CloudTrail
 * records which tenant's which artifact every decrypt serves, and a wrapped DEK cannot be
 * unwrapped under a different claimed context. KMS context values must be strings, so a null
 * artifactId (ObjectStore objects) is omitted rather than stringified.
 */
function encryptionContext(ctx: EnvelopeContext): Record<string, string> {
  return ctx.artifactId === null
    ? { scope: ctx.scope }
    : { scope: ctx.scope, artifactId: ctx.artifactId };
}

function equivalentKmsKeyId(headerKid: string, resolvedKeyId: string): boolean {
  if (headerKid === resolvedKeyId) return true;

  // Multi-Region replicas share the same `mrk-…` resource id but have region-specific ARNs.
  // Treat those replicas as one logical CMK only when partition and account also match.
  const parseMrk = (value: string): [string, string, string] | null => {
    const match =
      /^arn:([^:]+):kms:[^:]+:([^:]+):key\/(mrk-[A-Za-z0-9-]+)$/.exec(value);
    return match === null ? null : [match[1]!, match[2]!, match[3]!];
  };
  const header = parseMrk(headerKid);
  const resolved = parseMrk(resolvedKeyId);
  return (
    header !== null &&
    resolved !== null &&
    header.every((part, index) => part === resolved[index])
  );
}

/**
 * AWS KMS provider for deployed environments (ADR-0001 D4). Uses the SDK default credential
 * chain (ECS task role), like the S3 backend. Requires SEC-02's CMK and task-role grants:
 * api — GenerateDataKey/Decrypt/ReEncrypt*; sandbox — Decrypt only.
 */
export class KmsKeyProvider implements KeyProvider {
  private readonly client: KMSClient;

  constructor(
    private readonly keyId: string,
    region?: string,
  ) {
    this.client = new KMSClient(region ? { region } : {});
  }

  async generateDataKey(ctx: EnvelopeContext): Promise<DataKey> {
    const out = await this.client.send(
      new GenerateDataKeyCommand({
        KeyId: this.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: encryptionContext(ctx),
      }),
    );
    if (!out.Plaintext || !out.CiphertextBlob || !out.KeyId) {
      out.Plaintext?.fill(0);
      throw new Error('KMS GenerateDataKey returned an incomplete response');
    }
    // kid is the resolved key ARN (not the configured alias) so envelopes are self-describing
    // for SEC-04's rewrap tooling.
    try {
      return {
        dek: Buffer.from(out.Plaintext),
        wdk: Buffer.from(out.CiphertextBlob),
        kid: out.KeyId,
      };
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async unwrapDataKey(
    wdk: Buffer,
    kid: string,
    ctx: EnvelopeContext,
  ): Promise<Buffer> {
    // The header kid is attacker-influenced and is deliberately NOT passed to KMS: Decrypt is
    // pinned to the configured key, so KMS itself rejects ciphertext wrapped under any other key
    // (a stricter guarantee than string-comparing kid, which may be an alias vs the ARN).
    const out = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: wdk,
        EncryptionContext: encryptionContext(ctx),
      }),
    );
    if (!out.Plaintext || !out.KeyId) {
      out.Plaintext?.fill(0);
      throw new Error('KMS Decrypt returned an incomplete response');
    }
    try {
      if (!equivalentKmsKeyId(kid, out.KeyId)) {
        throw new Error(
          'KMS Decrypt resolved a key that does not match the envelope',
        );
      }
      return Buffer.from(out.Plaintext);
    } finally {
      out.Plaintext.fill(0);
    }
  }

  clear(): void {
    this.client.destroy();
  }
}

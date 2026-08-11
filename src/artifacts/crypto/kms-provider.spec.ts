import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { type EnvelopeContext } from './context.js';
import { KmsKeyProvider } from './kms-provider.js';

const CTX: EnvelopeContext = {
  scope: 'org:o1',
  artifactId: 'a1',
  version: null,
  path: 'index.html',
};
const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/abc';

const kms = mockClient(KMSClient);

afterEach(() => kms.reset());

describe('KmsKeyProvider', () => {
  it('generates under the configured key with the scope+artifactId EncryptionContext', async () => {
    const dek = randomBytes(32);
    const expectedDek = Buffer.from(dek);
    kms.on(GenerateDataKeyCommand).resolves({
      Plaintext: dek,
      CiphertextBlob: randomBytes(60),
      KeyId: KEY_ARN,
    });
    const p = new KmsKeyProvider('alias/concepta-artifacts', 'us-east-1');
    const out = await p.generateDataKey(CTX);
    expect(out.kid).toBe(KEY_ARN);
    expect(out.dek.equals(expectedDek)).toBe(true);
    expect(dek.equals(Buffer.alloc(32))).toBe(true);
    const input = kms.commandCalls(GenerateDataKeyCommand)[0]!.args[0].input;
    expect(input.KeyId).toBe('alias/concepta-artifacts');
    expect(input.KeySpec).toBe('AES_256');
    expect(input.EncryptionContext).toEqual({
      scope: 'org:o1',
      artifactId: 'a1',
    });
  });

  it('omits a null artifactId from the EncryptionContext (KMS values must be strings)', async () => {
    kms.on(GenerateDataKeyCommand).resolves({
      Plaintext: randomBytes(32),
      CiphertextBlob: randomBytes(60),
      KeyId: KEY_ARN,
    });
    const p = new KmsKeyProvider(KEY_ARN);
    await p.generateDataKey({
      scope: 'upload:u1',
      artifactId: null,
      version: null,
      path: '_staging/u1',
    });
    const input = kms.commandCalls(GenerateDataKeyCommand)[0]!.args[0].input;
    expect(input.EncryptionContext).toEqual({ scope: 'upload:u1' });
  });

  it('pins Decrypt to the configured key and verifies the resolved key against kid', async () => {
    const dek = randomBytes(32);
    const expectedDek = Buffer.from(dek);
    kms.on(DecryptCommand).resolves({ Plaintext: dek, KeyId: KEY_ARN });
    const p = new KmsKeyProvider('alias/concepta-artifacts');
    const out = await p.unwrapDataKey(randomBytes(60), KEY_ARN, CTX);
    expect(out.equals(expectedDek)).toBe(true);
    expect(dek.equals(Buffer.alloc(32))).toBe(true);
    const input = kms.commandCalls(DecryptCommand)[0]!.args[0].input;
    // The attacker-influenced header kid must never reach KMS as the key selector.
    expect(input.KeyId).toBe('alias/concepta-artifacts');
    expect(input.EncryptionContext).toEqual({
      scope: 'org:o1',
      artifactId: 'a1',
    });
  });

  it('rejects a tampered header kid after pinned KMS decryption', async () => {
    const dek = randomBytes(32);
    kms.on(DecryptCommand).resolves({
      Plaintext: dek,
      KeyId: KEY_ARN,
    });
    const p = new KmsKeyProvider('alias/concepta-artifacts');
    await expect(
      p.unwrapDataKey(
        randomBytes(60),
        'arn:aws:kms:us-east-1:999:key/attacker',
        CTX,
      ),
    ).rejects.toThrow(/does not match/);
    expect(dek.equals(Buffer.alloc(32))).toBe(true);
  });

  it('accepts the same multi-Region key replica in another region', async () => {
    const east = 'arn:aws:kms:us-east-1:111122223333:key/mrk-shared';
    const west = 'arn:aws:kms:us-west-2:111122223333:key/mrk-shared';
    kms.on(DecryptCommand).resolves({
      Plaintext: randomBytes(32),
      KeyId: west,
    });
    const p = new KmsKeyProvider(west);
    await expect(
      p.unwrapDataKey(randomBytes(60), east, CTX),
    ).resolves.toHaveLength(32);
  });

  it('propagates a KMS failure (wrong context / unavailable key)', async () => {
    kms.on(DecryptCommand).rejects(new Error('InvalidCiphertextException'));
    const p = new KmsKeyProvider(KEY_ARN);
    await expect(
      p.unwrapDataKey(randomBytes(60), KEY_ARN, CTX),
    ).rejects.toThrow();
  });
});

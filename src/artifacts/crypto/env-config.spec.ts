import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { artifactStorageConfigFromEnv } from '../env-config.js';
import { defaultFsRoot } from '../storage-driver.js';
import { storageCryptoFromEnv } from './index.js';
import { keyProviderConfigFromEnv } from './key-provider.js';

const KEK = randomBytes(32).toString('base64');

// These validators are the fail-closed boot gates for BOTH the api and the sandbox — a hole here
// is a service that boots without encryption or with drifting S3 rules.
describe('keyProviderConfigFromEnv', () => {
  it('resolves a valid local provider with the default name', () => {
    const cfg = keyProviderConfigFromEnv({
      ARTIFACT_KEY_PROVIDER: 'local',
      ARTIFACT_KEK: KEK,
    });
    expect(cfg).toMatchObject({ kind: 'local', name: 'default' });
    expect((cfg as { kek: Buffer }).kek.length).toBe(32);
  });

  it('honors ARTIFACT_KEK_NAME', () => {
    const cfg = keyProviderConfigFromEnv({
      ARTIFACT_KEY_PROVIDER: 'local',
      ARTIFACT_KEK: KEK,
      ARTIFACT_KEK_NAME: 'staging-1',
    });
    expect(cfg).toMatchObject({ kind: 'local', name: 'staging-1' });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not base64 32 bytes', 'dG9vLXNob3J0'],
    ['garbage that base64-decodes lossily', '!'.repeat(44)],
  ])('rejects a local provider with a %s KEK', (_name, kek) => {
    expect(() =>
      keyProviderConfigFromEnv({
        ARTIFACT_KEY_PROVIDER: 'local',
        ARTIFACT_KEK: kek,
      }),
    ).toThrow(/ARTIFACT_KEK/);
  });

  it('resolves kms with the explicit region winning over S3_REGION', () => {
    expect(
      keyProviderConfigFromEnv({
        ARTIFACT_KEY_PROVIDER: 'kms',
        ARTIFACT_KMS_KEY_ID: 'alias/a',
        ARTIFACT_KMS_REGION: 'eu-west-1',
        S3_REGION: 'us-east-1',
      }),
    ).toEqual({ kind: 'kms', keyId: 'alias/a', region: 'eu-west-1' });
    expect(
      keyProviderConfigFromEnv({
        ARTIFACT_KEY_PROVIDER: 'kms',
        ARTIFACT_KMS_KEY_ID: 'alias/a',
        S3_REGION: 'us-east-1',
      }),
    ).toEqual({ kind: 'kms', keyId: 'alias/a', region: 'us-east-1' });
    // No region anywhere → undefined, so the KMS client falls to the SDK default chain (parity
    // between api and sandbox — neither may invent a region the other doesn't see).
    expect(
      keyProviderConfigFromEnv({
        ARTIFACT_KEY_PROVIDER: 'kms',
        ARTIFACT_KMS_KEY_ID: 'alias/a',
      }),
    ).toEqual({ kind: 'kms', keyId: 'alias/a', region: undefined });
  });

  it('rejects kms without a key id', () => {
    expect(() =>
      keyProviderConfigFromEnv({ ARTIFACT_KEY_PROVIDER: 'kms' }),
    ).toThrow(/ARTIFACT_KMS_KEY_ID/);
  });

  it.each([[undefined], [''], ['none'], ['plaintext']])(
    'rejects provider %j — there is no plaintext mode',
    (provider) => {
      expect(() =>
        keyProviderConfigFromEnv({ ARTIFACT_KEY_PROVIDER: provider }),
      ).toThrow(/ARTIFACT_KEY_PROVIDER/);
    },
  );
});

describe('storageCryptoFromEnv', () => {
  it('builds a working provider and parses the legacy flag strictly', async () => {
    const on = storageCryptoFromEnv({
      ARTIFACT_KEY_PROVIDER: 'local',
      ARTIFACT_KEK: KEK,
      ARTIFACT_ENCRYPTION_READ_LEGACY: 'true',
    });
    expect(on.allowLegacyPlaintext).toBe(true);
    const ctx = { scope: 'org:o', artifactId: 'a', version: null, path: 'p' };
    const { dek, wdk, kid } = await on.keyProvider.generateDataKey(ctx);
    expect(
      (await on.keyProvider.unwrapDataKey(wdk, kid, ctx)).equals(dek),
    ).toBe(true);

    for (const value of [undefined, '', 'TRUE', '1', 'yes']) {
      const crypto = storageCryptoFromEnv({
        ARTIFACT_KEY_PROVIDER: 'local',
        ARTIFACT_KEK: KEK,
        ARTIFACT_ENCRYPTION_READ_LEGACY: value,
      });
      expect(crypto.allowLegacyPlaintext).toBe(false); // only the literal "true" opens the window
    }
  });
});

describe('artifactStorageConfigFromEnv', () => {
  it('defaults to the filesystem provider with a root', () => {
    expect(artifactStorageConfigFromEnv({})).toEqual({
      provider: 'fs',
      config: { root: defaultFsRoot() },
    });
    expect(artifactStorageConfigFromEnv({ STORAGE_ROOT: '/data' })).toEqual({
      provider: 'fs',
      config: { root: '/data' },
    });
    expect(artifactStorageConfigFromEnv({ STORAGE_ROOT: '' })).toEqual({
      provider: 'fs',
      config: { root: defaultFsRoot() },
    });
  });

  it('still honors the retired ARTIFACT_STORAGE and ARTIFACTS_DIR names', () => {
    expect(artifactStorageConfigFromEnv({ ARTIFACTS_DIR: '/legacy' })).toEqual({
      provider: 'fs',
      config: { root: '/legacy' },
    });
    expect(
      artifactStorageConfigFromEnv({ ARTIFACT_STORAGE: 's3', S3_BUCKET: 'b' }),
    ).toMatchObject({ provider: 's3', config: { bucket: 'b' } });
  });

  it('rejects a provider it cannot build, naming the ones it can', () => {
    expect(() =>
      artifactStorageConfigFromEnv({ STORAGE_PROVIDER: 'dropbox-ish' }),
    ).toThrow(/Unknown storage provider/);
  });

  it('rejects a provider configured with nowhere to write', () => {
    expect(() =>
      artifactStorageConfigFromEnv({ STORAGE_PROVIDER: 's3' }),
    ).toThrow(/needs somewhere to write/);
  });

  it('accepts any provider the module ships, not just s3', () => {
    expect(
      artifactStorageConfigFromEnv({
        STORAGE_PROVIDER: 'gcs',
        STORAGE_BUCKET: 'b',
      }),
    ).toEqual({ provider: 'gcs', config: { bucket: 'b' } });
    expect(
      artifactStorageConfigFromEnv({
        STORAGE_PROVIDER: 'azure',
        STORAGE_CONTAINER: 'c',
        STORAGE_ACCOUNT_NAME: 'acct',
      }),
    ).toEqual({
      provider: 'azure',
      config: { container: 'c', accountName: 'acct' },
    });
  });

  it('enforces both-or-neither credentials', () => {
    const base = { STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'b' };
    expect(() =>
      artifactStorageConfigFromEnv({ ...base, STORAGE_ACCESS_KEY_ID: 'k' }),
    ).toThrow(/set together/);
    expect(() =>
      artifactStorageConfigFromEnv({ ...base, STORAGE_SECRET_ACCESS_KEY: 's' }),
    ).toThrow(/set together/);
    // Neither set: the config carries no credentials at all, so the provider SDK's own chain
    // (the ECS task role) resolves them.
    expect(artifactStorageConfigFromEnv(base).config).toEqual({ bucket: 'b' });
  });

  it('maps the full object-store config', () => {
    expect(
      artifactStorageConfigFromEnv({
        STORAGE_PROVIDER: 's3',
        STORAGE_ENDPOINT: 'https://s3',
        STORAGE_BUCKET: 'b',
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
        STORAGE_REGION: 'eu-west-1',
        STORAGE_PREFIX: 'apps/a',
        STORAGE_FORCE_PATH_STYLE: 'true',
      }),
    ).toEqual({
      provider: 's3',
      prefix: 'apps/a',
      config: {
        endpoint: 'https://s3',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
        region: 'eu-west-1',
        forcePathStyle: true,
      },
    });
  });
});

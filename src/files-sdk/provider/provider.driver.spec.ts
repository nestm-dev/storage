import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StorageClient } from '../../storage.client.js';
import { StorageErrorCode } from '../../storage.error.js';
import {
  createProviderStorageDriver,
  getStorageProvider,
  isStorageProvider,
  listStorageProviderEnvVars,
  listStorageProviderSecretEnvVars,
  listStorageProviders,
} from './index.js';

describe('createProviderStorageDriver', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nestm-storage-provider-'));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('builds a working driver from a provider named at runtime', async () => {
    const client = new StorageClient(
      'artifacts',
      await createProviderStorageDriver({
        config: { root },
        provider: 'fs',
      }),
    );

    await client.upload('index.html', '<html>named</html>');

    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe(
      '<html>named</html>',
    );
  });

  it('applies the caller driver options to the resolved adapter', async () => {
    const client = new StorageClient(
      'artifacts',
      await createProviderStorageDriver({
        config: { root },
        prefix: 'tenant-b',
        provider: 'fs',
      }),
    );

    await client.upload('report.txt', 'scoped');

    expect(readFileSync(join(root, 'tenant-b/report.txt'), 'utf8')).toBe(
      'scoped',
    );
  });

  it('honors a readonly driver regardless of provider', async () => {
    const client = new StorageClient(
      'artifacts',
      await createProviderStorageDriver({
        config: { root },
        provider: 'fs',
        readonly: true,
      }),
    );

    await expect(client.upload('blocked.txt', 'nope')).rejects.toMatchObject({
      code: StorageErrorCode.READ_ONLY,
    });
  });

  it('adds the S3-only capabilities for the s3 slug', async () => {
    const driver = await createProviderStorageDriver({
      config: {
        accessKeyId: 'test',
        bucket: 'artifacts',
        region: 'us-east-1',
        secretAccessKey: 'test',
      },
      provider: 's3',
    });

    expect(driver.capabilities.conditionalCopy).toEqual({
      etag: true,
      supported: true,
      version: true,
    });
    expect(driver.capabilities.signedUploadPolicy).toEqual({
      contentType: true,
      sizeRange: true,
    });
  });

  it('claims no conditional copy for a provider that does not declare it', async () => {
    const driver = await createProviderStorageDriver({
      config: { root },
      provider: 'fs',
    });

    expect(driver.capabilities.conditionalCopy).toBeUndefined();
  });

  it('rejects an unknown slug before importing anything', async () => {
    await expect(
      createProviderStorageDriver({
        provider: 'not-a-provider' as never,
      }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
  });
});

describe('storage provider catalog', () => {
  it('narrows an untrusted string to a known slug', () => {
    expect(isStorageProvider('gcs')).toBe(true);
    expect(isStorageProvider('not-a-provider')).toBe(false);
  });

  it('lists the providers a deployment can choose between', () => {
    const slugs = listStorageProviders().map((provider) => provider.slug);

    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toEqual(expect.arrayContaining(['azure', 'fs', 'gcs', 's3']));
  });

  it('describes the native SDKs a provider needs', () => {
    expect(getStorageProvider('gcs')?.peerDeps).toContain(
      '@google-cloud/storage',
    );
    expect(getStorageProvider('fs')?.peerDeps).toEqual([]);
    expect(getStorageProvider('not-a-provider')).toBeUndefined();
  });

  it('reports the env contract and which of it is secret', () => {
    const keys = listStorageProviderEnvVars('s3').map(
      (variable) => variable.key,
    );
    const secrets = listStorageProviderSecretEnvVars('s3').map(
      (variable) => variable.key,
    );

    expect(keys).toContain('AWS_REGION');
    expect(secrets).toContain('AWS_SECRET_ACCESS_KEY');
    expect(secrets).not.toContain('AWS_REGION');
    expect(secrets.every((key) => keys.includes(key))).toBe(true);
  });
});

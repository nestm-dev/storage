import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { StorageClient } from '../../storage.client.js';
import { getStorageToken } from '../../storage.tokens.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactStorage } from '../artifact-storage.js';
import { LocalKeyProvider } from '../crypto/index.js';
import type { ObjectStore } from '../object-store.js';
import {
  ARTIFACT_STORAGE_CLIENT_NAME,
  OBJECT_STORAGE_CLIENT_NAME,
} from '../storage-driver.js';
import {
  ARTIFACT_STORAGE,
  OBJECT_STORE,
  ArtifactStorageModule,
  type ArtifactStorageModuleOptions,
} from './index.js';

const OPTIONS = Symbol('storage-test-options');

@Module({})
class StorageTestOptionsModule {}

describe('ArtifactStorageModule', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function options(): ArtifactStorageModuleOptions {
    root = mkdtempSync(join(tmpdir(), 'storage-nest-module-'));
    return {
      config: { provider: 'fs', config: { root } },
      crypto: {
        keyProvider: new LocalKeyProvider('nest', Buffer.alloc(32, 7)),
      },
    };
  }

  it('composes product adapters over named @nestm StorageClient providers', async () => {
    const testingModule = await Test.createTestingModule({
      imports: [ArtifactStorageModule.forRoot(options())],
    }).compile();

    const artifactStorage =
      testingModule.get<ArtifactStorage>(ARTIFACT_STORAGE);
    const objectStore = testingModule.get<ObjectStore>(OBJECT_STORE);
    const artifactClient = testingModule.get<StorageClient>(
      getStorageToken(ARTIFACT_STORAGE_CLIENT_NAME),
    );
    const objectClient = testingModule.get<StorageClient>(
      getStorageToken(OBJECT_STORAGE_CLIENT_NAME),
    );

    await artifactStorage.writeHtml(
      'artifact',
      Buffer.from('<html>nest</html>'),
      {
        scope: 'org:nest',
      },
    );
    await objectStore.putObject(
      'org-logos/nest',
      Buffer.from('logo'),
      'image/png',
      {
        scope: 'org:nest',
      },
    );

    expect(
      Buffer.from(await artifactClient.downloadBytes('artifact/index.html'))
        .subarray(0, 4)
        .toString(),
    ).toBe('CAE1');
    expect(
      Buffer.from(await objectClient.downloadBytes('org-logos/nest'))
        .subarray(0, 4)
        .toString(),
    ).toBe('CAE1');
    expect(
      (
        await artifactStorage.read('artifact', 'index.html', {
          scope: 'org:nest',
        })
      )?.toString(),
    ).toBe('<html>nest</html>');

    await testingModule.close();
  });

  it('supports async composition without importing the application config package', async () => {
    const resolved = options();
    const optionsModule = {
      module: StorageTestOptionsModule,
      providers: [{ provide: OPTIONS, useValue: resolved }],
      exports: [OPTIONS],
    };
    const testingModule = await Test.createTestingModule({
      imports: [
        ArtifactStorageModule.forRootAsync({
          imports: [optionsModule],
          inject: [OPTIONS],
          useFactory: (value: ArtifactStorageModuleOptions) => value,
        }),
      ],
    }).compile();

    expect(testingModule.get<ArtifactStorage>(ARTIFACT_STORAGE)).toBeDefined();
    expect(testingModule.get<ObjectStore>(OBJECT_STORE)).toBeDefined();
    await testingModule.close();
  });
});

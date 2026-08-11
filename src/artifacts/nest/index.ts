import {
  Inject,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { StorageClient } from '../../storage.client.js';
import { StorageModule } from '../../storage.module.js';
import { getStorageToken } from '../../storage.tokens.js';

import {
  createArtifactStorageWithClient,
  type ArtifactStorage,
} from '../artifact-storage.js';
import type { StorageCrypto } from '../crypto/index.js';
import {
  createObjectStoreWithClient,
  type ObjectStore,
} from '../object-store.js';
import {
  ARTIFACT_STORAGE_CLIENT_NAME,
  OBJECT_STORAGE_CLIENT_NAME,
  createArtifactStorageDriver,
  createObjectStorageDriver,
  type ArtifactStorageConfig,
} from '../storage-driver.js';

export const ARTIFACT_STORAGE = Symbol.for(
  '@nestm/storage/artifacts/artifact-storage',
);
export const OBJECT_STORE = Symbol.for('@nestm/storage/artifacts/object-store');
export const ARTIFACT_STORAGE_MODULE_OPTIONS = Symbol.for(
  '@nestm/storage/artifacts/module-options',
);

export interface ArtifactStorageModuleOptions {
  config: ArtifactStorageConfig;
  crypto: StorageCrypto;
  /** Makes the product adapters and @nestm/storage clients globally injectable. */
  isGlobal?: boolean;
}

interface ResolvedArtifactStorageModuleOptions {
  config: ArtifactStorageConfig;
  crypto: StorageCrypto;
}

export interface ArtifactStorageModuleAsyncOptions extends Pick<
  ModuleMetadata,
  'imports'
> {
  inject?: FactoryProvider['inject'];
  isGlobal?: boolean;
  useFactory: (
    ...dependencies: never[]
  ) =>
    | ResolvedArtifactStorageModuleOptions
    | Promise<ResolvedArtifactStorageModuleOptions>;
}

export function InjectArtifactStorage(): ParameterDecorator &
  PropertyDecorator {
  return Inject(ARTIFACT_STORAGE);
}

export function InjectObjectStore(): ParameterDecorator & PropertyDecorator {
  return Inject(OBJECT_STORE);
}

@Module({})
class ArtifactStorageOptionsHostModule {}

function syncOptionsHost(
  options: ResolvedArtifactStorageModuleOptions,
): DynamicModule {
  return {
    module: ArtifactStorageOptionsHostModule,
    providers: [
      { provide: ARTIFACT_STORAGE_MODULE_OPTIONS, useValue: options },
    ],
    exports: [ARTIFACT_STORAGE_MODULE_OPTIONS],
  };
}

function asyncOptionsHost(
  options: ArtifactStorageModuleAsyncOptions,
): DynamicModule {
  return {
    module: ArtifactStorageOptionsHostModule,
    imports: options.imports ?? [],
    providers: [
      {
        provide: ARTIFACT_STORAGE_MODULE_OPTIONS,
        inject: options.inject ?? [],
        useFactory: options.useFactory,
      },
    ],
    exports: [ARTIFACT_STORAGE_MODULE_OPTIONS],
  };
}

function domainProviders(): Provider[] {
  return [
    {
      provide: ARTIFACT_STORAGE,
      inject: [
        ARTIFACT_STORAGE_MODULE_OPTIONS,
        getStorageToken(ARTIFACT_STORAGE_CLIENT_NAME),
      ],
      useFactory: (
        options: ResolvedArtifactStorageModuleOptions,
        client: StorageClient,
      ): ArtifactStorage =>
        createArtifactStorageWithClient(options.config, options.crypto, client),
    },
    {
      provide: OBJECT_STORE,
      inject: [
        ARTIFACT_STORAGE_MODULE_OPTIONS,
        getStorageToken(OBJECT_STORAGE_CLIENT_NAME),
      ],
      useFactory: (
        options: ResolvedArtifactStorageModuleOptions,
        client: StorageClient,
      ): ObjectStore =>
        createObjectStoreWithClient(options.config, options.crypto, client),
    },
    ArtifactStorageCryptoShutdown,
  ];
}

class ArtifactStorageCryptoShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(ARTIFACT_STORAGE_MODULE_OPTIONS)
    private readonly options: ResolvedArtifactStorageModuleOptions,
  ) {}

  onApplicationShutdown(): void {
    this.options.crypto.keyProvider.clear();
  }
}

function composeModule(
  optionsHost: DynamicModule,
  isGlobal: boolean,
): DynamicModule {
  const rawStorageModule = StorageModule.forRootAsync({
    imports: [optionsHost],
    default: ARTIFACT_STORAGE_CLIENT_NAME,
    isGlobal,
    stores: [
      {
        name: ARTIFACT_STORAGE_CLIENT_NAME,
        inject: [ARTIFACT_STORAGE_MODULE_OPTIONS],
        useFactory: (options: ResolvedArtifactStorageModuleOptions) =>
          createArtifactStorageDriver(options.config),
      },
      {
        name: OBJECT_STORAGE_CLIENT_NAME,
        inject: [ARTIFACT_STORAGE_MODULE_OPTIONS],
        useFactory: (options: ResolvedArtifactStorageModuleOptions) =>
          createObjectStorageDriver(options.config),
      },
    ],
  });

  return {
    module: ArtifactStorageModule,
    global: isGlobal,
    imports: [optionsHost, rawStorageModule],
    providers: domainProviders(),
    exports: [ARTIFACT_STORAGE, OBJECT_STORE, StorageModule],
  };
}

@Module({})
export class ArtifactStorageModule {
  static forRoot(options: ArtifactStorageModuleOptions): DynamicModule {
    const { config, crypto } = options;
    return composeModule(
      syncOptionsHost({ config, crypto }),
      options.isGlobal === true,
    );
  }

  static forRootAsync(
    options: ArtifactStorageModuleAsyncOptions,
  ): DynamicModule {
    return composeModule(asyncOptionsHost(options), options.isGlobal === true);
  }
}

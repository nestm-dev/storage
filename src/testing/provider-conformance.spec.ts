import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFsStorageDriver } from '../files-sdk/fs/index.js';
import { StorageClient } from '../storage.client.js';
import { StorageError, StorageErrorCode } from '../storage.error.js';
import type { StorageDriver } from '../storage.driver.js';
import type {
  StorageBody,
  StorageCapabilities,
  StoragePromotionOptions,
  StorageUploadOptions,
} from '../storage.types.js';
import {
  createStorageProviderConformanceCases,
  type StorageProviderConformanceFixture,
} from './provider-conformance.js';

const CONDITIONAL_CAPABILITIES = new Set<PropertyKey>([
  'conditionalCreate',
  'conditionalReplace',
  'conditionalDelete',
  'conditionalRead',
  'conditionalCopySource',
  'conditionalCopyDestination',
  'conditionalMultipartCompletion',
]);

describe('createStorageProviderConformanceCases', () => {
  it('generates the full advertised source and destination atomicity cross-product', () => {
    const contracts = createStorageProviderConformanceCases({
      provider: 'full-copy-matrix',
      expected: {
        conditionalCopyDestination: {
          atomicWithSource: true,
          create: true,
          replace: true,
        },
        conditionalCopySource: { etag: true, version: true },
        physicalKey: { maxBytes: 1024 },
      },
      createFixture() {
        throw new Error('case generation must not create a fixture');
      },
    });

    expect(
      contracts
        .map(({ name }) => name)
        .filter((name) => name.startsWith('combines ')),
    ).toEqual([
      'combines etag source and create destination copy predicates atomically',
      'combines etag source and replace destination copy predicates atomically',
      'combines version source and create destination copy predicates atomically',
      'combines version source and replace destination copy predicates atomically',
    ]);
  });

  it('generates the full fail-closed matrix when combined predicates are not atomic', () => {
    const contracts = createStorageProviderConformanceCases({
      provider: 'non-atomic-copy-matrix',
      expected: {
        conditionalCopyDestination: {
          atomicWithSource: false,
          create: true,
          replace: true,
        },
        conditionalCopySource: { etag: true, version: true },
        physicalKey: { maxBytes: 1024 },
      },
      createFixture() {
        throw new Error('case generation must not create a fixture');
      },
    });

    expect(
      contracts
        .map(({ name }) => name)
        .filter((name) => name.startsWith('fails closed for combined ')),
    ).toEqual([
      'fails closed for combined etag source and create destination when copy predicates are not atomic',
      'fails closed for combined etag source and replace destination when copy predicates are not atomic',
      'fails closed for combined version source and create destination when copy predicates are not atomic',
      'fails closed for combined version source and replace destination when copy predicates are not atomic',
    ]);
  });

  it('executes every positive and fail-closed versioned copy combination', async () => {
    const positive = createStorageProviderConformanceCases({
      provider: 'fake-versioned-atomic',
      expected: fullCopyCapabilities(true),
      createFixture: () => createVersionedFixture(true),
    }).filter(({ name }) => name.startsWith('combines '));
    const negative = createStorageProviderConformanceCases({
      provider: 'fake-versioned-non-atomic',
      expected: fullCopyCapabilities(false),
      createFixture: () => createVersionedFixture(false),
    }).filter(({ name }) => name.startsWith('fails closed for combined '));

    expect(positive).toHaveLength(4);
    expect(negative).toHaveLength(4);
    for (const contract of [...positive, ...negative]) {
      await expect(contract.run(), contract.name).resolves.toEqual({
        status: 'passed',
      });
    }
  });

  it('proves that an explicitly restricted provider fails every mutation closed', async () => {
    const contracts = createStorageProviderConformanceCases({
      provider: 'restricted-filesystem',
      expected: { physicalKey: { maxBytes: 4096 } },
      async createFixture() {
        const root = await mkdtemp(
          join(tmpdir(), 'nestm-restricted-conformance-'),
        );
        const driver = withoutConditionalCapabilities(
          createFsStorageDriver({ adapter: { root } }),
        );
        const observed = observeDispatches(driver);
        return {
          client: new StorageClient('restricted-filesystem', observed.driver),
          close: () => rm(root, { force: true, recursive: true }),
          dispatchCount: observed.dispatchCount,
        };
      },
    });

    for (const contract of contracts) {
      await expect(contract.run(), contract.name).resolves.toEqual({
        status: 'passed',
      });
    }
  });
});

function fullCopyCapabilities(atomicWithSource: boolean) {
  return {
    conditionalCopyDestination: {
      atomicWithSource,
      create: true,
      replace: true,
    },
    conditionalCopySource: { etag: true, version: true },
    physicalKey: { maxBytes: 4096 },
  } as const;
}

async function createVersionedFixture(
  atomicWithSource: boolean,
): Promise<StorageProviderConformanceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'nestm-versioned-conformance-'));
  const base = createFsStorageDriver({ adapter: { root } });
  const versions = new Map<string, Map<string, string>>();
  const currentVersions = new Map<string, string>();
  const upload = base.upload.bind(base);
  const promote = base.promote?.bind(base);
  const capabilities: StorageCapabilities = {
    ...base.capabilities,
    conditionalCopyDestination: {
      atomicWithSource,
      create: true,
      replace: true,
    },
    conditionalCopySource: { etag: true, version: true },
  };

  const versioned = new Proxy(base, {
    get(target, property) {
      if (property === 'capabilities') return capabilities;
      if (property === 'upload') {
        return async (
          key: string,
          body: StorageBody,
          options?: StorageUploadOptions,
        ) => {
          if (typeof body !== 'string') {
            throw new TypeError(
              'Fake versioned fixture accepts string bodies.',
            );
          }
          const result = await upload(key, body, options);
          const version = randomUUID();
          const keyVersions = versions.get(key) ?? new Map<string, string>();
          keyVersions.set(version, body);
          versions.set(key, keyVersions);
          currentVersions.set(key, version);
          return result;
        };
      }
      if (property === 'promote') {
        return async (
          sourceKey: string,
          destinationKey: string,
          options: StoragePromotionOptions,
        ): Promise<void> => {
          if (options.sourceVersion === undefined) {
            if (promote === undefined) {
              throw new TypeError('Filesystem promotion is unavailable.');
            }
            return promote(sourceKey, destinationKey, options);
          }
          const body = versions.get(sourceKey)?.get(options.sourceVersion);
          if (body === undefined) {
            throw new StorageError('Fake provider version was not found.', {
              code: StorageErrorCode.NOT_FOUND,
              permanent: true,
            });
          }
          const destination = options.destination;
          if (destination === undefined) {
            throw new StorageError('Destination condition is required.', {
              code: StorageErrorCode.INVALID_ARGUMENT,
              permanent: true,
            });
          }
          if (destination.type === 'create') {
            await base.uploadConditional?.(destinationKey, body, {
              condition: { type: 'create' },
            });
          } else {
            await base.uploadConditional?.(destinationKey, body, {
              condition: { etag: destination.etag, type: 'replace' },
            });
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const observed = observeDispatches(versioned);
  return {
    client: new StorageClient('fake-versioned', observed.driver),
    close: () => rm(root, { force: true, recursive: true }),
    dispatchCount: observed.dispatchCount,
    resolveVersion: async (key) => currentVersions.get(key),
  };
}

function withoutConditionalCapabilities(driver: StorageDriver): StorageDriver {
  const capabilities = Object.fromEntries(
    Object.entries(driver.capabilities).filter(
      ([key]) => !CONDITIONAL_CAPABILITIES.has(key),
    ),
  ) as unknown as StorageCapabilities;

  return new Proxy(driver, {
    get(target, property) {
      if (property === 'capabilities') return capabilities;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function observeDispatches(driver: StorageDriver): {
  readonly dispatchCount: () => number;
  readonly driver: StorageDriver;
} {
  let dispatches = 0;
  const observed = new Proxy(driver, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        dispatches += 1;
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { dispatchCount: () => dispatches, driver: observed };
}

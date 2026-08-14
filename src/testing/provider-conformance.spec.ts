import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFsStorageDriver } from '../files-sdk/fs/index.js';
import { StorageClient } from '../storage.client.js';
import type { StorageDriver } from '../storage.driver.js';
import type { StorageCapabilities } from '../storage.types.js';
import { createStorageProviderConformanceCases } from './provider-conformance.js';

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
        return {
          client: new StorageClient('restricted-filesystem', driver),
          close: () => rm(root, { force: true, recursive: true }),
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

function withoutConditionalCapabilities(driver: StorageDriver): StorageDriver {
  const capabilities = Object.fromEntries(
    Object.entries(driver.capabilities).filter(
      ([key]) => !CONDITIONAL_CAPABILITIES.has(key),
    ),
  ) as unknown as StorageCapabilities;

  return new Proxy(driver, {
    get(target, property, receiver) {
      if (property === 'capabilities') return capabilities;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

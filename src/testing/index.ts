import type { StorageDriver } from '../storage.driver.js';
import {
  createFilesSdkDriver,
  type FilesSdkDriverOptions,
} from '../files-sdk/files-sdk.driver.js';
import {
  memory,
  type MemoryAdapter,
  type MemoryAdapterOptions,
} from 'files-sdk/memory';

export interface MemoryStorageDriverOptions extends Omit<
  FilesSdkDriverOptions<MemoryAdapter>,
  'adapter'
> {
  adapter?: MemoryAdapterOptions;
}

export function createMemoryStorageDriver(
  options: MemoryStorageDriverOptions = {},
): StorageDriver {
  const { adapter, ...filesOptions } = options;
  return createFilesSdkDriver({
    ...filesOptions,
    adapter: memory(adapter),
  });
}

export type { MemoryAdapterOptions, MemorySeed } from 'files-sdk/memory';

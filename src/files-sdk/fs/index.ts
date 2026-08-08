import { fs, type FsAdapter, type FsAdapterOptions } from 'files-sdk/fs';

import {
  createFilesSdkDriver,
  type FilesSdkDriverOptions,
  type FilesSdkStorageDriver,
} from '../files-sdk.driver.js';

export interface FsStorageDriverOptions extends Omit<
  FilesSdkDriverOptions<FsAdapter>,
  'adapter'
> {
  adapter: FsAdapterOptions;
}

/**
 * Creates the files-sdk filesystem driver from the storage package's own
 * dependency context. The adapter reaches only `node:fs`, so this entry point
 * adds no native SDK to the install — unlike every object-store provider, it is
 * always available.
 *
 * The adapter keeps a `<key>.meta.json` sidecar beside each body to carry the
 * content type, ETag, and custom metadata that a filesystem has nowhere else to
 * put. Sidecars never surface as keys: `list` and `search` skip them, and
 * uploading a key that ends in `.meta.json` fails closed rather than colliding
 * with one.
 */
export function createFsStorageDriver(
  options: FsStorageDriverOptions,
): FilesSdkStorageDriver<FsAdapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  return createFilesSdkDriver({ ...filesOptions, adapter: fs(adapterOptions) });
}

export { fs, mapFsError } from 'files-sdk/fs';
export type { FsAdapter, FsAdapterOptions } from 'files-sdk/fs';

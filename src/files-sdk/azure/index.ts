import { FilesError } from 'files-sdk';
import {
  azure as createFilesSdkAzureAdapter,
  type AzureAdapter,
  type AzureAdapterOptions,
} from 'files-sdk/azure';
import {
  createFilesSdkDriver,
  mapFilesSdkError,
  type FilesSdkDriverOptions,
  type FilesSdkStorageDriver,
} from '../files-sdk.driver.js';
import { withAzureConditionalOperations } from './azure-conditional.js';

export interface AzureStorageDriverOptions extends Omit<
  FilesSdkDriverOptions<AzureAdapter>,
  'adapter'
> {
  adapter: AzureAdapterOptions;
}

/** Files SDK Azure adapter with native create/replace/read/delete predicates. */
export function azure(options: AzureAdapterOptions): AzureAdapter {
  if (options.credential !== undefined) {
    if (
      !options.accountName ||
      options.connectionString ||
      options.accountKey ||
      options.sasToken
    ) {
      throw new FilesError(
        'Provider',
        'Azure token authentication requires an account name and no competing credentials.',
      );
    }
    // Explicit workload identity must not silently fall back to ambient shared
    // keys or connection strings inherited from an unrelated Azure application.
    return withAzureConditionalOperations(
      createFilesSdkAzureAdapter({
        ...options,
        connectionString: '',
        accountKey: '',
        sasToken: '',
      }),
    );
  }
  return withAzureConditionalOperations(createFilesSdkAzureAdapter(options));
}

export function createAzureStorageDriver(
  options: AzureStorageDriverOptions,
): FilesSdkStorageDriver<AzureAdapter> {
  const { adapter, ...driver } = options;
  try {
    return createFilesSdkDriver({ ...driver, adapter: azure(adapter) });
  } catch (error) {
    throw mapFilesSdkError(error);
  }
}

export type { AzureAdapter, AzureAdapterOptions } from 'files-sdk/azure';

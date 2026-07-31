import type {
  StorageBody,
  StorageCapabilities,
  StorageDownloadOptions,
  StorageListOptions,
  StorageListResult,
  StorageObject,
  StorageObjectMetadata,
  StorageOperationOptions,
  StorageSearchOptions,
  StorageSignedDownloadOptions,
  StorageSignedUpload,
  StorageSignedUploadOptions,
  StorageUploadOptions,
  StorageUploadResult,
} from './storage.types.js';

export interface StorageDriver {
  readonly name: string;
  readonly capabilities: StorageCapabilities;

  upload(
    key: string,
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult>;
  download(
    key: string,
    options?: StorageDownloadOptions,
  ): Promise<StorageObject>;
  head(
    key: string,
    options?: StorageOperationOptions,
  ): Promise<StorageObjectMetadata>;
  exists(key: string, options?: StorageOperationOptions): Promise<boolean>;
  delete(key: string, options?: StorageOperationOptions): Promise<void>;
  copy(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void>;
  move(
    sourceKey: string,
    destinationKey: string,
    options?: StorageOperationOptions,
  ): Promise<void>;
  list(options?: StorageListOptions): Promise<StorageListResult>;
  search(
    pattern: string | RegExp,
    options?: StorageSearchOptions,
  ): AsyncIterable<StorageObjectMetadata>;
  signDownload(
    key: string,
    options?: StorageSignedDownloadOptions,
  ): Promise<string>;
  signUpload(
    key: string,
    options: StorageSignedUploadOptions,
  ): Promise<StorageSignedUpload>;
  close?(): void | Promise<void>;
}

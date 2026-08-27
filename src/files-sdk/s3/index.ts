import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  createPresignedPost,
  type PresignedPostOptions,
} from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import {
  createStoredFile,
  type AdapterConditionalOperations,
  type ConditionalUploadResult,
  type CopyCondition,
  type OperationOptions as FilesOperationOptions,
  type StoredFile,
} from 'files-sdk';
import {
  mapS3Error,
  s3 as createFilesSdkS3Adapter,
  type S3Adapter,
  type S3AdapterOptions,
} from 'files-sdk/s3';

import type {
  StorageBody,
  StorageCapabilities,
  StorageConditionalDeleteOptions,
  StorageConditionalReadOptions,
  StorageConditionalUploadOptions,
  StorageObject,
  StorageOperationOptions,
  StoragePromotionOptions,
  StorageUploadResult,
} from '../../storage.types.js';
import {
  StorageError,
  StorageErrorCode,
  isStorageError,
} from '../../storage.error.js';
import {
  normalizeProviderStorageEtag,
  storageEtagHeader,
} from '../../storage-etag.js';
import {
  assertFilesSdkS3AdapterHasNoReservedExtensions,
  createFilesSdkDriver,
  markFilesSdkS3AdapterUndecorated,
  markFilesSdkS3RawClientProvenance,
  type FilesSdkConditionalCopyAdapter,
  type FilesSdkConditionalDeleteAdapter,
  type FilesSdkConditionalReadAdapter,
  type FilesSdkConditionalUploadAdapter,
  type FilesSdkDriverOptions,
  type FilesSdkPhysicalKeyAdapter,
  type FilesSdkSignedUploadPolicyAdapter,
  type FilesSdkSignedDownloadPolicyAdapter,
  type FilesSdkStorageDriver,
  mapFilesSdkError,
  mapStorageErrorToFilesSdkError,
} from '../files-sdk.driver.js';
import {
  getS3ConstructionMetadata,
  getS3ConditionalRequestPermission,
  recordS3ConstructionMetadata,
  recordS3ConditionalRequestPermission,
} from './construction-metadata.js';

export interface S3StorageDriverOptions extends Omit<
  FilesSdkDriverOptions<S3Adapter>,
  'adapter'
> {
  adapter: S3AdapterOptions;
  /**
   * Exact, conformance-verified provider behavior. Native AWS S3 uses the
   * built-in AWS profile when no endpoint override is present; an explicit
   * native profile may only narrow that immutable ceiling. Endpoint overrides
   * without an explicit profile force the whole driver read-only.
   */
  providerProfile?: S3ProviderProfile;
}

type S3ProfileCapabilities = Pick<
  StorageCapabilities,
  | 'conditionalCreate'
  | 'conditionalReplace'
  | 'conditionalDelete'
  | 'conditionalRead'
  | 'conditionalCopySource'
  | 'conditionalCopyDestination'
  | 'conditionalMultipartCompletion'
  | 'physicalKey'
  | 'signedUploadPolicy'
>;

const verifiedS3ProviderProfile = Symbol('verifiedS3ProviderProfile');
const verifiedS3ProviderProfiles = new WeakSet<object>();

export interface S3ProviderProfileInput extends S3ProfileCapabilities {
  /** Stable profile identity for configuration, diagnostics, and audit. */
  readonly name: string;
  /** Every S3-compatible profile must declare its complete-key byte budget. */
  readonly physicalKey: NonNullable<S3ProfileCapabilities['physicalKey']>;
  /** Constraints the provider proves; omission defaults both claims to false. */
  readonly signedUploadPolicy?: NonNullable<
    S3ProfileCapabilities['signedUploadPolicy']
  >;
}

/** A validated profile created by {@link defineS3ProviderProfile}. */
export type S3ProviderProfile = Readonly<
  Omit<S3ProviderProfileInput, 'signedUploadPolicy'> & {
    readonly signedUploadPolicy: NonNullable<
      S3ProfileCapabilities['signedUploadPolicy']
    >;
  }
> & {
  readonly [verifiedS3ProviderProfile]: true;
};

function assertCapabilityBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean.`);
  }
}

/** Validates and deeply freezes an explicitly verified S3-compatible profile. */
export function defineS3ProviderProfile(
  profile: S3ProviderProfileInput,
): S3ProviderProfile {
  if (typeof profile.name !== 'string' || profile.name.trim().length === 0) {
    throw new TypeError('S3 provider profile name must be a non-empty string.');
  }
  if (
    !Number.isSafeInteger(profile.physicalKey.maxBytes) ||
    profile.physicalKey.maxBytes <= 0
  ) {
    throw new TypeError(
      'S3 provider profile physicalKey.maxBytes must be a positive safe integer.',
    );
  }

  const booleanFields = [
    [
      profile.signedUploadPolicy !== undefined,
      'signedUploadPolicy.contentType',
      profile.signedUploadPolicy?.contentType,
    ],
    [
      profile.signedUploadPolicy !== undefined,
      'signedUploadPolicy.sizeRange',
      profile.signedUploadPolicy?.sizeRange,
    ],
    [
      profile.conditionalCreate !== undefined,
      'conditionalCreate.resultEtag',
      profile.conditionalCreate?.resultEtag,
    ],
    [
      profile.conditionalReplace !== undefined,
      'conditionalReplace.resultEtag',
      profile.conditionalReplace?.resultEtag,
    ],
    [
      profile.conditionalDelete !== undefined,
      'conditionalDelete.etag',
      profile.conditionalDelete?.etag,
    ],
    [
      profile.conditionalRead !== undefined,
      'conditionalRead.etag',
      profile.conditionalRead?.etag,
    ],
    [
      profile.conditionalRead !== undefined,
      'conditionalRead.version',
      profile.conditionalRead?.version,
    ],
    [
      profile.conditionalCopySource !== undefined,
      'conditionalCopySource.etag',
      profile.conditionalCopySource?.etag,
    ],
    [
      profile.conditionalCopySource !== undefined,
      'conditionalCopySource.version',
      profile.conditionalCopySource?.version,
    ],
    [
      profile.conditionalCopySource?.requiresDestinationPredicate !== undefined,
      'conditionalCopySource.requiresDestinationPredicate',
      profile.conditionalCopySource?.requiresDestinationPredicate,
    ],
    [
      profile.conditionalCopyDestination !== undefined,
      'conditionalCopyDestination.create',
      profile.conditionalCopyDestination?.create,
    ],
    [
      profile.conditionalCopyDestination !== undefined,
      'conditionalCopyDestination.replace',
      profile.conditionalCopyDestination?.replace,
    ],
    [
      profile.conditionalCopyDestination !== undefined,
      'conditionalCopyDestination.atomicWithSource',
      profile.conditionalCopyDestination?.atomicWithSource,
    ],
    [
      profile.conditionalCopyDestination?.requiresSourcePredicate !== undefined,
      'conditionalCopyDestination.requiresSourcePredicate',
      profile.conditionalCopyDestination?.requiresSourcePredicate,
    ],
    [
      profile.conditionalMultipartCompletion !== undefined,
      'conditionalMultipartCompletion.create',
      profile.conditionalMultipartCompletion?.create,
    ],
    [
      profile.conditionalMultipartCompletion !== undefined,
      'conditionalMultipartCompletion.replace',
      profile.conditionalMultipartCompletion?.replace,
    ],
  ] as const;
  for (const [declared, label, value] of booleanFields) {
    if (declared) assertCapabilityBoolean(value, label);
  }
  if (
    profile.conditionalCopyDestination?.atomicWithSource === true &&
    profile.conditionalCopySource?.etag !== true &&
    profile.conditionalCopySource?.version !== true
  ) {
    throw new TypeError(
      'An atomic destination-copy profile must enable at least one source-copy condition.',
    );
  }
  if (
    profile.conditionalCopyDestination?.atomicWithSource === true &&
    profile.conditionalCopyDestination.create !== true &&
    profile.conditionalCopyDestination.replace !== true
  ) {
    throw new TypeError(
      'An atomic destination-copy profile must declare create or replace support.',
    );
  }
  if (
    profile.conditionalMultipartCompletion?.create === true &&
    profile.conditionalCreate === undefined
  ) {
    throw new TypeError(
      'Conditional multipart create requires conditional create support.',
    );
  }
  if (
    profile.conditionalMultipartCompletion?.replace === true &&
    profile.conditionalReplace === undefined
  ) {
    throw new TypeError(
      'Conditional multipart replace requires conditional replace support.',
    );
  }

  const clone: Omit<S3ProviderProfileInput, 'signedUploadPolicy'> & {
    readonly signedUploadPolicy: NonNullable<
      S3ProfileCapabilities['signedUploadPolicy']
    >;
  } = {
    name: profile.name.trim(),
    physicalKey: Object.freeze({ ...profile.physicalKey }),
    signedUploadPolicy: Object.freeze(
      profile.signedUploadPolicy === undefined
        ? { contentType: false, sizeRange: false }
        : { ...profile.signedUploadPolicy },
    ),
    ...(profile.conditionalCreate !== undefined && {
      conditionalCreate: Object.freeze({ ...profile.conditionalCreate }),
    }),
    ...(profile.conditionalReplace !== undefined && {
      conditionalReplace: Object.freeze({ ...profile.conditionalReplace }),
    }),
    ...(profile.conditionalDelete !== undefined && {
      conditionalDelete: Object.freeze({ ...profile.conditionalDelete }),
    }),
    ...(profile.conditionalRead !== undefined && {
      conditionalRead: Object.freeze({ ...profile.conditionalRead }),
    }),
    ...(profile.conditionalCopySource !== undefined && {
      conditionalCopySource: Object.freeze({
        ...profile.conditionalCopySource,
      }),
    }),
    ...(profile.conditionalCopyDestination !== undefined && {
      conditionalCopyDestination: Object.freeze({
        ...profile.conditionalCopyDestination,
      }),
    }),
    ...(profile.conditionalMultipartCompletion !== undefined && {
      conditionalMultipartCompletion: Object.freeze({
        ...profile.conditionalMultipartCompletion,
      }),
    }),
  };
  Object.defineProperty(clone, verifiedS3ProviderProfile, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  const verified = Object.freeze(clone) as S3ProviderProfile;
  verifiedS3ProviderProfiles.add(verified);
  return verified;
}

function assertVerifiedS3ProviderProfile(profile: S3ProviderProfile): void {
  if (
    typeof profile !== 'object' ||
    profile === null ||
    !verifiedS3ProviderProfiles.has(profile)
  ) {
    throw new TypeError(
      'providerProfile must be created with defineS3ProviderProfile().',
    );
  }
}

function assertS3ProviderProfileContainedBy(
  profile: S3ProviderProfile,
  ceiling: S3ProviderProfile,
): void {
  if (profile.physicalKey.maxBytes > ceiling.physicalKey.maxBytes) {
    throw new TypeError(
      `S3 provider profile "${profile.name}" cannot widen ${ceiling.name} physicalKey.maxBytes beyond ${ceiling.physicalKey.maxBytes}.`,
    );
  }

  const operationCapabilities = [
    ['conditionalCreate', profile.conditionalCreate, ceiling.conditionalCreate],
    [
      'conditionalReplace',
      profile.conditionalReplace,
      ceiling.conditionalReplace,
    ],
    ['conditionalDelete', profile.conditionalDelete, ceiling.conditionalDelete],
    ['conditionalRead', profile.conditionalRead, ceiling.conditionalRead],
    [
      'conditionalCopySource',
      profile.conditionalCopySource,
      ceiling.conditionalCopySource,
    ],
    [
      'conditionalCopyDestination',
      profile.conditionalCopyDestination,
      ceiling.conditionalCopyDestination,
    ],
    [
      'conditionalMultipartCompletion',
      profile.conditionalMultipartCompletion,
      ceiling.conditionalMultipartCompletion,
    ],
  ] as const;
  for (const [name, declared, supported] of operationCapabilities) {
    if (declared !== undefined && supported === undefined) {
      throw new TypeError(
        `S3 provider profile "${profile.name}" cannot widen ${ceiling.name} with ${name}.`,
      );
    }
  }

  const booleanClaims = [
    [
      'signedUploadPolicy.contentType',
      profile.signedUploadPolicy.contentType,
      ceiling.signedUploadPolicy.contentType,
    ],
    [
      'signedUploadPolicy.sizeRange',
      profile.signedUploadPolicy.sizeRange,
      ceiling.signedUploadPolicy.sizeRange,
    ],
    [
      'conditionalCreate.resultEtag',
      profile.conditionalCreate?.resultEtag,
      ceiling.conditionalCreate?.resultEtag,
    ],
    [
      'conditionalReplace.resultEtag',
      profile.conditionalReplace?.resultEtag,
      ceiling.conditionalReplace?.resultEtag,
    ],
    [
      'conditionalDelete.etag',
      profile.conditionalDelete?.etag,
      ceiling.conditionalDelete?.etag,
    ],
    [
      'conditionalRead.etag',
      profile.conditionalRead?.etag,
      ceiling.conditionalRead?.etag,
    ],
    [
      'conditionalRead.version',
      profile.conditionalRead?.version,
      ceiling.conditionalRead?.version,
    ],
    [
      'conditionalCopySource.etag',
      profile.conditionalCopySource?.etag,
      ceiling.conditionalCopySource?.etag,
    ],
    [
      'conditionalCopySource.version',
      profile.conditionalCopySource?.version,
      ceiling.conditionalCopySource?.version,
    ],
    [
      'conditionalCopyDestination.create',
      profile.conditionalCopyDestination?.create,
      ceiling.conditionalCopyDestination?.create,
    ],
    [
      'conditionalCopyDestination.replace',
      profile.conditionalCopyDestination?.replace,
      ceiling.conditionalCopyDestination?.replace,
    ],
    [
      'conditionalCopyDestination.atomicWithSource',
      profile.conditionalCopyDestination?.atomicWithSource,
      ceiling.conditionalCopyDestination?.atomicWithSource,
    ],
    [
      'conditionalMultipartCompletion.create',
      profile.conditionalMultipartCompletion?.create,
      ceiling.conditionalMultipartCompletion?.create,
    ],
    [
      'conditionalMultipartCompletion.replace',
      profile.conditionalMultipartCompletion?.replace,
      ceiling.conditionalMultipartCompletion?.replace,
    ],
  ] as const;
  for (const [name, declared, supported] of booleanClaims) {
    if (declared === true && supported !== true) {
      throw new TypeError(
        `S3 provider profile "${profile.name}" cannot widen ${ceiling.name} with ${name}.`,
      );
    }
  }

  if (
    profile.conditionalCopySource !== undefined &&
    (profile.conditionalCopySource.etag ||
      profile.conditionalCopySource.version) &&
    ceiling.conditionalCopySource?.requiresDestinationPredicate === true &&
    profile.conditionalCopySource.requiresDestinationPredicate !== true
  ) {
    throw new TypeError(
      `S3 provider profile "${profile.name}" cannot remove ${ceiling.name} conditionalCopySource.requiresDestinationPredicate.`,
    );
  }
  if (
    profile.conditionalCopyDestination !== undefined &&
    (profile.conditionalCopyDestination.create ||
      profile.conditionalCopyDestination.replace) &&
    ceiling.conditionalCopyDestination?.requiresSourcePredicate === true &&
    profile.conditionalCopyDestination.requiresSourcePredicate !== true
  ) {
    throw new TypeError(
      `S3 provider profile "${profile.name}" cannot remove ${ceiling.name} conditionalCopyDestination.requiresSourcePredicate.`,
    );
  }
}

export const AWS_S3_PROVIDER_PROFILE = defineS3ProviderProfile({
  name: 'aws-s3-general-purpose',
  physicalKey: { maxBytes: 1024 },
  signedUploadPolicy: { contentType: true, sizeRange: true },
  conditionalCreate: { resultEtag: true },
  conditionalReplace: { resultEtag: true },
  conditionalDelete: { etag: true },
  conditionalRead: { etag: true, version: true },
  conditionalCopySource: { etag: true, version: true },
  conditionalCopyDestination: {
    atomicWithSource: true,
    create: true,
    replace: true,
  },
  conditionalMultipartCompletion: { create: true, replace: true },
});

export const CLOUDFLARE_R2_PROVIDER_PROFILE = defineS3ProviderProfile({
  name: 'cloudflare-r2-stable',
  physicalKey: { maxBytes: 1024 },
  signedUploadPolicy: { contentType: true, sizeRange: false },
  conditionalCreate: { resultEtag: true },
  conditionalReplace: { resultEtag: true },
  conditionalRead: { etag: true, version: false },
  conditionalCopySource: { etag: true, version: false },
});

const UNVERIFIED_S3_PROVIDER_PROFILE = defineS3ProviderProfile({
  name: 'unverified-s3-compatible',
  physicalKey: { maxBytes: 1024 },
  signedUploadPolicy: { contentType: false, sizeRange: false },
});

type S3StorageAdapterBase = S3Adapter &
  FilesSdkPhysicalKeyAdapter &
  FilesSdkSignedDownloadPolicyAdapter &
  FilesSdkSignedUploadPolicyAdapter;

export type S3StorageAdapter = S3StorageAdapterBase &
  Partial<
    FilesSdkConditionalCopyAdapter &
      FilesSdkConditionalDeleteAdapter &
      FilesSdkConditionalReadAdapter &
      FilesSdkConditionalUploadAdapter
  >;

function filesAttemptOptions<Options extends FilesOperationOptions>(
  options: Options | undefined,
): Omit<Options, 'retries'> | undefined {
  if (options === undefined) return undefined;
  // Files owns retry settlement. Its adapter primitives receive a single
  // merged attempt signal and must not start a second retry loop.
  const { retries: _retries, ...attempt } = options;
  return attempt;
}

async function throughFilesConditionalBoundary<Result>(
  operationName: 'copy' | 'delete' | 'download' | 'upload',
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error: unknown) {
    throw mapStorageErrorToFilesSdkError(
      mapS3ConditionalError(error, operationName),
    );
  }
}

function storedFileOfStorageObject(object: StorageObject): StoredFile {
  return createStoredFile(
    {
      ...(object.etag !== undefined && { etag: object.etag }),
      key: object.key,
      ...(object.lastModified !== undefined && {
        lastModified: object.lastModified.getTime(),
      }),
      ...(object.metadata !== undefined && {
        metadata: { ...object.metadata },
      }),
      size: object.size,
      type: object.contentType,
    },
    { factory: () => object.body, kind: 'stream' },
  );
}

function copySource(
  bucket: string,
  key: string,
  version: string | undefined,
): string {
  const source = `${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  return version === undefined
    ? source
    : `${source}?versionId=${encodeURIComponent(version)}`;
}

function operationSignal(
  options: StorageOperationOptions,
): AbortSignal | undefined {
  const timeoutSignal =
    options.timeout === undefined || options.timeout <= 0
      ? undefined
      : AbortSignal.timeout(options.timeout);
  if (options.signal === undefined) {
    return timeoutSignal;
  }
  return timeoutSignal === undefined
    ? options.signal
    : AbortSignal.any([options.signal, timeoutSignal]);
}

function maxRetries(options: StorageOperationOptions): number {
  const configured =
    typeof options.retries === 'number'
      ? options.retries
      : options.retries?.max;
  return Math.max(0, Math.floor(configured ?? 0));
}

function invalidS3Argument(
  message: string,
  operation: 'copy' | 'delete' | 'download' | 'upload',
  key?: unknown,
): never {
  throw new StorageError(message, {
    code: StorageErrorCode.INVALID_ARGUMENT,
    ...(typeof key === 'string' && { key }),
    operation,
    permanent: true,
  });
}

function assertS3Key(
  key: unknown,
  label: string,
  operation: 'copy' | 'delete' | 'download' | 'upload',
): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) {
    invalidS3Argument(`${label} must be a non-empty string.`, operation, key);
  }
}

function etagHeader(
  etag: unknown,
  key: string,
  operation: 'copy' | 'delete' | 'download' | 'upload',
  label: string,
): string {
  const header = storageEtagHeader(etag);
  if (header === undefined) {
    throw new StorageError(`${label} must be a canonical storage ETag.`, {
      code: StorageErrorCode.INVALID_ARGUMENT,
      key,
      operation,
      permanent: true,
    });
  }
  return header;
}

function assertConditionalReadInput(
  key: string,
  options: StorageConditionalReadOptions,
): void {
  const candidate = options as unknown;
  if (typeof candidate !== 'object' || candidate === null) {
    invalidS3Argument(
      'Conditional read options must be an object.',
      'download',
      key,
    );
  }
  const condition = (candidate as { readonly condition?: unknown }).condition;
  if (typeof condition !== 'object' || condition === null) {
    invalidS3Argument(
      'Conditional read requires an ETag or version predicate.',
      'download',
      key,
    );
  }
  const { etag, version } = condition as {
    readonly etag?: unknown;
    readonly version?: unknown;
  };
  if (etag === undefined && version === undefined) {
    invalidS3Argument(
      'Conditional read requires an ETag or version predicate.',
      'download',
      key,
    );
  }
  if (etag !== undefined) {
    etagHeader(etag, key, 'download', 'condition.etag');
  }
  if (
    version !== undefined &&
    (typeof version !== 'string' || version.length === 0)
  ) {
    invalidS3Argument(
      'condition.version must be a non-empty string.',
      'download',
      key,
    );
  }

  const range = (candidate as { readonly range?: unknown }).range;
  if (range === undefined) return;
  if (typeof range !== 'object' || range === null) {
    invalidS3Argument('range must be an object.', 'download', key);
  }
  const { end, start } = range as {
    readonly end?: unknown;
    readonly start?: unknown;
  };
  if (!Number.isSafeInteger(start) || (start as number) < 0) {
    invalidS3Argument(
      'range.start must be a non-negative safe integer.',
      'download',
      key,
    );
  }
  if (
    end !== undefined &&
    (!Number.isSafeInteger(end) || (end as number) < (start as number))
  ) {
    invalidS3Argument(
      'range.end must be a safe integer greater than or equal to range.start.',
      'download',
      key,
    );
  }
}

function assertPromotionInput(
  sourceKey: string,
  destinationKey: string,
  promotion: StoragePromotionOptions,
): void {
  const candidate = promotion as unknown;
  if (typeof candidate !== 'object' || candidate === null) {
    invalidS3Argument(
      'Promotion options must be an object.',
      'copy',
      sourceKey,
    );
  }
  const { destination, sourceEtag, sourceVersion } = candidate as {
    readonly destination?: unknown;
    readonly sourceEtag?: unknown;
    readonly sourceVersion?: unknown;
  };
  if (sourceEtag !== undefined) {
    etagHeader(sourceEtag, sourceKey, 'copy', 'sourceEtag');
  }
  if (
    sourceVersion !== undefined &&
    (typeof sourceVersion !== 'string' || sourceVersion.length === 0)
  ) {
    invalidS3Argument(
      'sourceVersion must be a non-empty string.',
      'copy',
      sourceKey,
    );
  }
  if (
    destination !== undefined &&
    (typeof destination !== 'object' ||
      destination === null ||
      ((destination as { readonly type?: unknown }).type !== 'create' &&
        (destination as { readonly type?: unknown }).type !== 'replace'))
  ) {
    invalidS3Argument(
      'destination.type must be "create" or "replace".',
      'copy',
      destinationKey,
    );
  }
  if (
    typeof destination === 'object' &&
    destination !== null &&
    (destination as { readonly type?: unknown }).type === 'replace'
  ) {
    etagHeader(
      (destination as { readonly etag?: unknown }).etag,
      destinationKey,
      'copy',
      'destination.etag',
    );
  }
  if (
    sourceEtag === undefined &&
    sourceVersion === undefined &&
    destination === undefined
  ) {
    invalidS3Argument(
      'promote requires a source or destination precondition.',
      'copy',
      sourceKey,
    );
  }
}

function assertConditionalUploadInput(
  key: string,
  conditional: StorageConditionalUploadOptions,
): void {
  const candidate = conditional as unknown;
  if (typeof candidate !== 'object' || candidate === null) {
    invalidS3Argument(
      'Conditional upload options must be an object.',
      'upload',
      key,
    );
  }
  const condition = (candidate as { readonly condition?: unknown }).condition;
  if (
    typeof condition !== 'object' ||
    condition === null ||
    ((condition as { readonly type?: unknown }).type !== 'create' &&
      (condition as { readonly type?: unknown }).type !== 'replace')
  ) {
    invalidS3Argument(
      'condition.type must be "create" or "replace".',
      'upload',
      key,
    );
  }
  if ((condition as { readonly type: unknown }).type === 'replace') {
    etagHeader(
      (condition as { readonly etag?: unknown }).etag,
      key,
      'upload',
      'condition.etag',
    );
  }
}

function providerEtag(
  etag: unknown,
  key: string,
  operation: 'download' | 'upload',
): string | undefined {
  if (etag === undefined) {
    return undefined;
  }
  const normalized = normalizeProviderStorageEtag(etag);
  if (normalized === undefined) {
    throw new StorageError('S3 returned an invalid ETag.', {
      code: StorageErrorCode.PROVIDER,
      key,
      operation,
      permanent: true,
    });
  }
  return normalized;
}

function contentTypeOf(
  body: StorageBody,
  override: string | undefined,
): string {
  if (override !== undefined) {
    return override;
  }
  if (typeof body === 'string') {
    return 'text/plain; charset=utf-8';
  }
  if (body instanceof Blob && body.type.length > 0) {
    return body.type;
  }
  return 'application/octet-stream';
}

function assertBufferedFilesConditionalS3Body(
  body: StorageBody,
  key: string,
): void {
  if (body instanceof ReadableStream || body instanceof Readable) {
    throw new StorageError(
      'Conditional S3 uploads through Files require a buffered body.',
      {
        code: StorageErrorCode.PROVIDER,
        key,
        operation: 'upload',
        permanent: true,
      },
    );
  }
}

async function normalizeConditionalBody(
  body: StorageBody,
  onProgress: StorageConditionalUploadOptions['onProgress'],
): Promise<{
  body: Uint8Array | ReadableStream<Uint8Array>;
  size: () => number;
  contentLength?: number;
}> {
  let bytes: Uint8Array | undefined;
  if (typeof body === 'string') {
    bytes = new TextEncoder().encode(body);
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  } else if (body instanceof Blob) {
    bytes = new Uint8Array(await body.arrayBuffer());
  }

  if (bytes !== undefined) {
    const total = bytes.byteLength;
    onProgress?.({ loaded: 0, total });
    return { body: bytes, contentLength: total, size: () => total };
  }

  const stream =
    body instanceof Readable
      ? (Readable.toWeb(body) as ReadableStream<Uint8Array>)
      : body;
  if (!(stream instanceof ReadableStream)) {
    throw new StorageError('Unsupported conditional upload body.', {
      code: StorageErrorCode.INVALID_ARGUMENT,
      operation: 'upload',
      permanent: true,
    });
  }
  const reader = stream.getReader();
  let loaded = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      cancel(reason) {
        return reader.cancel(reason);
      },
      async pull(controller) {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          return;
        }
        loaded += result.value.byteLength;
        controller.enqueue(result.value);
        onProgress?.({ loaded });
      },
    }),
    size: () => loaded,
  };
}

function s3ErrorIdentity(error: unknown): {
  code: string | undefined;
  status: number | undefined;
} {
  let current = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      break;
    }
    seen.add(current);
    const candidate = current as {
      readonly name?: unknown;
      readonly Code?: unknown;
      readonly code?: unknown;
      readonly cause?: unknown;
      readonly $metadata?: { readonly httpStatusCode?: unknown };
    };
    const serviceCode = candidate.name ?? candidate.Code ?? candidate.code;
    const status = candidate.$metadata?.httpStatusCode;
    if (
      typeof status === 'number' ||
      (typeof serviceCode === 'string' && serviceCode !== 'FilesError')
    ) {
      return {
        code: typeof serviceCode === 'string' ? serviceCode : undefined,
        status: typeof status === 'number' ? status : undefined,
      };
    }
    current = candidate.cause;
  }
  return { code: undefined, status: undefined };
}

function mapS3ConditionalError(
  error: unknown,
  operation: 'copy' | 'delete' | 'download' | 'upload',
): StorageError {
  if (isStorageError(error)) {
    return error;
  }
  const identity = s3ErrorIdentity(error);
  const provider = mapFilesSdkError(mapS3Error(error));
  const precondition =
    identity.status === 412 || identity.code === 'PreconditionFailed';
  const conditionalConflict =
    identity.status === 409 || identity.code === 'ConditionalRequestConflict';
  const mappedPrecondition =
    provider.code === StorageErrorCode.CONFLICT && !conditionalConflict;
  const notFound =
    identity.status === 404 ||
    identity.code === 'NoSuchKey' ||
    identity.code === 'NoSuchUpload' ||
    provider.code === StorageErrorCode.NOT_FOUND;
  const code =
    precondition || mappedPrecondition || conditionalConflict
      ? StorageErrorCode.CONFLICT
      : notFound
        ? StorageErrorCode.NOT_FOUND
        : provider.code;
  return new StorageError(`Conditional S3 ${operation} failed.`, {
    aborted: provider.aborted,
    applied: provider.applied,
    ...(provider.appliedEtag !== undefined && {
      appliedEtag: provider.appliedEtag,
    }),
    code,
    operation,
    permanent:
      precondition || mappedPrecondition || notFound
        ? true
        : conditionalConflict
          ? false
          : provider.permanent,
    timedOut: provider.timedOut,
  });
}

function s3InterruptionError(
  options: StorageOperationOptions,
  signal: AbortSignal | undefined,
  operation: 'copy' | 'delete' | 'download' | 'upload',
): StorageError | undefined {
  if (signal?.aborted !== true) return undefined;
  const timedOut = options.signal?.aborted !== true;
  return new StorageError(
    timedOut
      ? `Conditional S3 ${operation} timed out.`
      : `Conditional S3 ${operation} was aborted.`,
    {
      aborted: !timedOut,
      code: timedOut ? StorageErrorCode.TIMEOUT : StorageErrorCode.ABORTED,
      operation,
      timedOut,
    },
  );
}

async function withS3Retry<Result>(
  options: StorageOperationOptions,
  operationName: 'copy' | 'delete' | 'download' | 'upload',
  operation: (signal: AbortSignal | undefined) => Promise<Result>,
): Promise<Result> {
  const retries = maxRetries(options);
  for (let attempt = 0; ; attempt += 1) {
    const signal = operationSignal(options);
    try {
      return await operation(signal);
    } catch (error) {
      const interrupted = s3InterruptionError(options, signal, operationName);
      if (interrupted !== undefined) throw interrupted;
      const mapped = mapS3ConditionalError(error, operationName);
      const retryableCode =
        mapped.code === StorageErrorCode.PROVIDER ||
        mapped.code === StorageErrorCode.CONFLICT;
      if (
        attempt >= retries ||
        !retryableCode ||
        mapped.aborted ||
        mapped.permanent ||
        signal?.aborted === true
      ) {
        throw mapped;
      }
      const delay =
        typeof options.retries === 'object' &&
        options.retries.backoff !== undefined
          ? options.retries.backoff({
              attempt: attempt + 1,
              error: mapped,
            })
          : Math.min(1000, 100 * 2 ** attempt);
      try {
        await waitForRetry(delay, signal);
      } catch (waitError) {
        throw (
          s3InterruptionError(options, signal, operationName) ??
          mapS3ConditionalError(waitError, operationName)
        );
      }
    }
  }
}

async function waitForRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener('abort', abort);
    const timer = setTimeout(
      () => {
        cleanup();
        resolve();
      },
      Math.max(0, milliseconds),
    );
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

const S3_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const S3_MAX_MULTIPART_PARTS = 10_000;
const S3_MULTIPART_CLEANUP_TIMEOUT_MS = 5_000;

async function waitForS3Cleanup<Result>(
  request: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const abort = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void request.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

async function abortMultipartUpload(
  base: S3RequestAdapter,
  key: string,
  uploadId: string,
  callerSignal: AbortSignal | undefined,
): Promise<void> {
  const cleanupController = new AbortController();
  const cleanupTimeout = setTimeout(
    () => cleanupController.abort(),
    S3_MULTIPART_CLEANUP_TIMEOUT_MS,
  );
  const cleanupSignal =
    callerSignal === undefined
      ? cleanupController.signal
      : AbortSignal.any([callerSignal, cleanupController.signal]);
  try {
    await waitForS3Cleanup(
      base.raw.send(
        new AbortMultipartUploadCommand({
          Bucket: base.bucket,
          Key: key,
          UploadId: uploadId,
        }),
        { abortSignal: cleanupSignal },
      ),
      cleanupSignal,
    );
  } finally {
    clearTimeout(cleanupTimeout);
  }
}

function conditionalHeaders(
  condition: StorageConditionalUploadOptions['condition'],
  key: string,
): { IfMatch?: string; IfNoneMatch?: string } {
  return condition.type === 'create'
    ? { IfNoneMatch: '*' }
    : {
        IfMatch: etagHeader(condition.etag, key, 'upload', 'condition.etag'),
      };
}

function rangeHeader(
  range: StorageConditionalReadOptions['range'],
): string | undefined {
  if (range === undefined) return undefined;
  return `bytes=${range.start}-${range.end ?? ''}`;
}

function s3ResponseStream(body: unknown): ReadableStream<Uint8Array> {
  let stream: ReadableStream<Uint8Array>;
  if (body instanceof ReadableStream) {
    stream = body;
  } else if (body instanceof Readable) {
    stream = Readable.toWeb(body) as ReadableStream<Uint8Array>;
  } else if (
    typeof body === 'object' &&
    body !== null &&
    'transformToWebStream' in body &&
    typeof body.transformToWebStream === 'function'
  ) {
    stream = body.transformToWebStream() as ReadableStream<Uint8Array>;
  } else {
    throw new StorageError('Conditional S3 download returned no body stream.', {
      code: StorageErrorCode.PROVIDER,
      operation: 'download',
      permanent: true,
    });
  }

  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch (error) {
        throw mapS3ConditionalError(error, 'download');
      } finally {
        reader.releaseLock();
      }
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        reader.releaseLock();
        controller.error(mapS3ConditionalError(error, 'download'));
      }
    },
  });
}

async function* multipartParts(
  source: Uint8Array | ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    for (let offset = 0; offset < source.byteLength; offset += partSize) {
      yield source.subarray(
        offset,
        Math.min(offset + partSize, source.byteLength),
      );
    }
    return;
  }

  const reader = source.getReader();
  let buffered = new Uint8Array(0);
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const combined = new Uint8Array(
        buffered.byteLength + result.value.byteLength,
      );
      combined.set(buffered);
      combined.set(result.value, buffered.byteLength);
      buffered = combined;
      while (buffered.byteLength >= partSize) {
        yield buffered.slice(0, partSize);
        buffered = buffered.slice(partSize);
      }
    }
    if (buffered.byteLength > 0) yield buffered;
  } finally {
    reader.releaseLock();
  }
}

function missingResultEtag(key: string): StorageError {
  return new StorageError(
    'S3 committed a conditional upload without returning the ETag required to identify its result; reconcile the destination before retrying.',
    {
      applied: true,
      code: StorageErrorCode.PROVIDER,
      key,
      operation: 'upload',
      permanent: true,
    },
  );
}

function conditionalResultEtag(etag: unknown, key: string): string {
  try {
    const normalized = providerEtag(etag, key, 'upload');
    if (normalized === undefined) throw missingResultEtag(key);
    return normalized;
  } catch (error) {
    if (!isStorageError(error) || error.applied) throw error;
    throw new StorageError(error.message, {
      aborted: error.aborted,
      applied: true,
      code: error.code,
      key,
      operation: 'upload',
      permanent: true,
      timedOut: error.timedOut,
    });
  }
}

function filesConditionalUploadResultOf(
  result: StorageUploadResult,
): ConditionalUploadResult {
  const etag = conditionalResultEtag(result.etag, result.key);
  return {
    contentType: result.contentType,
    etag,
    key: result.key,
    ...(result.lastModified !== undefined && {
      lastModified: result.lastModified.getTime(),
    }),
    size: result.size,
  };
}

type S3RequestAdapter = Pick<S3Adapter, 'bucket' | 'raw'>;

async function uploadConditionalSingle(
  base: S3RequestAdapter,
  key: string,
  body: StorageBody,
  conditional: StorageConditionalUploadOptions,
): Promise<StorageUploadResult> {
  const normalized = await normalizeConditionalBody(
    body,
    conditional.onProgress,
  );
  const contentType = contentTypeOf(body, conditional.contentType);
  const retryOptions: StorageOperationOptions =
    normalized.contentLength === undefined
      ? { ...conditional, retries: 0 }
      : conditional;
  const result = await withS3Retry(retryOptions, 'upload', (signal) =>
    base.raw.send(
      new PutObjectCommand({
        Body: normalized.body,
        Bucket: base.bucket,
        ...(conditional.cacheControl !== undefined && {
          CacheControl: conditional.cacheControl,
        }),
        ...(normalized.contentLength !== undefined && {
          ContentLength: normalized.contentLength,
        }),
        ContentType: contentType,
        ...conditionalHeaders(conditional.condition, key),
        Key: key,
        ...(conditional.metadata !== undefined && {
          Metadata: conditional.metadata,
        }),
      }),
      signal === undefined ? undefined : { abortSignal: signal },
    ),
  );
  const size = normalized.size();
  conditional.onProgress?.({
    loaded: size,
    ...(normalized.contentLength !== undefined && {
      total: normalized.contentLength,
    }),
  });
  const etag = conditionalResultEtag(result.ETag, key);
  return { contentType, etag, key, size };
}

async function uploadConditionalMultipart(
  base: S3RequestAdapter,
  key: string,
  body: StorageBody,
  conditional: StorageConditionalUploadOptions,
): Promise<StorageUploadResult> {
  const configuredPartSize =
    typeof conditional.multipart === 'object'
      ? conditional.multipart.partSize
      : undefined;
  if (
    configuredPartSize !== undefined &&
    (!Number.isSafeInteger(configuredPartSize) || configuredPartSize <= 0)
  ) {
    throw new StorageError(
      'multipart.partSize must be a positive safe integer.',
      {
        code: StorageErrorCode.INVALID_ARGUMENT,
        key,
        operation: 'upload',
        permanent: true,
      },
    );
  }
  const partSize = Math.max(
    S3_MIN_MULTIPART_PART_BYTES,
    configuredPartSize ?? S3_MIN_MULTIPART_PART_BYTES,
  );
  const cleanupSignal = operationSignal(conditional);
  const normalized = await normalizeConditionalBody(body, undefined);
  if (normalized.contentLength === 0) {
    return uploadConditionalSingle(base, key, new Uint8Array(), {
      ...conditional,
      multipart: false,
    });
  }
  const contentType = contentTypeOf(body, conditional.contentType);
  let uploadId: string | undefined;
  let size = 0;
  try {
    const created = await withS3Retry(conditional, 'upload', (signal) =>
      base.raw.send(
        new CreateMultipartUploadCommand({
          Bucket: base.bucket,
          ...(conditional.cacheControl !== undefined && {
            CacheControl: conditional.cacheControl,
          }),
          ContentType: contentType,
          Key: key,
          ...(conditional.metadata !== undefined && {
            Metadata: conditional.metadata,
          }),
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      ),
    );
    uploadId = created.UploadId;
    if (uploadId === undefined || uploadId.length === 0) {
      throw new StorageError('S3 did not return a multipart upload ID.', {
        code: StorageErrorCode.PROVIDER,
        key,
        operation: 'upload',
        permanent: true,
      });
    }

    const completedParts: Array<{ ETag: string; PartNumber: number }> = [];
    let partNumber = 0;
    for await (const part of multipartParts(normalized.body, partSize)) {
      partNumber += 1;
      if (partNumber > S3_MAX_MULTIPART_PARTS) {
        throw new StorageError(
          `Conditional multipart upload exceeds the ${S3_MAX_MULTIPART_PARTS}-part S3 limit.`,
          {
            code: StorageErrorCode.LIMIT_EXCEEDED,
            key,
            operation: 'upload',
            permanent: true,
          },
        );
      }
      const uploaded = await withS3Retry(conditional, 'upload', (signal) =>
        base.raw.send(
          new UploadPartCommand({
            Body: part,
            Bucket: base.bucket,
            ContentLength: part.byteLength,
            Key: key,
            PartNumber: partNumber,
            UploadId: uploadId,
          }),
          signal === undefined ? undefined : { abortSignal: signal },
        ),
      );
      const partEtag = providerEtag(uploaded.ETag, key, 'upload');
      if (partEtag === undefined) {
        throw new StorageError('S3 upload part returned no ETag.', {
          code: StorageErrorCode.PROVIDER,
          key,
          operation: 'upload',
          permanent: true,
        });
      }
      completedParts.push({
        ETag: storageEtagHeader(partEtag)!,
        PartNumber: partNumber,
      });
      size += part.byteLength;
      conditional.onProgress?.({
        loaded: size,
        ...(normalized.contentLength !== undefined && {
          total: normalized.contentLength,
        }),
      });
    }
    if (completedParts.length === 0) {
      const emptyUploadId = uploadId;
      uploadId = undefined;
      await abortMultipartUpload(base, key, emptyUploadId, cleanupSignal);
      return uploadConditionalSingle(base, key, new Uint8Array(), {
        ...conditional,
        multipart: false,
      });
    }

    const completed = await withS3Retry(conditional, 'upload', (signal) =>
      base.raw.send(
        new CompleteMultipartUploadCommand({
          Bucket: base.bucket,
          ...conditionalHeaders(conditional.condition, key),
          Key: key,
          MultipartUpload: { Parts: completedParts },
          UploadId: uploadId,
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      ),
    );
    const etag = conditionalResultEtag(completed.ETag, key);
    uploadId = undefined;
    return { contentType, etag, key, size };
  } catch (error) {
    if (uploadId !== undefined) {
      await abortMultipartUpload(base, key, uploadId, cleanupSignal).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

function profileUsesConditionalHeaders(profile: S3ProviderProfile): boolean {
  return (
    profile.conditionalCreate !== undefined ||
    profile.conditionalReplace !== undefined ||
    profile.conditionalDelete?.etag === true ||
    profile.conditionalRead?.etag === true ||
    profile.conditionalCopySource?.etag === true ||
    profile.conditionalCopyDestination?.create === true ||
    profile.conditionalCopyDestination?.replace === true ||
    profile.conditionalMultipartCompletion?.create === true ||
    profile.conditionalMultipartCompletion?.replace === true
  );
}

function conditionalOperationsForProfile(
  profile: S3ProviderProfile,
  adapter: S3StorageAdapter,
  upstream: AdapterConditionalOperations | undefined,
): AdapterConditionalOperations | undefined {
  const conditional: AdapterConditionalOperations = {};
  const legacyUpload = adapter.uploadConditional;
  const legacyRead = adapter.downloadConditional;
  const legacyDelete = adapter.deleteConditional;
  const legacyCopy = adapter.promote;

  if (profile.conditionalCreate?.resultEtag === true) {
    if (legacyUpload !== undefined) {
      conditional.create = (key, body, options) =>
        throughFilesConditionalBoundary('upload', async () => {
          assertBufferedFilesConditionalS3Body(body, key);
          return filesConditionalUploadResultOf(
            await legacyUpload(key, body, {
              ...filesAttemptOptions(options),
              condition: { type: 'create' },
            }),
          );
        });
    }
  }

  if (profile.conditionalReplace?.resultEtag === true) {
    if (legacyUpload !== undefined) {
      conditional.replace = (key, body, etag, options) =>
        throughFilesConditionalBoundary('upload', async () => {
          assertBufferedFilesConditionalS3Body(body, key);
          return filesConditionalUploadResultOf(
            await legacyUpload(key, body, {
              ...filesAttemptOptions(options),
              condition: { etag, type: 'replace' },
            }),
          );
        });
    }
  }

  if (profile.conditionalRead?.etag === true) {
    const nativeExactRead = upstream?.exactRead;
    if (nativeExactRead !== undefined) {
      conditional.exactRead = (key, etag, options) =>
        throughFilesConditionalBoundary('download', () =>
          nativeExactRead.call(upstream, key, etag, options),
        );
    } else if (legacyRead !== undefined) {
      conditional.exactRead = (key, etag, options) =>
        throughFilesConditionalBoundary('download', async () =>
          storedFileOfStorageObject(
            await legacyRead(key, {
              ...filesAttemptOptions(options),
              condition: { etag },
            }),
          ),
        );
    }
  }

  if (profile.conditionalDelete?.etag === true) {
    const nativeDelete = upstream?.delete;
    if (nativeDelete !== undefined) {
      conditional.delete = (key, etag, options) =>
        throughFilesConditionalBoundary('delete', () =>
          nativeDelete.call(upstream, key, etag, options),
        );
    } else if (legacyDelete !== undefined) {
      conditional.delete = (key, etag, options) =>
        throughFilesConditionalBoundary('delete', () =>
          legacyDelete(key, {
            ...filesAttemptOptions(options),
            condition: { etag },
          }),
        );
    }
  }

  const destinationCreate =
    profile.conditionalCopyDestination?.atomicWithSource === true &&
    profile.conditionalCopyDestination.create === true;
  const destinationReplace =
    profile.conditionalCopyDestination?.atomicWithSource === true &&
    profile.conditionalCopyDestination.replace === true;
  if (
    profile.conditionalCopySource?.etag === true &&
    (destinationCreate || destinationReplace) &&
    legacyCopy !== undefined
  ) {
    const nativeCopy = upstream?.copy;
    conditional.copy = Object.freeze({
      atomicSourceDestination: true,
      destinationCreate,
      destinationReplace,
      async run(
        sourceKey: string,
        destinationKey: string,
        condition: CopyCondition,
        options?: FilesOperationOptions,
      ): Promise<void> {
        const destinationSupported =
          condition.destination.type === 'create'
            ? destinationCreate
            : destinationReplace;
        if (!destinationSupported) {
          throw mapStorageErrorToFilesSdkError(
            new StorageError(
              `S3 provider profile "${profile.name}" does not support the requested conditional copy.`,
              {
                code: StorageErrorCode.NOT_SUPPORTED,
                key: destinationKey,
                operation: 'copy',
                permanent: true,
              },
            ),
          );
        }
        const nativeDestinationSupported =
          condition.destination.type === 'create'
            ? nativeCopy?.destinationCreate === true
            : nativeCopy?.destinationReplace === true;
        if (
          nativeCopy?.sourceEtag === true &&
          nativeCopy.atomicSourceDestination === true &&
          nativeDestinationSupported
        ) {
          return throughFilesConditionalBoundary('copy', () =>
            nativeCopy.run.call(
              nativeCopy,
              sourceKey,
              destinationKey,
              condition,
              options,
            ),
          );
        }
        return throughFilesConditionalBoundary('copy', () =>
          legacyCopy(sourceKey, destinationKey, {
            ...filesAttemptOptions(options),
            destination: condition.destination,
            sourceEtag: condition.source.etag,
          }),
        );
      },
      sourceEtag: true,
    });
  }

  return Object.keys(conditional).length === 0
    ? undefined
    : Object.freeze(conditional);
}

const configuredS3Clients = new WeakSet<S3Adapter['raw']>();
const withheldCustomConditionalOperations = new WeakMap<
  S3Adapter['raw'],
  AdapterConditionalOperations
>();

/** Constructs the upstream S3 adapter while retaining security-relevant metadata. */
export function s3(options: S3AdapterOptions): S3Adapter {
  // A verified provider profile is applied only by withS3Capabilities, after
  // construction. Opt the raw custom-endpoint client into upstream's wire
  // header guard here, but hide its broad conditional surface until that
  // profile has narrowed the exact operations below.
  const implicitCustomConditional =
    options.endpoint !== undefined && options.conditional === undefined;
  const adapter = createFilesSdkS3Adapter(
    implicitCustomConditional ? { ...options, conditional: true } : options,
  );
  if (options.endpoint !== undefined && adapter.conditional !== undefined) {
    if (options.conditional === true) {
      withheldCustomConditionalOperations.set(adapter.raw, adapter.conditional);
    }
    if (!Reflect.deleteProperty(adapter, 'conditional')) {
      adapter.raw.destroy();
      throw new TypeError(
        'The custom-endpoint S3 conditional surface could not be withheld before provider verification.',
      );
    }
  }
  recordS3ConditionalRequestPermission(
    adapter.raw,
    options.conditional !== false,
  );
  markFilesSdkS3AdapterUndecorated(adapter);
  recordS3ConstructionMetadata(adapter.raw, {
    publicBaseUrlConfigured: options.publicBaseUrl !== undefined,
  });
  return adapter;
}

/**
 * Adds only the exact operations declared by one verified provider profile.
 * Each raw adapter may be decorated once so capability state cannot depend on
 * profile application order. A native AWS SDK endpoint also bounds every
 * explicit profile by the built-in AWS capability ceiling.
 */
export function withS3Capabilities(
  base: S3Adapter,
  options: Pick<S3AdapterOptions, 'endpoint' | 'publicBaseUrl'> & {
    providerProfile?: S3ProviderProfile;
  } = {},
): S3StorageAdapter {
  const raw = base.raw;
  if (configuredS3Clients.has(raw)) {
    throw new TypeError(
      'withS3Capabilities may only be applied once to an S3 adapter.',
    );
  }
  assertFilesSdkS3AdapterHasNoReservedExtensions(base);
  const sdkHasCustomEndpoint = raw.config.isCustomEndpoint === true;
  if (options.endpoint !== undefined && !sdkHasCustomEndpoint) {
    throw new TypeError(
      'The declared S3 endpoint does not match the SDK client endpoint provenance.',
    );
  }
  if (!sdkHasCustomEndpoint) {
    // files-sdk does not expose this S3Client constructor option. Endpoint
    // resolution is lazy, so fixing the resolved SDK config before the adapter
    // is exposed prevents environment and shared-config endpoint redirection.
    raw.config.ignoreConfiguredEndpointUrls = true;
  }
  const inferredNativeAws = base.name === 's3' && !sdkHasCustomEndpoint;
  const profile =
    options.providerProfile ??
    (inferredNativeAws
      ? AWS_S3_PROVIDER_PROFILE
      : UNVERIFIED_S3_PROVIDER_PROFILE);
  assertVerifiedS3ProviderProfile(profile);
  const upstreamConditional =
    base.conditional ?? withheldCustomConditionalOperations.get(raw);
  if (
    profileUsesConditionalHeaders(profile) &&
    upstreamConditional === undefined &&
    getS3ConditionalRequestPermission(raw) !== true
  ) {
    throw new TypeError(
      `S3 provider profile "${profile.name}" requires conditional request headers, but the adapter was not constructed with conditional requests enabled.`,
    );
  }
  if (!sdkHasCustomEndpoint) {
    assertS3ProviderProfileContainedBy(profile, AWS_S3_PROVIDER_PROFILE);
  }
  const provenance =
    options.providerProfile === undefined
      ? inferredNativeAws
        ? 'native'
        : 'unverified'
      : inferredNativeAws
        ? 'native'
        : 'verified';
  const constructionMetadata = getS3ConstructionMetadata(raw);
  const publicBaseUrlConfigured =
    options.publicBaseUrl !== undefined ||
    constructionMetadata?.publicBaseUrlConfigured === true;
  const bucket = base.bucket;
  const requestAdapter: S3RequestAdapter = { bucket, raw };
  const signedUploadUrl: S3Adapter['signedUploadUrl'] = async (
    key,
    signOptions,
  ) => {
    if (
      signOptions.minSize !== undefined &&
      signOptions.maxSize === undefined
    ) {
      throw new StorageError(
        'S3 signed uploads cannot enforce minSize without maxSize.',
        {
          code: StorageErrorCode.NOT_SUPPORTED,
          key,
          operation: 'signUpload',
          permanent: true,
        },
      );
    }
    if (signOptions.maxSize !== undefined && key.endsWith('${filename}')) {
      throw new StorageError(
        'Signed POST keys must not end with the AWS ${filename} template.',
        {
          code: StorageErrorCode.INVALID_ARGUMENT,
          key,
          operation: 'signUpload',
          permanent: true,
        },
      );
    }
    if (
      signOptions.contentType !== undefined &&
      profile.signedUploadPolicy.contentType !== true
    ) {
      throw new StorageError(
        `S3 provider profile "${profile.name}" cannot enforce signed-upload contentType.`,
        {
          code: StorageErrorCode.NOT_SUPPORTED,
          key,
          operation: 'signUpload',
          permanent: true,
        },
      );
    }
    if (
      signOptions.maxSize !== undefined &&
      profile.signedUploadPolicy.sizeRange !== true
    ) {
      throw new StorageError(
        `S3 provider profile "${profile.name}" cannot enforce signed-upload sizeRange.`,
        {
          code: StorageErrorCode.NOT_SUPPORTED,
          key,
          operation: 'signUpload',
          permanent: true,
        },
      );
    }

    try {
      if (signOptions.maxSize !== undefined) {
        const conditions: NonNullable<PresignedPostOptions['Conditions']> = [
          [
            'content-length-range',
            signOptions.minSize ?? 1,
            signOptions.maxSize,
          ],
        ];
        if (signOptions.contentType !== undefined) {
          conditions.push(['eq', '$Content-Type', signOptions.contentType]);
        }
        const post = await createPresignedPost(raw, {
          Bucket: bucket,
          Conditions: conditions,
          Expires: signOptions.expiresIn,
          Key: key,
          ...(signOptions.contentType !== undefined && {
            Fields: { 'Content-Type': signOptions.contentType },
          }),
        });
        return { fields: post.fields, method: 'POST', url: post.url };
      }

      const url = await getSignedUrl(
        raw,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(signOptions.contentType !== undefined && {
            ContentType: signOptions.contentType,
          }),
        }),
        {
          expiresIn: signOptions.expiresIn,
          ...(signOptions.contentType !== undefined && {
            signableHeaders: new Set(['content-type']),
          }),
        },
      );
      return {
        ...(signOptions.contentType !== undefined && {
          headers: { 'Content-Type': signOptions.contentType },
        }),
        method: 'PUT',
        url,
      };
    } catch (error: unknown) {
      throw mapS3Error(error);
    }
  };
  const adapter = Object.assign(base, {
    physicalKey: profile.physicalKey,
    signedUploadPolicy: profile.signedUploadPolicy,
    signedUploadUrl,
    signedDownloadPolicy: Object.freeze({
      expiresIn: constructionMetadata !== undefined && !publicBaseUrlConfigured,
    }),
  } satisfies FilesSdkPhysicalKeyAdapter &
    FilesSdkSignedDownloadPolicyAdapter &
    FilesSdkSignedUploadPolicyAdapter &
    Pick<S3Adapter, 'signedUploadUrl'>) as S3StorageAdapter;

  if (
    profile.conditionalCopySource !== undefined ||
    profile.conditionalCopyDestination !== undefined
  ) {
    Object.assign(adapter, {
      ...(profile.conditionalCopySource !== undefined && {
        conditionalCopySource: profile.conditionalCopySource,
      }),
      ...(profile.conditionalCopyDestination !== undefined && {
        conditionalCopyDestination: profile.conditionalCopyDestination,
      }),
      async promote(
        sourceKey: string,
        destinationKey: string,
        promotion: StoragePromotionOptions,
      ): Promise<void> {
        assertS3Key(sourceKey, 'source key', 'copy');
        assertS3Key(destinationKey, 'destination key', 'copy');
        assertPromotionInput(sourceKey, destinationKey, promotion);
        if (
          (promotion.sourceEtag !== undefined &&
            profile.conditionalCopySource?.etag !== true) ||
          (promotion.sourceVersion !== undefined &&
            profile.conditionalCopySource?.version !== true) ||
          ((promotion.sourceEtag !== undefined ||
            promotion.sourceVersion !== undefined) &&
            promotion.destination === undefined &&
            profile.conditionalCopySource?.requiresDestinationPredicate ===
              true) ||
          (promotion.destination?.type === 'create' &&
            profile.conditionalCopyDestination?.create !== true) ||
          (promotion.destination?.type === 'replace' &&
            profile.conditionalCopyDestination?.replace !== true) ||
          (promotion.destination !== undefined &&
            promotion.sourceEtag === undefined &&
            promotion.sourceVersion === undefined &&
            profile.conditionalCopyDestination?.requiresSourcePredicate ===
              true) ||
          (promotion.destination !== undefined &&
            (promotion.sourceEtag !== undefined ||
              promotion.sourceVersion !== undefined) &&
            profile.conditionalCopyDestination?.atomicWithSource !== true)
        ) {
          throw new StorageError(
            `S3 provider profile "${profile.name}" does not support the requested conditional promotion.`,
            {
              code: StorageErrorCode.NOT_SUPPORTED,
              key: sourceKey,
              operation: 'promote',
              permanent: true,
            },
          );
        }
        await withS3Retry(promotion, 'copy', async (signal) => {
          await raw.send(
            new CopyObjectCommand({
              Bucket: bucket,
              CopySource: copySource(
                bucket,
                sourceKey,
                promotion.sourceVersion,
              ),
              ...(promotion.sourceEtag !== undefined && {
                CopySourceIfMatch: etagHeader(
                  promotion.sourceEtag,
                  sourceKey,
                  'copy',
                  'sourceEtag',
                ),
              }),
              ...(promotion.destination?.type === 'create'
                ? { IfNoneMatch: '*' }
                : promotion.destination?.type === 'replace'
                  ? {
                      IfMatch: etagHeader(
                        promotion.destination.etag,
                        destinationKey,
                        'copy',
                        'destination.etag',
                      ),
                    }
                  : {}),
              Key: destinationKey,
            }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
        });
      },
    } satisfies FilesSdkConditionalCopyAdapter);
  }

  if (profile.conditionalRead !== undefined) {
    Object.assign(adapter, {
      conditionalRead: profile.conditionalRead,
      async downloadConditional(
        key: string,
        options: StorageConditionalReadOptions,
      ): Promise<StorageObject> {
        assertS3Key(key, 'key', 'download');
        assertConditionalReadInput(key, options);
        if (
          (options.condition.etag !== undefined &&
            profile.conditionalRead?.etag !== true) ||
          (options.condition.version !== undefined &&
            profile.conditionalRead?.version !== true)
        ) {
          throw new StorageError(
            `S3 provider profile "${profile.name}" does not support the requested conditional read.`,
            {
              code: StorageErrorCode.NOT_SUPPORTED,
              key,
              operation: 'download',
              permanent: true,
            },
          );
        }
        const result = await withS3Retry(options, 'download', (signal) =>
          raw.send(
            new GetObjectCommand({
              Bucket: bucket,
              ...(options.condition.etag !== undefined && {
                IfMatch: etagHeader(
                  options.condition.etag,
                  key,
                  'download',
                  'condition.etag',
                ),
              }),
              Key: key,
              ...(rangeHeader(options.range) !== undefined && {
                Range: rangeHeader(options.range),
              }),
              ...(options.condition.version !== undefined && {
                VersionId: options.condition.version,
              }),
            }),
            signal === undefined ? undefined : { abortSignal: signal },
          ),
        );
        const etag = providerEtag(result.ETag, key, 'download');
        return {
          body: s3ResponseStream(result.Body),
          contentType: result.ContentType ?? 'application/octet-stream',
          ...(etag !== undefined && { etag }),
          key,
          ...(result.LastModified !== undefined && {
            lastModified: result.LastModified,
          }),
          ...(result.Metadata !== undefined && { metadata: result.Metadata }),
          name: key.split('/').at(-1) ?? key,
          size: Number(result.ContentLength ?? 0),
        };
      },
    } satisfies FilesSdkConditionalReadAdapter);
  }

  if (profile.conditionalDelete?.etag === true) {
    Object.assign(adapter, {
      conditionalDelete: profile.conditionalDelete,
      async deleteConditional(
        key: string,
        options: StorageConditionalDeleteOptions,
      ): Promise<void> {
        assertS3Key(key, 'key', 'delete');
        etagHeader(options?.condition?.etag, key, 'delete', 'condition.etag');
        await withS3Retry(options, 'delete', async (signal) => {
          await raw.send(
            new DeleteObjectCommand({
              Bucket: bucket,
              IfMatch: etagHeader(
                options.condition.etag,
                key,
                'delete',
                'condition.etag',
              ),
              Key: key,
            }),
            signal === undefined ? undefined : { abortSignal: signal },
          );
        });
      },
    } satisfies FilesSdkConditionalDeleteAdapter);
  }

  if (
    profile.conditionalCreate !== undefined ||
    profile.conditionalReplace !== undefined
  ) {
    Object.assign(adapter, {
      ...(profile.conditionalCreate !== undefined && {
        conditionalCreate: profile.conditionalCreate,
      }),
      ...(profile.conditionalReplace !== undefined && {
        conditionalReplace: profile.conditionalReplace,
      }),
      ...(profile.conditionalMultipartCompletion !== undefined && {
        conditionalMultipartCompletion: profile.conditionalMultipartCompletion,
      }),
      async uploadConditional(
        key: string,
        body: StorageBody,
        conditional: StorageConditionalUploadOptions,
      ): Promise<StorageUploadResult> {
        assertS3Key(key, 'key', 'upload');
        assertConditionalUploadInput(key, conditional);
        const supported =
          conditional.condition.type === 'create'
            ? profile.conditionalCreate !== undefined
            : profile.conditionalReplace !== undefined;
        const multipartRequested =
          conditional.multipart !== undefined &&
          conditional.multipart !== false;
        const multipartSupported =
          !multipartRequested ||
          (conditional.condition.type === 'create'
            ? profile.conditionalMultipartCompletion?.create === true
            : profile.conditionalMultipartCompletion?.replace === true);
        if (!supported || !multipartSupported) {
          throw new StorageError(
            `S3 provider profile "${profile.name}" does not support the requested conditional upload.`,
            {
              code: StorageErrorCode.NOT_SUPPORTED,
              key,
              operation: 'upload',
              permanent: true,
            },
          );
        }
        if (conditional.control !== undefined) {
          throw new StorageError(
            'Conditional S3 uploads do not support resumable control.',
            {
              code: StorageErrorCode.NOT_SUPPORTED,
              key,
              operation: 'upload',
              permanent: true,
            },
          );
        }
        return multipartRequested
          ? uploadConditionalMultipart(requestAdapter, key, body, conditional)
          : uploadConditionalSingle(requestAdapter, key, body, conditional);
      },
    } satisfies FilesSdkConditionalUploadAdapter);
  }

  Object.assign(adapter, {
    conditional: conditionalOperationsForProfile(
      profile,
      adapter,
      upstreamConditional,
    ),
  });

  Object.freeze(adapter);
  markFilesSdkS3RawClientProvenance(raw, adapter, provenance);
  configuredS3Clients.add(raw);
  return adapter;
}

/**
 * Creates the files-sdk S3 driver from the storage package's own dependency
 * context and exposes only the operations in its verified provider profile.
 */
export function createS3StorageDriver(
  options: S3StorageDriverOptions,
): FilesSdkStorageDriver<S3StorageAdapter> {
  const { adapter: adapterOptions, ...filesOptions } = options;
  const { providerProfile, ...plainFilesOptions } = filesOptions;
  const unverifiedCustomEndpoint =
    adapterOptions.endpoint !== undefined && providerProfile === undefined;
  return createFilesSdkDriver({
    ...plainFilesOptions,
    ...(unverifiedCustomEndpoint && { readonly: true }),
    adapter: withS3Capabilities(s3(adapterOptions), {
      ...adapterOptions,
      ...(providerProfile !== undefined && { providerProfile }),
    }),
  });
}

export { mapS3Error };
export type { S3Adapter, S3AdapterOptions, S3Sdk } from 'files-sdk/s3';

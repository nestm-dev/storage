import { deepStrictEqual, equal, fail, match, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type { StorageClient } from '../storage.client.js';
import {
  isStorageError,
  StorageErrorCode,
  type StorageError,
} from '../storage.error.js';
import type {
  StorageCapabilities,
  StorageConditionalCopyDestinationCapability,
  StorageConditionalCopySourceCapability,
  StorageConditionalDeleteCapability,
  StorageConditionalMultipartCompletionCapability,
  StorageConditionalReadCapability,
  StorageConditionalWriteCapability,
  StorageObject,
  StoragePhysicalKeyCapability,
  StorageUploadResult,
} from '../storage.types.js';

const CONDITIONAL_CAPABILITY_KEYS = [
  'conditionalCreate',
  'conditionalReplace',
  'conditionalDelete',
  'conditionalRead',
  'conditionalCopySource',
  'conditionalCopyDestination',
  'conditionalMultipartCompletion',
] as const;
const DEFAULT_MULTIPART_BYTES = 5 * 1024 * 1024 + 1;
const PASSED = Object.freeze({ status: 'passed' as const });

export interface StorageProviderConformanceCapabilities {
  readonly conditionalCreate?: StorageConditionalWriteCapability;
  readonly conditionalReplace?: StorageConditionalWriteCapability;
  readonly conditionalDelete?: StorageConditionalDeleteCapability;
  readonly conditionalRead?: StorageConditionalReadCapability;
  readonly conditionalCopySource?: StorageConditionalCopySourceCapability;
  readonly conditionalCopyDestination?: StorageConditionalCopyDestinationCapability;
  readonly conditionalMultipartCompletion?: StorageConditionalMultipartCompletionCapability;
  readonly physicalKey: StoragePhysicalKeyCapability;
}

export interface StorageProviderConformanceFixture {
  readonly client: StorageClient;
  /**
   * Resolves the current immutable version for a logical key. Providers that
   * advertise version predicates should supply this for a version-enabled
   * test bucket. Returning undefined visibly skips only the version subcases.
   */
  readonly resolveVersion?: (key: string) => Promise<string | undefined>;
  /**
   * Optional provider-aware cleanup. This is useful for versioned buckets,
   * where a plain delete would leave historical object versions behind.
   */
  readonly cleanup?: (keys: readonly string[]) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
}

export interface StorageProviderConformanceOptions {
  readonly createFixture:
    | (() => StorageProviderConformanceFixture)
    | (() => Promise<StorageProviderConformanceFixture>);
  readonly expected: StorageProviderConformanceCapabilities;
  /** Values such as test credentials that must never occur in public errors. */
  readonly forbiddenErrorValues?: readonly string[];
  readonly multipartBytes?: number;
  readonly provider: string;
}

export type StorageProviderConformanceCaseResult =
  typeof PASSED | { readonly reason: string; readonly status: 'skipped' };

export interface StorageProviderConformanceCase {
  readonly name: string;
  run(): Promise<StorageProviderConformanceCaseResult>;
}

interface CaseContext {
  readonly client: StorageClient;
  key(label: string): string;
  resolveVersion(key: string): Promise<string | undefined>;
  track(key: string): string;
}

type CaseOperation = (
  context: CaseContext,
) =>
  | StorageProviderConformanceCaseResult
  | Promise<StorageProviderConformanceCaseResult | void>
  | void;

/**
 * Builds runner-agnostic provider contract cases. A test runner can register
 * each returned case independently and translate a `skipped` result into its
 * native skip primitive. Every case receives a fresh client and namespace.
 */
export function createStorageProviderConformanceCases(
  options: StorageProviderConformanceOptions,
): readonly StorageProviderConformanceCase[] {
  positiveSafeInteger(
    options.expected.physicalKey.maxBytes,
    'expected.physicalKey.maxBytes',
  );
  positiveSafeInteger(
    options.multipartBytes ?? DEFAULT_MULTIPART_BYTES,
    'multipartBytes',
  );
  ok(options.provider.trim().length > 0, 'provider must not be empty');

  const expected = options.expected;
  return Object.freeze([
    providerCase(
      options,
      'declares the exact conditional capability matrix',
      ({ client }) => {
        deepStrictEqual(
          conditionalCapabilitiesOf(client.capabilities),
          expected,
          `${options.provider} advertised a capability matrix different from its verified profile`,
        );
      },
    ),
    providerCase(
      options,
      'performs baseline upload, read, and delete operations',
      async (context) => {
        const key = context.key('baseline.txt');
        await context.client.upload(key, 'baseline');
        equal(await readText(context.client, key), 'baseline');
        await context.client.delete(key);
        equal(await context.client.exists(key), false);
      },
    ),
    providerCase(
      options,
      'rejects an over-budget physical key before dispatch',
      async ({ client }) => {
        const key = 'x'.repeat(expected.physicalKey.maxBytes + 1);
        const error = await expectStorageError(
          () => client.upload(key, 'must-not-dispatch'),
          StorageErrorCode.LIMIT_EXCEEDED,
          options,
        );
        equal(error.permanent, true);
      },
    ),
    conditionalCreateCase(options),
    conditionalReplaceCase(options),
    conditionalDeleteCase(options),
    conditionalReadEtagCase(options),
    conditionalReadVersionCase(options),
    conditionalCopySourceEtagCase(options),
    conditionalCopySourceVersionCase(options),
    conditionalCopyDestinationCreateCase(options),
    conditionalCopyDestinationReplaceCase(options),
    conditionalCopyAtomicityCase(options),
    conditionalMultipartCreateCase(options),
    conditionalMultipartReplaceCase(options),
    providerCase(
      options,
      'sanitizes a provider not-found response',
      async (context) => {
        await expectStorageError(
          () => context.client.head(context.key('missing.txt')),
          StorageErrorCode.NOT_FOUND,
          options,
        );
      },
    ),
  ]);
}

function conditionalCreateCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const capability = options.expected.conditionalCreate;
  return providerCase(
    options,
    capability === undefined
      ? 'fails closed when conditional create is unsupported'
      : 'enforces conditional create atomically',
    async (context) => {
      const key = context.key('conditional-create.txt');
      if (capability === undefined) {
        await expectStorageError(
          () =>
            context.client.uploadConditional(key, 'blocked', {
              condition: { type: 'create' },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(key), false);
        return;
      }

      const created = await context.client.uploadConditional(key, 'created', {
        condition: { type: 'create' },
      });
      assertResultEtag(created, capability.resultEtag);
      await expectStorageError(
        () =>
          context.client.uploadConditional(key, 'overwritten', {
            condition: { type: 'create' },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
      equal(await readText(context.client, key), 'created');
    },
  );
}

function conditionalReplaceCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const capability = options.expected.conditionalReplace;
  return providerCase(
    options,
    capability === undefined
      ? 'fails closed when conditional replace is unsupported'
      : 'enforces conditional replace atomically',
    async (context) => {
      const key = context.key('conditional-replace.txt');
      const original = await seed(context, key, 'original');
      const etag = await resultEtag(context.client, key, original);
      if (capability === undefined) {
        await expectStorageError(
          () =>
            context.client.uploadConditional(key, 'blocked', {
              condition: { etag, type: 'replace' },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await readText(context.client, key), 'original');
        return;
      }

      const replaced = await context.client.uploadConditional(key, 'replaced', {
        condition: { etag, type: 'replace' },
      });
      assertResultEtag(replaced, capability.resultEtag);
      await expectStorageError(
        () =>
          context.client.uploadConditional(key, 'stale-overwrite', {
            condition: { etag, type: 'replace' },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
      equal(await readText(context.client, key), 'replaced');
    },
  );
}

function conditionalDeleteCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const capability = options.expected.conditionalDelete;
  return providerCase(
    options,
    capability?.etag === true
      ? 'enforces ETag-conditional delete atomically'
      : 'fails closed when ETag-conditional delete is unsupported',
    async (context) => {
      const key = context.key('conditional-delete.txt');
      const original = await seed(context, key, 'retained');
      const etag = await resultEtag(context.client, key, original);
      if (capability?.etag !== true) {
        await expectStorageError(
          () =>
            context.client.deleteConditional(key, {
              condition: { etag },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(key), true);
        return;
      }

      await expectStorageError(
        () =>
          context.client.deleteConditional(key, {
            condition: { etag: staleEtag(etag) },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
      equal(await context.client.exists(key), true);
      await context.client.deleteConditional(key, { condition: { etag } });
      equal(await context.client.exists(key), false);
    },
  );
}

function conditionalReadEtagCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported = options.expected.conditionalRead?.etag === true;
  return providerCase(
    options,
    supported
      ? 'reads only the requested ETag identity'
      : 'fails closed when ETag-conditional read is unsupported',
    async (context) => {
      const key = context.key('conditional-read-etag.txt');
      const original = await seed(context, key, 'observed');
      const etag = await resultEtag(context.client, key, original);
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.downloadConditional(key, {
              condition: { etag },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        return;
      }

      equal(
        await objectText(
          await context.client.downloadConditional(key, {
            condition: { etag },
          }),
        ),
        'observed',
      );
      await context.client.upload(key, 'changed');
      await expectStorageError(
        () =>
          context.client.downloadConditional(key, {
            condition: { etag },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
    },
  );
}

function conditionalReadVersionCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported = options.expected.conditionalRead?.version === true;
  return providerCase(
    options,
    supported
      ? 'reads an immutable provider version'
      : 'fails closed when version-conditional read is unsupported',
    async (context) => {
      const key = context.key('conditional-read-version.txt');
      await seed(context, key, 'version-one');
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.downloadConditional(key, {
              condition: { version: 'unsupported-version' },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        return;
      }

      const version = await context.resolveVersion(key);
      if (version === undefined) {
        return skippedVersion(options.provider);
      }
      await context.client.upload(key, 'version-two');
      equal(
        await objectText(
          await context.client.downloadConditional(key, {
            condition: { version },
          }),
        ),
        'version-one',
      );
    },
  );
}

function conditionalCopySourceEtagCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported = options.expected.conditionalCopySource?.etag === true;
  return providerCase(
    options,
    supported
      ? 'copies only the requested source ETag'
      : 'fails closed when source-ETag copy is unsupported',
    async (context) => {
      const source = context.key('copy-source-etag.txt');
      const destination = context.key('copy-source-etag-result.txt');
      const original = await seed(context, source, 'source-one');
      const etag = await resultEtag(context.client, source, original);
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.promote(source, destination, { sourceEtag: etag }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(destination), false);
        return;
      }

      await context.client.promote(source, destination, { sourceEtag: etag });
      equal(await readText(context.client, destination), 'source-one');
      const staleDestination = context.key('copy-source-etag-stale.txt');
      await context.client.upload(source, 'source-two');
      await expectStorageError(
        () =>
          context.client.promote(source, staleDestination, {
            sourceEtag: etag,
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
      equal(await context.client.exists(staleDestination), false);
    },
  );
}

function conditionalCopySourceVersionCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported = options.expected.conditionalCopySource?.version === true;
  return providerCase(
    options,
    supported
      ? 'copies an immutable source version'
      : 'fails closed when source-version copy is unsupported',
    async (context) => {
      const source = context.key('copy-source-version.txt');
      const destination = context.key('copy-source-version-result.txt');
      await seed(context, source, 'source-version-one');
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.promote(source, destination, {
              sourceVersion: 'unsupported-version',
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(destination), false);
        return;
      }

      const version = await context.resolveVersion(source);
      if (version === undefined) {
        return skippedVersion(options.provider);
      }
      await context.client.upload(source, 'source-version-two');
      await context.client.promote(source, destination, {
        sourceVersion: version,
      });
      equal(await readText(context.client, destination), 'source-version-one');
    },
  );
}

function conditionalCopyDestinationCreateCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported =
    options.expected.conditionalCopyDestination?.create === true;
  return providerCase(
    options,
    supported
      ? 'enforces create-only copy at the destination'
      : 'fails closed when create-only destination copy is unsupported',
    async (context) => {
      const source = context.key('copy-destination-create-source.txt');
      const destination = context.key('copy-destination-create-result.txt');
      await seed(context, source, 'copy-created');
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.promote(source, destination, {
              destination: { type: 'create' },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(destination), false);
        return;
      }

      await context.client.promote(source, destination, {
        destination: { type: 'create' },
      });
      equal(await readText(context.client, destination), 'copy-created');
      await expectStorageError(
        () =>
          context.client.promote(source, destination, {
            destination: { type: 'create' },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
    },
  );
}

function conditionalCopyDestinationReplaceCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported =
    options.expected.conditionalCopyDestination?.replace === true;
  return providerCase(
    options,
    supported
      ? 'enforces ETag replacement at the copy destination'
      : 'fails closed when destination replacement copy is unsupported',
    async (context) => {
      const source = context.key('copy-destination-replace-source.txt');
      const destination = context.key('copy-destination-replace-result.txt');
      await seed(context, source, 'replacement');
      const original = await seed(context, destination, 'destination-old');
      const etag = await resultEtag(context.client, destination, original);
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.promote(source, destination, {
              destination: { etag, type: 'replace' },
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await readText(context.client, destination), 'destination-old');
        return;
      }

      await context.client.promote(source, destination, {
        destination: { etag, type: 'replace' },
      });
      equal(await readText(context.client, destination), 'replacement');
      await expectStorageError(
        () =>
          context.client.promote(source, destination, {
            destination: { etag, type: 'replace' },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
    },
  );
}

function conditionalCopyAtomicityCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const destination = options.expected.conditionalCopyDestination;
  const source = options.expected.conditionalCopySource;
  const sourcePredicate =
    source?.etag === true
      ? 'etag'
      : source?.version === true
        ? 'version'
        : undefined;
  const destinationPredicate =
    destination?.create === true
      ? 'create'
      : destination?.replace === true
        ? 'replace'
        : undefined;
  const supported =
    destination?.atomicWithSource === true &&
    sourcePredicate !== undefined &&
    destinationPredicate !== undefined;
  return providerCase(
    options,
    supported
      ? 'combines source and destination copy predicates atomically'
      : 'fails closed when combined copy predicates are not atomic',
    async (context) => {
      const sourceKey = context.key('copy-atomic-source.txt');
      const destinationKey = context.key('copy-atomic-result.txt');
      const original = await seed(context, sourceKey, 'atomic-copy');
      let sourceCondition: { sourceEtag: string } | { sourceVersion: string };
      if (sourcePredicate === 'version') {
        const version = supported
          ? await context.resolveVersion(sourceKey)
          : 'unsupported-version';
        if (version === undefined) return skippedVersion(options.provider);
        sourceCondition = { sourceVersion: version };
      } else {
        sourceCondition = {
          sourceEtag: await resultEtag(context.client, sourceKey, original),
        };
      }
      const destinationCondition =
        destinationPredicate === 'replace'
          ? {
              destination: {
                etag: await resultEtag(
                  context.client,
                  destinationKey,
                  await seed(context, destinationKey, 'destination-old'),
                ),
                type: 'replace' as const,
              },
            }
          : { destination: { type: 'create' as const } };
      const promotion = { ...sourceCondition, ...destinationCondition };
      if (!supported) {
        await expectStorageError(
          () => context.client.promote(sourceKey, destinationKey, promotion),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        if (destinationPredicate === 'replace') {
          equal(
            await readText(context.client, destinationKey),
            'destination-old',
          );
        } else {
          equal(await context.client.exists(destinationKey), false);
        }
        return;
      }

      await context.client.promote(sourceKey, destinationKey, promotion);
      equal(await readText(context.client, destinationKey), 'atomic-copy');
    },
  );
}

function conditionalMultipartCreateCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported =
    options.expected.conditionalMultipartCompletion?.create === true;
  return providerCase(
    options,
    supported
      ? 'enforces create-only multipart completion'
      : 'fails closed when conditional multipart create is unsupported',
    async (context) => {
      const key = context.key('multipart-create.bin');
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.uploadConditional(key, 'blocked', {
              condition: { type: 'create' },
              multipart: true,
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await context.client.exists(key), false);
        return;
      }

      const body = multipartBody(options);
      await context.client.uploadConditional(key, body, {
        condition: { type: 'create' },
        multipart: { concurrency: 1, partSize: 5 * 1024 * 1024 },
      });
      await expectStorageError(
        () =>
          context.client.uploadConditional(key, body, {
            condition: { type: 'create' },
            multipart: { concurrency: 1, partSize: 5 * 1024 * 1024 },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
    },
  );
}

function conditionalMultipartReplaceCase(
  options: StorageProviderConformanceOptions,
): StorageProviderConformanceCase {
  const supported =
    options.expected.conditionalMultipartCompletion?.replace === true;
  return providerCase(
    options,
    supported
      ? 'enforces ETag-conditional multipart replacement'
      : 'fails closed when conditional multipart replace is unsupported',
    async (context) => {
      const key = context.key('multipart-replace.bin');
      const original = await seed(context, key, 'multipart-original');
      const etag = await resultEtag(context.client, key, original);
      if (!supported) {
        await expectStorageError(
          () =>
            context.client.uploadConditional(key, 'blocked', {
              condition: { etag, type: 'replace' },
              multipart: true,
            }),
          StorageErrorCode.NOT_SUPPORTED,
          options,
        );
        equal(await readText(context.client, key), 'multipart-original');
        return;
      }

      const body = multipartBody(options);
      await context.client.uploadConditional(key, body, {
        condition: { etag, type: 'replace' },
        multipart: { concurrency: 1, partSize: 5 * 1024 * 1024 },
      });
      await expectStorageError(
        () =>
          context.client.uploadConditional(key, body, {
            condition: { etag, type: 'replace' },
            multipart: { concurrency: 1, partSize: 5 * 1024 * 1024 },
          }),
        StorageErrorCode.CONFLICT,
        options,
      );
    },
  );
}

function providerCase(
  options: StorageProviderConformanceOptions,
  name: string,
  operation: CaseOperation,
): StorageProviderConformanceCase {
  return Object.freeze({
    name,
    async run(): Promise<StorageProviderConformanceCaseResult> {
      return withFixture(options, operation);
    },
  });
}

async function withFixture(
  options: StorageProviderConformanceOptions,
  operation: CaseOperation,
): Promise<StorageProviderConformanceCaseResult> {
  const fixture = await options.createFixture();
  const keys = new Set<string>();
  const namespace = `nestm-conformance/${safeSegment(options.provider)}/${randomUUID()}`;
  const context: CaseContext = {
    client: fixture.client,
    key(label) {
      const key = `${namespace}/${label}`;
      keys.add(key);
      return key;
    },
    resolveVersion(key) {
      return fixture.resolveVersion?.(key) ?? Promise.resolve(undefined);
    },
    track(key) {
      keys.add(key);
      return key;
    },
  };

  const noError = Symbol('no-error');
  let operationError: unknown | typeof noError = noError;
  let result: StorageProviderConformanceCaseResult = PASSED;
  try {
    result = (await operation(context)) ?? PASSED;
  } catch (error: unknown) {
    operationError = error;
  }

  let cleanupError: unknown | typeof noError = noError;
  try {
    if (fixture.cleanup === undefined) {
      await cleanupWithClient(fixture.client, [...keys]);
    } else {
      await fixture.cleanup([...keys]);
    }
  } catch (error: unknown) {
    cleanupError = error;
  }
  try {
    await fixture.client.onApplicationShutdown();
  } catch (error: unknown) {
    if (cleanupError === noError) cleanupError = error;
  }
  try {
    await fixture.close?.();
  } catch (error: unknown) {
    if (cleanupError === noError) cleanupError = error;
  }

  if (operationError !== noError) throw operationError;
  if (cleanupError !== noError) throw cleanupError;
  return result;
}

async function cleanupWithClient(
  client: StorageClient,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    try {
      await client.delete(key);
    } catch (error: unknown) {
      if (!isStorageError(error) || error.code !== StorageErrorCode.NOT_FOUND) {
        throw error;
      }
    }
  }
}

function conditionalCapabilitiesOf(
  capabilities: Readonly<StorageCapabilities>,
): StorageProviderConformanceCapabilities {
  const conditional: Partial<StorageProviderConformanceCapabilities> = {};
  for (const key of CONDITIONAL_CAPABILITY_KEYS) {
    const capability = capabilities[key];
    if (capability !== undefined) {
      Object.assign(conditional, { [key]: capability });
    }
  }
  ok(
    capabilities.physicalKey !== undefined,
    'provider must declare its complete physical-key byte budget',
  );
  return {
    ...conditional,
    physicalKey: capabilities.physicalKey,
  };
}

async function seed(
  context: CaseContext,
  key: string,
  body: string | Uint8Array,
): Promise<StorageUploadResult> {
  context.track(key);
  return context.client.upload(key, body);
}

async function resultEtag(
  client: StorageClient,
  key: string,
  result: StorageUploadResult,
): Promise<string> {
  const etag = result.etag ?? (await client.head(key)).etag;
  ok(etag !== undefined && etag.length > 0, 'provider did not return an ETag');
  return etag;
}

function assertResultEtag(
  result: StorageUploadResult,
  required: boolean,
): void {
  if (required) {
    ok(
      result.etag !== undefined && result.etag.length > 0,
      'conditional write committed without the advertised result ETag',
    );
  }
}

async function readText(client: StorageClient, key: string): Promise<string> {
  return objectText(await client.downloadStream(key));
}

async function objectText(object: StorageObject): Promise<string> {
  return new Response(object.body).text();
}

async function expectStorageError(
  operation: () => Promise<unknown>,
  code: StorageError['code'],
  options: StorageProviderConformanceOptions,
): Promise<StorageError> {
  try {
    await operation();
  } catch (error: unknown) {
    ok(isStorageError(error), 'provider operation did not return StorageError');
    equal(error.code, code);
    assertSanitizedError(error, options.forbiddenErrorValues ?? []);
    return error;
  }
  fail(`provider operation unexpectedly succeeded; expected ${code}`);
}

function assertSanitizedError(
  error: StorageError,
  forbiddenValues: readonly string[],
): void {
  ok(error.message.length <= 512, 'public storage error is unexpectedly large');
  match(
    error.message,
    /^[^\r\n]*$/u,
    'public storage error contains line breaks',
  );
  ok(
    !/<(?:Error|Code|Message|RequestId|HostId)>/iu.test(error.message),
    'public storage error contains a serialized provider response',
  );
  for (const value of forbiddenValues) {
    if (value.length > 0) {
      ok(
        !error.message.includes(value),
        'public storage error contains a forbidden provider configuration value',
      );
    }
  }
}

function staleEtag(etag: string): string {
  return etag === 'nestm-conformance-stale-etag'
    ? 'nestm-conformance-other-etag'
    : 'nestm-conformance-stale-etag';
}

function multipartBody(options: StorageProviderConformanceOptions): Uint8Array {
  return new Uint8Array(options.multipartBytes ?? DEFAULT_MULTIPART_BYTES);
}

function skippedVersion(
  provider: string,
): StorageProviderConformanceCaseResult {
  return {
    reason: `${provider} returned no version ID; use a dedicated version-enabled bucket to exercise this advertised subcapability`,
    status: 'skipped',
  };
}

function positiveSafeInteger(value: number, label: string): void {
  ok(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  );
}

function safeSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'provider'
  );
}

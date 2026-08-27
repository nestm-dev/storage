import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';

import { s3 as upstreamS3 } from 'files-sdk/s3';

import { StorageClient } from '../../storage.client.js';
import {
  isStorageError,
  StorageError,
  StorageErrorCode,
} from '../../storage.error.js';
import { createFilesSdkDriver } from '../files-sdk.driver.js';
import {
  AWS_S3_PROVIDER_PROFILE,
  CLOUDFLARE_R2_PROVIDER_PROFILE,
  createS3StorageDriver,
  defineS3ProviderProfile,
  s3,
  withS3Capabilities,
} from './index.js';

const adapter = {
  bucket: 'private-bucket',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
  region: 'us-east-1',
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function rejectedStorageError(
  operation: () => Promise<unknown>,
): Promise<StorageError> {
  try {
    await operation();
  } catch (error: unknown) {
    if (isStorageError(error)) return error;
    throw error;
  }
  throw new Error('Expected the storage operation to reject.');
}

async function resolvedHeadHostname(client: S3Client): Promise<string> {
  let hostname: string | undefined;
  client.middlewareStack.add(
    () => async (arguments_) => {
      const request = arguments_.request as { readonly hostname?: unknown };
      if (typeof request.hostname !== 'string') {
        throw new TypeError('S3 request did not resolve a hostname.');
      }
      hostname = request.hostname;
      return {
        output: { $metadata: {} },
        response: { headers: {}, statusCode: 200 },
      } as never;
    },
    {
      name: 'captureEndpointWithoutDispatch',
      priority: 'high',
      step: 'finalizeRequest',
    },
  );
  await client.send(
    new HeadObjectCommand({ Bucket: adapter.bucket, Key: 'endpoint-probe' }),
  );
  if (hostname === undefined) {
    throw new TypeError('S3 request did not reach endpoint resolution.');
  }
  return hostname;
}

async function expectFactoryIgnoresConfiguredEndpoints(): Promise<void> {
  const send = vi
    .spyOn(S3Client.prototype, 'send')
    .mockResolvedValue({ ContentLength: 0 } as never);
  const client = new StorageClient(
    'endpoint-provenance',
    createS3StorageDriver({ adapter }),
  );
  try {
    await client.head('endpoint-probe');
    const sdkClient = send.mock.instances[0] as S3Client | undefined;
    expect(sdkClient?.config.ignoreConfiguredEndpointUrls).toBe(true);
  } finally {
    await client.onApplicationShutdown();
    send.mockRestore();
  }
}

describe('createS3StorageDriver', () => {
  it('advertises the exact native AWS S3 capability profile', () => {
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    expect(client.capabilities).toMatchObject({
      conditionalCopyDestination: {
        atomicWithSource: true,
        create: true,
        replace: true,
      },
      conditionalCopySource: { etag: true, version: true },
      conditionalCreate: { resultEtag: true },
      conditionalDelete: { etag: true },
      conditionalMultipartCompletion: { create: true, replace: true },
      conditionalRead: { etag: true, version: true },
      conditionalReplace: { resultEtag: true },
      physicalKey: { maxBytes: 1024 },
      signedDownloadPolicy: { expiresIn: true },
      signedUploadPolicy: { contentType: true, sizeRange: true },
    });
  });

  it('rejects canonical and renamed native profiles that widen the immutable AWS key ceiling before dispatch', () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const widened = defineS3ProviderProfile({
      name: 'invalid-widened-native-aws',
      physicalKey: { maxBytes: 2048 },
    });
    const canonical = s3(adapter);
    const renamedBase = s3(adapter);
    const renamed = { ...renamedBase, name: 'renamed-native-s3' };

    try {
      expect(() =>
        withS3Capabilities(canonical, { providerProfile: widened }),
      ).toThrow(/cannot widen aws-s3-general-purpose physicalKey\.maxBytes/u);
      expect(() =>
        withS3Capabilities(renamed, { providerProfile: widened }),
      ).toThrow(/cannot widen aws-s3-general-purpose physicalKey\.maxBytes/u);
      const recovered = withS3Capabilities(canonical, {
        providerProfile: defineS3ProviderProfile({
          name: 'valid-after-rejected-widening',
          physicalKey: { maxBytes: 512 },
        }),
      });
      expect(recovered.physicalKey).toEqual({ maxBytes: 512 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      canonical.raw.destroy();
      renamedBase.raw.destroy();
      send.mockRestore();
    }
  });

  it('allows an explicit native profile that narrows every AWS claim', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const narrow = defineS3ProviderProfile({
      name: 'narrow-native-aws',
      physicalKey: { maxBytes: 512 },
      signedUploadPolicy: { contentType: true, sizeRange: false },
      conditionalRead: { etag: true, version: false },
    });
    const driver = createS3StorageDriver({
      adapter,
      providerProfile: narrow,
    });
    const client = new StorageClient('narrow-native', driver);

    try {
      expect(driver.capabilities).toMatchObject({
        conditionalRead: { etag: true, version: false },
        physicalKey: { maxBytes: 512 },
        signedUploadPolicy: { contentType: true, sizeRange: false },
      });
      expect(driver.capabilities.conditionalCreate).toBeUndefined();
      await expect(
        client.upload('x'.repeat(513), 'blocked'),
      ).rejects.toMatchObject({
        code: StorageErrorCode.LIMIT_EXCEEDED,
        permanent: true,
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await client.onApplicationShutdown();
      send.mockRestore();
    }
  });

  it('publishes a frozen Files conditional surface narrowed to the provider profile', () => {
    const base = s3(adapter);
    const narrow = defineS3ProviderProfile({
      name: 'files-exact-read-only',
      physicalKey: { maxBytes: 1024 },
      conditionalRead: { etag: true, version: false },
    });
    try {
      const decorated = withS3Capabilities(base, {
        providerProfile: narrow,
      });

      expect(Object.keys(decorated.conditional ?? {})).toEqual(['exactRead']);
      expect(Object.isFrozen(decorated.conditional)).toBe(true);
      expect(decorated.conditional?.create).toBeUndefined();
      expect(decorated.conditional?.copy).toBeUndefined();
      expect(decorated.conditional?.delete).toBeUndefined();
      expect(decorated.conditional?.replace).toBeUndefined();
    } finally {
      base.raw.destroy();
    }
  });

  it('does not expose a Files conditional upload without guaranteed result ETags', () => {
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base, {
        providerProfile: defineS3ProviderProfile({
          name: 'conditional-create-without-result-etag',
          physicalKey: { maxBytes: 1024 },
          conditionalCreate: { resultEtag: false },
        }),
      });

      expect(decorated.conditionalCreate).toEqual({ resultEtag: false });
      expect(decorated.conditional).toBeUndefined();
    } finally {
      base.raw.destroy();
    }
  });

  it('does not expose direct conditional delete when the profile disables ETag deletion', () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base, {
        providerProfile: defineS3ProviderProfile({
          name: 'conditional-delete-disabled',
          physicalKey: { maxBytes: 1024 },
          conditionalDelete: { etag: false },
        }),
      });

      expect(decorated.conditionalDelete).toBeUndefined();
      expect(decorated.deleteConditional).toBeUndefined();
      expect(decorated.conditional?.delete).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('bridges verified custom-endpoint conditionals through the Files error boundary', async () => {
    const base = s3({
      ...adapter,
      endpoint: 'https://verified.objects.example.test',
    });
    const requests: Array<{
      headers: Record<string, string | undefined>;
      input: { IfMatch?: string; IfNoneMatch?: string; Key?: string };
    }> = [];
    base.raw.middlewareStack.add(
      () => async (arguments_) => {
        const request = arguments_.request as {
          readonly headers?: Record<string, string | undefined>;
        };
        const input = arguments_.input as {
          IfMatch?: string;
          IfNoneMatch?: string;
          Key?: string;
        };
        requests.push({ headers: request.headers ?? {}, input });
        if (input.IfMatch !== undefined) {
          throw Object.assign(new Error('private precondition detail'), {
            $metadata: { httpStatusCode: 412 },
            name: 'PreconditionFailed',
          });
        }
        return {
          output: {
            $metadata: {},
            ...(input.Key !== 'ambiguous.txt' && { ETag: '"created"' }),
          },
          response: { headers: {}, statusCode: 200 },
        } as never;
      },
      {
        name: 'captureVerifiedConditionalRequest',
        priority: 'high',
        step: 'finalizeRequest',
      },
    );
    try {
      expect(base.conditional).toBeUndefined();
      const decorated = withS3Capabilities(base, {
        providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
      });

      expect(Object.keys(decorated.conditional ?? {}).sort()).toEqual([
        'create',
        'exactRead',
        'replace',
      ]);
      expect(decorated.conditional?.copy).toBeUndefined();
      expect(decorated.conditional?.delete).toBeUndefined();
      await expect(
        decorated.conditional?.create?.(
          'stream.txt',
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              controller.close();
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'Provider',
        name: 'FilesError',
        permanent: true,
      });
      expect(requests).toHaveLength(0);
      await expect(
        decorated.conditional?.create?.('created.txt', 'body'),
      ).resolves.toMatchObject({ etag: 'created', key: 'created.txt' });
      await expect(
        decorated.conditional?.replace?.('created.txt', 'changed', 'previous'),
      ).rejects.toMatchObject({
        code: 'Conflict',
        message: 'Storage provider operation conflicted with current state.',
        name: 'FilesError',
        permanent: true,
      });
      await expect(
        decorated.conditional?.create?.('ambiguous.txt', 'body'),
      ).rejects.toMatchObject({
        applied: true,
        code: 'Provider',
        name: 'FilesError',
        permanent: true,
      });

      expect(requests[0]?.input).toMatchObject({
        IfNoneMatch: '*',
        Key: 'created.txt',
      });
      expect(requests[0]?.headers).toHaveProperty('if-none-match', '*');
      expect(requests[1]?.input).toMatchObject({
        IfMatch: '"previous"',
        Key: 'created.txt',
      });
      expect(requests[1]?.headers).toHaveProperty('if-match', '"previous"');
    } finally {
      base.raw.destroy();
    }
  });

  it('cannot widen an adapter that explicitly disables conditional requests', () => {
    const base = s3({
      ...adapter,
      conditional: false,
      endpoint: 'https://disabled.objects.example.test',
    });
    try {
      expect(base.conditional).toBeUndefined();
      expect(() =>
        withS3Capabilities(base, {
          providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
        }),
      ).toThrow(/not constructed with conditional requests enabled/u);
      expect(base.conditional).toBeUndefined();
    } finally {
      base.raw.destroy();
    }
  });

  it('cannot widen an upstream native adapter that disabled conditional requests', () => {
    const base = upstreamS3({ ...adapter, conditional: false });
    try {
      expect(base.conditional).toBeUndefined();
      expect(() => withS3Capabilities(base)).toThrow(
        /not constructed with conditional requests enabled/u,
      );
      expect(base.conditional).toBeUndefined();
    } finally {
      base.raw.destroy();
    }
  });

  it('withholds an explicit custom-endpoint opt-in until a verified profile narrows it', () => {
    const base = s3({
      ...adapter,
      conditional: true,
      endpoint: 'https://opted-in.objects.example.test',
    });
    const narrow = defineS3ProviderProfile({
      name: 'opted-in-exact-read-only',
      physicalKey: { maxBytes: 1024 },
      conditionalRead: { etag: true, version: false },
    });
    try {
      expect(base.conditional).toBeUndefined();
      const decorated = withS3Capabilities(base, {
        providerProfile: narrow,
      });
      expect(Object.keys(decorated.conditional ?? {})).toEqual(['exactRead']);
    } finally {
      base.raw.destroy();
    }
  });

  it('exposes Files conditional copy only for paired predicates allowed by the profile', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const base = s3(adapter);
    const createOnlyCopy = defineS3ProviderProfile({
      name: 'files-create-only-copy',
      physicalKey: { maxBytes: 1024 },
      conditionalCopyDestination: {
        atomicWithSource: true,
        create: true,
        replace: false,
        requiresSourcePredicate: true,
      },
      conditionalCopySource: {
        etag: true,
        requiresDestinationPredicate: true,
        version: false,
      },
    });
    try {
      const decorated = withS3Capabilities(base, {
        providerProfile: createOnlyCopy,
      });

      expect(decorated.conditional?.copy).toMatchObject({
        atomicSourceDestination: true,
        destinationCreate: true,
        destinationReplace: false,
        sourceEtag: true,
      });
      await expect(
        decorated.conditional?.copy?.run('source.txt', 'destination.txt', {
          destination: { etag: 'destination-etag', type: 'replace' },
          source: { etag: 'source-etag' },
        }),
      ).rejects.toMatchObject({ code: 'Provider', permanent: true });
      await expect(
        decorated.promote?.('source.txt', 'destination.txt', {
          sourceEtag: 'source-etag',
        }),
      ).rejects.toMatchObject({
        code: StorageErrorCode.NOT_SUPPORTED,
        permanent: true,
      });
      await expect(
        decorated.promote?.('source.txt', 'destination.txt', {
          destination: { type: 'create' },
        }),
      ).rejects.toMatchObject({
        code: StorageErrorCode.NOT_SUPPORTED,
        permanent: true,
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('does not apply the native AWS key ceiling to an explicitly verified custom endpoint', () => {
    const custom = s3({
      ...adapter,
      endpoint: 'https://audited.objects.example.test',
    });
    try {
      const decorated = withS3Capabilities(custom, {
        providerProfile: defineS3ProviderProfile({
          name: 'custom-larger-key-budget',
          physicalKey: { maxBytes: 2048 },
        }),
      });
      expect(decorated.physicalKey).toEqual({ maxBytes: 2048 });
      expect(decorated.signedUploadPolicy).toEqual({
        contentType: false,
        sizeRange: false,
      });
    } finally {
      custom.raw.destroy();
    }
  });

  it.each([
    ['AWS_ENDPOINT_URL', 'https://global-redirect.invalid'],
    ['AWS_ENDPOINT_URL_S3', 'https://service-redirect.invalid'],
  ] as const)(
    'ignores the configured %s endpoint for inferred native AWS',
    async (variable, redirect) => {
      vi.stubEnv('AWS_ENDPOINT_URL', '');
      vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
      vi.stubEnv('AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'false');
      vi.stubEnv(variable, redirect);

      const base = s3(adapter);
      try {
        withS3Capabilities(base);
        expect(base.raw.config.ignoreConfiguredEndpointUrls).toBe(true);
        expect(await resolvedHeadHostname(base.raw)).toBe(
          'private-bucket.s3.us-east-1.amazonaws.com',
        );
      } finally {
        base.raw.destroy();
      }
      await expectFactoryIgnoresConfiguredEndpoints();
    },
  );

  it.each([
    [
      'profile endpoint_url',
      '[profile endpoint-provenance]\nendpoint_url = https://shared-profile-redirect.invalid\n',
    ],
    [
      'service-specific endpoint_url',
      '[profile endpoint-provenance]\nservices = endpoint-provenance-services\n\n[services endpoint-provenance-services]\ns3 =\n  endpoint_url = https://shared-service-redirect.invalid\n',
    ],
  ] as const)(
    'ignores a shared-config %s for inferred native AWS',
    async (_description, contents) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'nestm-s3-endpoint-provenance-'),
      );
      const configFile = join(directory, 'config');
      await writeFile(configFile, contents, 'utf8');
      vi.stubEnv('AWS_CONFIG_FILE', configFile);
      vi.stubEnv('AWS_PROFILE', 'endpoint-provenance');
      vi.stubEnv('AWS_ENDPOINT_URL', '');
      vi.stubEnv('AWS_ENDPOINT_URL_S3', '');
      vi.stubEnv('AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'false');

      const base = s3(adapter);
      try {
        withS3Capabilities(base);
        expect(base.raw.config.ignoreConfiguredEndpointUrls).toBe(true);
        expect(await resolvedHeadHostname(base.raw)).toBe(
          'private-bucket.s3.us-east-1.amazonaws.com',
        );
        await expectFactoryIgnoresConfiguredEndpoints();
      } finally {
        base.raw.destroy();
        await rm(directory, { force: true, recursive: true });
      }
    },
  );

  it('derives direct-helper endpoint provenance and rejects a declared mismatch', async () => {
    const unverifiedCustom = s3({
      ...adapter,
      endpoint: 'https://audited.objects.example.test',
    });
    const verified = defineS3ProviderProfile({
      name: 'audited-endpoint',
      physicalKey: { maxBytes: 1024 },
      conditionalRead: { etag: true, version: false },
    });
    try {
      const unverified = withS3Capabilities(unverifiedCustom);
      expect(unverified.conditionalCreate).toBeUndefined();
      expect(unverified.conditionalRead).toBeUndefined();
      expect(unverified.conditional).toBeUndefined();
    } finally {
      unverifiedCustom.raw.destroy();
    }

    const auditedCustom = s3({
      ...adapter,
      endpoint: 'https://audited.objects.example.test',
    });
    try {
      const audited = withS3Capabilities(auditedCustom, {
        providerProfile: verified,
      });
      expect(audited.conditionalRead).toEqual({ etag: true, version: false });
      expect(audited.signedUploadPolicy).toEqual({
        contentType: false,
        sizeRange: false,
      });
      expect(await resolvedHeadHostname(auditedCustom.raw)).toBe(
        'private-bucket.audited.objects.example.test',
      );
    } finally {
      auditedCustom.raw.destroy();
    }

    const native = s3(adapter);
    try {
      expect(() =>
        withS3Capabilities(native, {
          endpoint: 'https://undeclared-on-client.invalid',
        }),
      ).toThrow(/does not match the SDK client endpoint provenance/u);
    } finally {
      native.raw.destroy();
    }
  });

  it('retains direct S3 public-URL construction policy when helper options are omitted', () => {
    const publicAdapter = s3({
      ...adapter,
      publicBaseUrl: 'https://cdn.example.test',
    });
    const signedAdapter = s3(adapter);
    const unknownAdapter = upstreamS3({
      ...adapter,
      publicBaseUrl: 'https://foreign-cdn.example.test',
    });
    try {
      expect(withS3Capabilities(publicAdapter).signedDownloadPolicy).toEqual({
        expiresIn: false,
      });
      expect(withS3Capabilities(signedAdapter).signedDownloadPolicy).toEqual({
        expiresIn: true,
      });
      expect(withS3Capabilities(unknownAdapter).signedDownloadPolicy).toEqual({
        expiresIn: false,
      });
    } finally {
      publicAdapter.raw.destroy();
      signedAdapter.raw.destroy();
      unknownAdapter.raw.destroy();
    }
  });

  it('does not export S3 construction-metadata authority', async () => {
    const publicApi = await import('./index.js');

    expect(publicApi).not.toHaveProperty('recordS3AdapterConstructionMetadata');
    expect(publicApi).not.toHaveProperty('recordS3ConstructionMetadata');
  });

  it('forces direct unverified custom helper composition read-only', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('unexpected S3 dispatch') as never);
    const base = s3({
      ...adapter,
      endpoint: 'https://unverified.objects.example.test',
    });
    const client = new StorageClient(
      'direct-unverified-custom',
      createFilesSdkDriver({
        adapter: withS3Capabilities(base),
        readonly: false,
      }),
    );
    try {
      expect(client.capabilities.signedUpload).toBe(false);
      await expect(
        client.upload('blocked.txt', 'blocked'),
      ).rejects.toMatchObject({
        code: StorageErrorCode.READ_ONLY,
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await client.onApplicationShutdown();
      send.mockRestore();
    }
  });

  it.each([
    ['native', undefined],
    ['custom', 'https://raw.objects.example.test'],
  ] as const)(
    'rejects an undecorated raw %s S3 adapter at driver construction',
    (_provenance, endpoint) => {
      const send = vi
        .spyOn(S3Client.prototype, 'send')
        .mockRejectedValue(new Error('unexpected S3 dispatch') as never);
      const base = s3({
        ...adapter,
        ...(endpoint === undefined ? {} : { endpoint }),
      });
      try {
        expect(() =>
          createFilesSdkDriver({ adapter: base, readonly: false }),
        ).toThrow(
          expect.objectContaining({
            code: StorageErrorCode.INVALID_ARGUMENT,
            permanent: true,
          }),
        );
        expect(send).not.toHaveBeenCalled();
      } finally {
        base.raw.destroy();
        send.mockRestore();
      }
    },
  );

  it('rejects a renamed spread alias of an undecorated package S3 adapter', () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('unexpected S3 dispatch') as never);
    const base = s3(adapter);
    const renamed = { ...base, name: 'renamed-s3' };
    try {
      expect(() =>
        createFilesSdkDriver({ adapter: renamed, readonly: false }),
      ).toThrow(
        expect.objectContaining({
          code: StorageErrorCode.INVALID_ARGUMENT,
          permanent: true,
        }),
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('rejects preseeded broad storage extensions before applying a narrow profile', () => {
    const base = Object.assign(s3(adapter), {
      conditionalCreate: { resultEtag: true },
      uploadConditional: vi.fn(),
    });
    const narrow = defineS3ProviderProfile({
      name: 'narrow-read-only',
      physicalKey: { maxBytes: 512 },
      conditionalRead: { etag: true, version: false },
    });
    try {
      expect(() =>
        withS3Capabilities(base, { providerProfile: narrow }),
      ).toThrow(/reserved extension/u);
      expect(() =>
        createFilesSdkDriver({
          adapter: { ...base, name: 'renamed-preseeded-s3' },
        }),
      ).toThrow(
        expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
      );
    } finally {
      base.raw.destroy();
    }
  });

  it('commits no final provenance when capability decoration throws', () => {
    const base = s3(adapter);
    const throwing = new Proxy(base, {
      set() {
        throw new TypeError('decoration blocked');
      },
    });
    try {
      expect(() => withS3Capabilities(throwing)).toThrow('decoration blocked');
      expect(() =>
        createFilesSdkDriver({
          adapter: { ...base, name: 'renamed-partial-s3' },
        }),
      ).toThrow(
        expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
      );
    } finally {
      base.raw.destroy();
    }
  });

  it('commits no final provenance when adapter freezing throws', () => {
    const base = s3(adapter);
    const throwing = new Proxy(base, {
      preventExtensions() {
        throw new TypeError('freeze blocked');
      },
    });
    try {
      expect(() => withS3Capabilities(throwing)).toThrow('freeze blocked');
      expect(() =>
        createFilesSdkDriver({
          adapter: { ...base, name: 'renamed-unfrozen-s3' },
        }),
      ).toThrow(
        expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
      );
    } finally {
      base.raw.destroy();
    }
  });

  it('rejects capability decoration reapplication instead of retaining a broader profile', () => {
    const custom = s3({
      ...adapter,
      endpoint: 'https://audited.objects.example.test',
    });
    const narrow = defineS3ProviderProfile({
      name: 'read-only-audited-endpoint',
      physicalKey: { maxBytes: 1024 },
      conditionalRead: { etag: true, version: false },
    });
    try {
      const broad = withS3Capabilities(custom, {
        providerProfile: AWS_S3_PROVIDER_PROFILE,
      });
      expect(broad.conditionalCreate).toEqual({ resultEtag: true });
      expect(() => withS3Capabilities(custom)).toThrow(
        /may only be applied once/u,
      );
      expect(() =>
        withS3Capabilities(custom, { providerProfile: narrow }),
      ).toThrow(/may only be applied once/u);
      expect(() =>
        withS3Capabilities(new Proxy(custom, {}), {
          providerProfile: narrow,
        }),
      ).toThrow(/may only be applied once/u);
      expect(() =>
        withS3Capabilities({ ...custom }, { providerProfile: narrow }),
      ).toThrow(/may only be applied once/u);
    } finally {
      custom.raw.destroy();
    }
  });

  it('puts source and destination predicates in one prefixed copy request', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter, prefix: 'tenant-a' }),
    );

    await client.promote('staging/a b.png', 'final/image.png', {
      destination: { type: 'create' },
      sourceEtag: 'etag-1',
      sourceVersion: 'version/1',
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect((command as CopyObjectCommand).input).toEqual({
      Bucket: 'private-bucket',
      CopySource:
        'private-bucket/tenant-a%2Fstaging%2Fa%20b.png?versionId=version%2F1',
      CopySourceIfMatch: '"etag-1"',
      IfNoneMatch: '*',
      Key: 'tenant-a/final/image.png',
    });
  });

  it('supports destination-only copy without claiming combined atomicity', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const destinationOnly = defineS3ProviderProfile({
      name: 'destination-only',
      physicalKey: { maxBytes: 512 },
      conditionalCopyDestination: {
        atomicWithSource: false,
        create: true,
        replace: false,
      },
    });
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: { ...adapter, endpoint: 'https://objects.example.test' },
        providerProfile: destinationOnly,
      }),
    );

    await client.promote('source.txt', 'destination.txt', {
      destination: { type: 'create' },
    });
    const destinationCommand = send.mock.calls[0]?.[0];
    expect(destinationCommand).toBeInstanceOf(CopyObjectCommand);
    expect((destinationCommand as CopyObjectCommand).input).toMatchObject({
      CopySource: 'private-bucket/source.txt',
      IfNoneMatch: '*',
      Key: 'destination.txt',
    });
    expect(() =>
      client.promote('source.txt', 'combined.txt', {
        destination: { type: 'create' },
        sourceEtag: 'etag',
      }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.NOT_SUPPORTED }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps prefixed conditional writes and deletes to exact S3 commands', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ ETag: '"next-etag"' } as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter, prefix: 'tenant-a' }),
    );

    await expect(
      client.uploadConditional('notes/a.txt', 'next', {
        condition: { type: 'create' },
        metadata: { owner: 'agent' },
      }),
    ).resolves.toMatchObject({
      etag: 'next-etag',
      key: 'notes/a.txt',
      size: 4,
    });
    await client.uploadConditional('notes/a.txt', 'newer', {
      condition: { etag: 'next-etag', type: 'replace' },
    });
    await client.deleteConditional('notes/a.txt', {
      condition: { etag: 'newer-etag' },
    });

    const [create, replace, remove] = send.mock.calls.map((call) => call[0]);
    expect(create).toBeInstanceOf(PutObjectCommand);
    expect((create as PutObjectCommand).input).toMatchObject({
      Bucket: 'private-bucket',
      IfNoneMatch: '*',
      Key: 'tenant-a/notes/a.txt',
      Metadata: { owner: 'agent' },
    });
    expect(replace).toBeInstanceOf(PutObjectCommand);
    expect((replace as PutObjectCommand).input).toMatchObject({
      IfMatch: '"next-etag"',
      Key: 'tenant-a/notes/a.txt',
    });
    expect(remove).toBeInstanceOf(DeleteObjectCommand);
    expect((remove as DeleteObjectCommand).input).toEqual({
      Bucket: 'private-bucket',
      IfMatch: '"newer-etag"',
      Key: 'tenant-a/notes/a.txt',
    });
  });

  it('downloads only the requested ETag/version and preserves the logical key', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: Readable.from([Buffer.from('exact')]),
      ContentLength: 5,
      ContentType: 'text/plain',
      ETag: '"current"',
    } as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter, prefix: 'tenant-a' }),
    );

    const object = await client.downloadConditional('notes/a.txt', {
      condition: { etag: 'current', version: 'v1' },
      range: { end: 4, start: 0 },
    });

    expect(object.key).toBe('notes/a.txt');
    await expect(new Response(object.body).text()).resolves.toBe('exact');
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: 'private-bucket',
      IfMatch: '"current"',
      Key: 'tenant-a/notes/a.txt',
      Range: 'bytes=0-4',
      VersionId: 'v1',
    });
  });

  it('conditions multipart completion instead of the initial upload', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ UploadId: 'upload-1' } as never)
      .mockResolvedValueOnce({ ETag: '"part-1"' } as never)
      .mockResolvedValueOnce({ ETag: '"complete"' } as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    await expect(
      client.uploadConditional('large.bin', new Uint8Array([1, 2, 3]), {
        condition: { etag: 'previous', type: 'replace' },
        multipart: true,
      }),
    ).resolves.toMatchObject({ etag: 'complete', key: 'large.bin', size: 3 });

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(
      CreateMultipartUploadCommand,
    );
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(UploadPartCommand);
    const complete = send.mock.calls[2]?.[0];
    expect(complete).toBeInstanceOf(CompleteMultipartUploadCommand);
    expect((complete as CompleteMultipartUploadCommand).input).toMatchObject({
      Bucket: 'private-bucket',
      IfMatch: '"previous"',
      Key: 'large.bin',
      UploadId: 'upload-1',
    });
  });

  it('bounds hanging multipart cleanup without caller limits and preserves the original error', async () => {
    vi.useFakeTimers();
    const original = new StorageError('original multipart failure', {
      code: StorageErrorCode.PROVIDER,
      operation: 'upload',
      permanent: true,
    });
    let cleanupSignal: AbortSignal | undefined;
    let signalCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation((async (
        command: unknown,
        options?: { readonly abortSignal?: AbortSignal },
      ) => {
        if (command instanceof CreateMultipartUploadCommand) {
          return { UploadId: 'upload-to-abort' };
        }
        if (command instanceof UploadPartCommand) {
          throw original;
        }
        if (command instanceof AbortMultipartUploadCommand) {
          cleanupSignal = options?.abortSignal;
          signalCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
        throw new Error('Unexpected S3 command.');
      }) as never);
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base);
      const failure = rejectedStorageError(() =>
        decorated.uploadConditional!('cleanup.bin', new Uint8Array([1, 2, 3]), {
          condition: { type: 'create' },
          multipart: true,
        }),
      );

      await cleanupStarted;
      const cleanup = send.mock.calls[2];
      expect(cleanup?.[0]).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(cleanupSignal).toBe(
        (cleanup?.[1] as { readonly abortSignal?: AbortSignal } | undefined)
          ?.abortSignal,
      );
      expect(cleanupSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      const error = await failure;
      expect(cleanupSignal?.aborted).toBe(true);
      expect(error).toBe(original);
    } finally {
      vi.useRealTimers();
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('fails closed when S3 omits or returns a malformed result ETag', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    const invalidProviderEtags = [
      undefined,
      '"stale","current"',
      'W/"weak"',
      '"*"',
      '"etag\\value"',
      '"etag\r\ninjected"',
      '""etag""',
      '"café"',
    ];
    for (const ETag of invalidProviderEtags) {
      send.mockResolvedValueOnce({ ETag } as never);
      await expect(
        client.uploadConditional('ambiguous.txt', 'body', {
          condition: { type: 'create' },
        }),
      ).rejects.toMatchObject({
        applied: true,
        code: StorageErrorCode.PROVIDER,
        permanent: true,
      });
    }
  });

  it('rejects every non-canonical precondition before any S3 request', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const driver = createS3StorageDriver({ adapter });
    const invalidEtags = [
      '*',
      'W/"etag"',
      'w/etag',
      '"etag"',
      '"stale","current"',
      'stale,current',
      'etag\\value',
      ' etag',
      'etag\r\nif-match:*',
      'café',
    ];

    for (const etag of invalidEtags) {
      const operations: Array<() => Promise<unknown>> = [
        () =>
          driver.uploadConditional!('single.txt', 'body', {
            condition: { etag, type: 'replace' },
          }),
        () =>
          driver.uploadConditional!('multipart.txt', 'body', {
            condition: { etag, type: 'replace' },
            multipart: true,
          }),
        () =>
          driver.downloadConditional!('read.txt', {
            condition: { etag },
          }),
        () =>
          driver.deleteConditional!('delete.txt', {
            condition: { etag },
          }),
        () =>
          driver.promote!('source.txt', 'destination.txt', {
            sourceEtag: etag,
          }),
        () =>
          driver.promote!('source.txt', 'destination.txt', {
            destination: { etag, type: 'replace' },
          }),
      ];
      for (const operation of operations) {
        await expect(operation()).rejects.toMatchObject({
          code: StorageErrorCode.INVALID_ARGUMENT,
          permanent: true,
        });
      }
    }

    expect(send).not.toHaveBeenCalled();
  });

  it('keeps unverified endpoints fail-closed and gives R2 its own profile', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const unverified = createS3StorageDriver({
      adapter: { ...adapter, endpoint: 'https://objects.example.test' },
      readonly: false,
    });
    const unverifiedClient = new StorageClient('unverified', unverified);
    const r2 = createS3StorageDriver({
      adapter: {
        ...adapter,
        endpoint: 'https://account.r2.cloudflarestorage.com',
      },
      providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
    });

    expect(unverified.capabilities).toMatchObject({
      physicalKey: { maxBytes: 1024 },
    });
    expect(unverified.capabilities.conditionalCreate).toBeUndefined();
    expect(unverified.capabilities.conditionalRead).toBeUndefined();
    expect(unverified.capabilities.resumableUpload).toBe(false);
    expect(unverified.capabilities.serverSideCopy).toBe(false);
    expect(unverified.capabilities.signedUpload).toBe(false);
    expect(unverified.capabilities.signedUploadPolicy).toBeUndefined();
    expect(unverified.capabilities.nativeUploadProgress).toBe(false);
    await expect(
      unverifiedClient.upload('blocked.txt', 'blocked'),
    ).rejects.toMatchObject({
      code: StorageErrorCode.READ_ONLY,
    });
    await expect(unverifiedClient.delete('blocked.txt')).rejects.toMatchObject({
      code: StorageErrorCode.READ_ONLY,
    });
    await expect(
      unverifiedClient.copy('source.txt', 'copy.txt'),
    ).rejects.toMatchObject({ code: StorageErrorCode.READ_ONLY });
    await expect(
      unverifiedClient.move('source.txt', 'moved.txt'),
    ).rejects.toMatchObject({ code: StorageErrorCode.READ_ONLY });
    await expect(
      unverifiedClient.signUpload('blocked.txt', { expiresIn: 60 }),
    ).rejects.toMatchObject({ code: StorageErrorCode.READ_ONLY });
    expect(() =>
      unverifiedClient.promote('source.txt', 'promoted.txt', {
        destination: { type: 'create' },
      }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.NOT_SUPPORTED }),
    );
    expect(r2.capabilities).toMatchObject({
      conditionalCopySource: { etag: true, version: false },
      conditionalCreate: { resultEtag: true },
      conditionalRead: { etag: true, version: false },
      conditionalReplace: { resultEtag: true },
      physicalKey: { maxBytes: 1024 },
      signedUploadPolicy: { contentType: true, sizeRange: false },
    });
    expect(r2.capabilities.conditionalDelete).toBeUndefined();
    expect(r2.capabilities.conditionalCopyDestination).toBeUndefined();
    expect(r2.capabilities.conditionalMultipartCompletion).toBeUndefined();

    expect(() =>
      new StorageClient('r2', r2).deleteConditional('a.txt', {
        condition: { etag: 'etag' },
      }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.NOT_SUPPORTED }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('binds AWS PUT content type and enforces bounded POST constraints', async () => {
    const client = new StorageClient(
      'aws-signed-upload',
      createS3StorageDriver({ adapter }),
    );

    try {
      const put = await client.signUpload('typed.txt', {
        contentType: 'text/plain',
        expiresIn: 60,
      });
      expect(put).toMatchObject({
        headers: { 'Content-Type': 'text/plain' },
        method: 'PUT',
      });
      expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-type;host',
      );

      const post = await client.signUpload('bounded.txt', {
        contentType: 'text/plain',
        expiresIn: 60,
        maxSize: 1000,
        minSize: 100,
      });
      expect(post.method).toBe('POST');
      if (post.method !== 'POST') throw new Error('Expected signed POST.');
      expect(post.fields['Content-Type']).toBe('text/plain');
      const policy = JSON.parse(
        Buffer.from(post.fields.Policy ?? '', 'base64').toString('utf8'),
      ) as { readonly conditions?: readonly unknown[] };
      expect(policy.conditions).toContainEqual([
        'content-length-range',
        100,
        1000,
      ]);
      expect(policy.conditions).toContainEqual([
        'eq',
        '$Content-Type',
        'text/plain',
      ]);
    } finally {
      await client.onApplicationShutdown();
    }
  });

  it('rejects S3 lower-only ranges and POST key templates before signing', async () => {
    const credentials = vi.fn(async () => ({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    }));
    const directClient = new StorageClient(
      'aws-signed-upload-preflight',
      createS3StorageDriver({
        adapter: { ...adapter, credentials: credentials as never },
      }),
    );
    const prefixedClient = new StorageClient(
      'aws-prefixed-signed-upload-preflight',
      createS3StorageDriver({
        adapter: { ...adapter, credentials: credentials as never },
        prefix: 'tenant',
      }),
    );
    const clients = [directClient, prefixedClient];

    try {
      await expect(
        directClient.signUpload('min-only.txt', {
          expiresIn: 60,
          minSize: 100,
        }),
      ).rejects.toMatchObject({
        code: StorageErrorCode.NOT_SUPPORTED,
        permanent: true,
      });
      for (const client of clients) {
        await expect(
          client.signUpload('${filename}', {
            expiresIn: 60,
            maxSize: 1000,
          }),
        ).rejects.toMatchObject({
          code: StorageErrorCode.INVALID_ARGUMENT,
          permanent: true,
        });
      }
      expect(credentials).not.toHaveBeenCalled();
    } finally {
      await Promise.all(
        clients.map((client) => client.onApplicationShutdown()),
      );
    }
  });

  it('signs R2 PUT content type but rejects unsupported size bounds', async () => {
    const client = new StorageClient(
      'r2-signed-upload',
      createS3StorageDriver({
        adapter: {
          ...adapter,
          endpoint: 'https://account.r2.cloudflarestorage.com',
        },
        providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
      }),
    );
    const boundedCredentials = vi.fn(async () => ({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    }));
    const boundedClient = new StorageClient(
      'r2-bounded-signed-upload',
      createS3StorageDriver({
        adapter: {
          ...adapter,
          credentials: boundedCredentials as never,
          endpoint: 'https://account.r2.cloudflarestorage.com',
        },
        providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
      }),
    );

    try {
      const put = await client.signUpload('typed.txt', {
        contentType: 'text/plain',
        expiresIn: 60,
      });
      expect(put).toMatchObject({
        headers: { 'Content-Type': 'text/plain' },
        method: 'PUT',
      });
      expect(new URL(put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-type;host',
      );
      await expect(
        boundedClient.signUpload('bounded.txt', {
          contentType: 'text/plain',
          expiresIn: 60,
          maxSize: 1000,
        }),
      ).rejects.toMatchObject({
        code: StorageErrorCode.NOT_SUPPORTED,
        permanent: true,
      });
      expect(boundedCredentials).not.toHaveBeenCalled();
    } finally {
      await Promise.all([
        client.onApplicationShutdown(),
        boundedClient.onApplicationShutdown(),
      ]);
    }
  });

  it('rejects requested signed-upload constraints absent from a custom profile', async () => {
    const credentials = vi.fn(async () => ({
      accessKeyId: 'test',
      secretAccessKey: 'test',
    }));
    const client = new StorageClient(
      'custom-signed-upload',
      createS3StorageDriver({
        adapter: {
          ...adapter,
          credentials: credentials as never,
          endpoint: 'https://objects.example.test',
        },
        providerProfile: defineS3ProviderProfile({
          name: 'custom-without-signed-upload-constraints',
          physicalKey: { maxBytes: 1024 },
        }),
      }),
    );

    try {
      await expect(
        client.signUpload('typed.txt', {
          contentType: 'text/plain',
          expiresIn: 60,
        }),
      ).rejects.toMatchObject({
        code: StorageErrorCode.NOT_SUPPORTED,
        permanent: true,
      });
      expect(credentials).not.toHaveBeenCalled();
    } finally {
      await client.onApplicationShutdown();
    }
  });

  it('hides mutation capabilities for readonly stores but retains exact reads', () => {
    const readOnly = createS3StorageDriver({ adapter, readonly: true });

    expect(readOnly.capabilities.conditionalCreate).toBeUndefined();
    expect(readOnly.capabilities.conditionalReplace).toBeUndefined();
    expect(readOnly.capabilities.conditionalDelete).toBeUndefined();
    expect(readOnly.capabilities.conditionalCopySource).toBeUndefined();
    expect(readOnly.capabilities.resumableUpload).toBe(false);
    expect(readOnly.capabilities.serverSideCopy).toBe(false);
    expect(readOnly.capabilities.signedUpload).toBe(false);
    expect(readOnly.capabilities.signedUploadPolicy).toBeUndefined();
    expect(readOnly.capabilities.nativeUploadProgress).toBe(false);
    expect(readOnly.capabilities.conditionalRead).toEqual({
      etag: true,
      version: true,
    });
  });

  it('rejects an over-budget physical key before issuing a provider request', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter, prefix: 'é'.repeat(510) }),
    );

    await expect(client.head('éé')).rejects.toMatchObject({
      code: StorageErrorCode.LIMIT_EXCEEDED,
      permanent: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a malformed destination predicate before issuing a copy', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const driver = createS3StorageDriver({ adapter });

    await expect(
      driver.promote!('source.txt', 'destination.txt', {
        destination: { type: 'invalid' } as never,
      }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.INVALID_ARGUMENT,
      permanent: true,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('validates direct conditional method discriminants and non-empty predicates before dispatch', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base);
      const invalidOperations: Array<() => Promise<unknown>> = [
        () =>
          decorated.downloadConditional!('read.txt', {
            condition: {},
          } as never),
        () =>
          decorated.downloadConditional!('read.txt', {
            condition: { version: '' },
          }),
        () => decorated.promote!('source.txt', 'destination.txt', {}),
        () =>
          decorated.promote!('source.txt', 'destination.txt', {
            sourceVersion: '',
          }),
        () => decorated.uploadConditional!('upload.txt', 'body', {} as never),
        () =>
          decorated.uploadConditional!('upload.txt', 'body', {
            condition: { type: 'invalid' },
          } as never),
        () =>
          decorated.uploadConditional!('upload.txt', 'body', {
            condition: { type: 'replace' },
          } as never),
      ];

      for (const operation of invalidOperations) {
        await expect(operation()).rejects.toMatchObject({
          code: StorageErrorCode.INVALID_ARGUMENT,
          permanent: true,
        });
      }
      expect(send).not.toHaveBeenCalled();
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('normalizes 412, 409, and 404 without retaining provider errors', async () => {
    const providerMessages = [
      'secret 412 provider body',
      'secret 409 provider body',
      'secret 404 provider body',
    ] as const;
    vi.spyOn(S3Client.prototype, 'send')
      .mockRejectedValueOnce(
        Object.assign(new Error(providerMessages[0]), {
          $metadata: { httpStatusCode: 412 },
          name: 'PreconditionFailed',
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(providerMessages[1]), {
          $metadata: { httpStatusCode: 409 },
          name: 'ConditionalRequestConflict',
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error(providerMessages[2]), {
          $metadata: { httpStatusCode: 404 },
          name: 'NoSuchKey',
        }),
      );
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    const precondition = await rejectedStorageError(() =>
      client.uploadConditional('image.png', 'changed', {
        condition: { etag: 'old-etag', type: 'replace' },
      }),
    );
    expect(precondition).toMatchObject({
      code: StorageErrorCode.CONFLICT,
      message: 'Storage provider operation conflicted with current state.',
      permanent: true,
    });
    const concurrent = await rejectedStorageError(() =>
      client.promote('source.png', 'destination.png', {
        sourceEtag: 'old-etag',
      }),
    );
    expect(concurrent).toMatchObject({
      code: StorageErrorCode.CONFLICT,
      message: 'Storage provider operation conflicted with current state.',
      permanent: false,
    });
    const missing = await rejectedStorageError(() =>
      client.downloadConditional('missing.png', {
        condition: { etag: 'old-etag' },
      }),
    );
    expect(missing).toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
      message: 'Storage provider object was not found.',
      permanent: true,
    });

    for (const error of [precondition, concurrent, missing]) {
      expect(error.cause).toBeUndefined();
      const logSafeShape = `${inspect(error, { depth: null })}\n${JSON.stringify({ error })}`;
      for (const providerMessage of providerMessages) {
        expect(logSafeShape).not.toContain(providerMessage);
      }
      expect(logSafeShape).not.toContain('$metadata');
    }
  });

  it('keeps ConditionalRequestConflict retryable through the Files pipeline', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValueOnce(
        Object.assign(new Error('transient conditional race'), {
          $metadata: { httpStatusCode: 409 },
          name: 'ConditionalRequestConflict',
        }),
      )
      .mockResolvedValueOnce({ ETag: '"after-retry"' } as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    await expect(
      client.uploadConditional('retry.txt', 'changed', {
        condition: { etag: 'before', type: 'replace' },
        retries: { backoff: () => 0, max: 1 },
      }),
    ).resolves.toMatchObject({ etag: 'after-retry', key: 'retry.txt' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries ConditionalRequestConflict during a direct multipart completion', async () => {
    const backoff = vi.fn(() => 0);
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ UploadId: 'retry-upload' } as never)
      .mockResolvedValueOnce({ ETag: '"part-1"' } as never)
      .mockRejectedValueOnce(
        Object.assign(new Error('transient multipart race'), {
          $metadata: { httpStatusCode: 409 },
          name: 'ConditionalRequestConflict',
        }),
      )
      .mockResolvedValueOnce({ ETag: '"after-retry"' } as never);
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base);
      await expect(
        decorated.uploadConditional!(
          'retry-multipart.bin',
          new Uint8Array([1, 2, 3]),
          {
            condition: { type: 'create' },
            multipart: true,
            retries: { backoff, max: 1 },
          },
        ),
      ).resolves.toMatchObject({
        etag: 'after-retry',
        key: 'retry-multipart.bin',
      });

      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
        CreateMultipartUploadCommand,
        UploadPartCommand,
        CompleteMultipartUploadCommand,
        CompleteMultipartUploadCommand,
      ]);
      expect(backoff).toHaveBeenCalledOnce();
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('maps cancellation during direct S3 retry backoff to ABORTED', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('transient provider failure') as never);
    const controller = new AbortController();
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base);
      const error = await rejectedStorageError(() =>
        decorated.uploadConditional!('retry-abort.txt', 'body', {
          condition: { type: 'create' },
          retries: {
            backoff: () => {
              setTimeout(() => controller.abort('cancel retry'), 0);
              return 10_000;
            },
            max: 1,
          },
          signal: controller.signal,
        }),
      );

      expect(error).toMatchObject({
        aborted: true,
        code: StorageErrorCode.ABORTED,
        timedOut: false,
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('maps timeout during direct S3 retry backoff to TIMEOUT', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockRejectedValue(new Error('transient provider failure') as never);
    const base = s3(adapter);
    try {
      const decorated = withS3Capabilities(base);
      const error = await rejectedStorageError(() =>
        decorated.uploadConditional!('retry-timeout.txt', 'body', {
          condition: { type: 'create' },
          retries: { backoff: () => 10_000, max: 1 },
          timeout: 20,
        }),
      );

      expect(error).toMatchObject({
        aborted: false,
        code: StorageErrorCode.TIMEOUT,
        timedOut: true,
      });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      base.raw.destroy();
      send.mockRestore();
    }
  });

  it('validates dependent profile capabilities', () => {
    expect(Object.isFrozen(AWS_S3_PROVIDER_PROFILE)).toBe(true);
    const conservativeUpload = defineS3ProviderProfile({
      name: 'default-signed-upload-policy',
      physicalKey: { maxBytes: 1024 },
    });
    expect(conservativeUpload.signedUploadPolicy).toEqual({
      contentType: false,
      sizeRange: false,
    });
    expect(Object.isFrozen(conservativeUpload.signedUploadPolicy)).toBe(true);
    expect(() =>
      createS3StorageDriver({
        adapter: { ...adapter, endpoint: 'https://objects.example.test' },
        providerProfile: {
          name: 'unvalidated-profile',
          physicalKey: { maxBytes: 1024 },
        } as never,
      }),
    ).toThrow(/must be created with defineS3ProviderProfile/u);
    expect(() =>
      defineS3ProviderProfile({
        name: 'incomplete-signed-upload-policy',
        physicalKey: { maxBytes: 1024 },
        signedUploadPolicy: { contentType: true } as never,
      }),
    ).toThrow(/signedUploadPolicy\.sizeRange must be a boolean/u);
    expect(() =>
      defineS3ProviderProfile({
        name: 'incomplete-read',
        physicalKey: { maxBytes: 1024 },
        conditionalRead: { etag: true } as never,
      }),
    ).toThrow(/conditionalRead\.version must be a boolean/u);
    expect(() =>
      defineS3ProviderProfile({
        name: 'invalid-multipart',
        physicalKey: { maxBytes: 1024 },
        conditionalMultipartCompletion: { create: true, replace: false },
      }),
    ).toThrow(/requires conditional create support/u);
    expect(() =>
      defineS3ProviderProfile({
        name: 'empty-atomic-source',
        physicalKey: { maxBytes: 1024 },
        conditionalCopySource: { etag: false, version: false },
        conditionalCopyDestination: {
          atomicWithSource: true,
          create: true,
          replace: false,
        },
      }),
    ).toThrow(/enable at least one source-copy condition/u);
    expect(() =>
      defineS3ProviderProfile({
        name: 'invalid-copy-dependency-flag',
        physicalKey: { maxBytes: 1024 },
        conditionalCopySource: {
          etag: true,
          requiresDestinationPredicate: 'yes',
          version: false,
        } as never,
      }),
    ).toThrow(
      /conditionalCopySource\.requiresDestinationPredicate must be a boolean/u,
    );
    expect(() =>
      defineS3ProviderProfile({
        name: 'invalid-destination-dependency-flag',
        physicalKey: { maxBytes: 1024 },
        conditionalCopyDestination: {
          atomicWithSource: false,
          create: true,
          replace: false,
          requiresSourcePredicate: 'yes',
        } as never,
      }),
    ).toThrow(
      /conditionalCopyDestination\.requiresSourcePredicate must be a boolean/u,
    );
    const dependencyNarrowed = defineS3ProviderProfile({
      name: 'dependency-narrowed-native-profile',
      physicalKey: { maxBytes: 1024 },
      conditionalCopyDestination: {
        atomicWithSource: true,
        create: true,
        replace: false,
        requiresSourcePredicate: true,
      },
      conditionalCopySource: {
        etag: true,
        requiresDestinationPredicate: true,
        version: false,
      },
    });
    expect(dependencyNarrowed.conditionalCopySource).toMatchObject({
      requiresDestinationPredicate: true,
    });
    expect(dependencyNarrowed.conditionalCopyDestination).toMatchObject({
      requiresSourcePredicate: true,
    });
  });

  it('rejects reflected profile-brand forgeries for native and custom endpoints', () => {
    const brand = Object.getOwnPropertySymbols(AWS_S3_PROVIDER_PROFILE)[0];
    expect(brand).toBeDefined();
    const forged = {
      ...AWS_S3_PROVIDER_PROFILE,
      name: 'forged-profile',
      physicalKey: { maxBytes: 1024 },
      signedUploadPolicy: { contentType: true, sizeRange: true },
    };
    Object.defineProperty(forged, brand as symbol, {
      enumerable: false,
      value: true,
    });
    const native = s3(adapter);
    const custom = s3({
      ...adapter,
      endpoint: 'https://objects.example.test',
    });

    try {
      expect(() =>
        withS3Capabilities(native, { providerProfile: forged as never }),
      ).toThrow(/must be created with defineS3ProviderProfile/u);
      expect(() =>
        withS3Capabilities(custom, { providerProfile: forged as never }),
      ).toThrow(/must be created with defineS3ProviderProfile/u);
    } finally {
      native.raw.destroy();
      custom.raw.destroy();
    }
  });

  it('does not claim expiring downloads for a permanent public base URL', () => {
    const driver = createS3StorageDriver({
      adapter: {
        ...adapter,
        publicBaseUrl: 'https://cdn.example.test',
      },
    });

    expect(driver.capabilities.signedDownloadPolicy).toEqual({
      expiresIn: false,
    });
  });
});

import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';

import { StorageClient } from '../../storage.client.js';
import {
  isStorageError,
  StorageErrorCode,
  type StorageError,
} from '../../storage.error.js';
import {
  AWS_S3_PROVIDER_PROFILE,
  CLOUDFLARE_R2_PROVIDER_PROFILE,
  createS3StorageDriver,
  defineS3ProviderProfile,
} from './index.js';

const adapter = {
  bucket: 'private-bucket',
  credentials: {
    accessKeyId: 'test',
    secretAccessKey: 'test',
  },
  region: 'us-east-1',
} as const;

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
        condition: { type: 'create' },
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
      IfNoneMatch: '*',
      Key: 'large.bin',
      UploadId: 'upload-1',
    });
  });

  it('fails closed when S3 omits the advertised result ETag', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({ adapter }),
    );

    await expect(
      client.uploadConditional('ambiguous.txt', 'body', {
        condition: { type: 'create' },
      }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      key: 'ambiguous.txt',
      permanent: true,
    });
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
      message: 'Conditional S3 upload failed.',
      permanent: true,
    });
    const concurrent = await rejectedStorageError(() =>
      client.promote('source.png', 'destination.png', {
        sourceEtag: 'old-etag',
      }),
    );
    expect(concurrent).toMatchObject({
      code: StorageErrorCode.CONFLICT,
      message: 'Conditional S3 copy failed.',
      permanent: false,
    });
    const missing = await rejectedStorageError(() =>
      client.downloadConditional('missing.png', {
        condition: { etag: 'old-etag' },
      }),
    );
    expect(missing).toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
      message: 'Conditional S3 download failed.',
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

  it('validates dependent profile capabilities', () => {
    expect(Object.isFrozen(AWS_S3_PROVIDER_PROFILE)).toBe(true);
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

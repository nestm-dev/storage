import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { StorageClient } from '../../storage.client.js';
import { StorageErrorCode } from '../../storage.error.js';
import { createS3StorageDriver } from './index.js';

describe('createS3StorageDriver', () => {
  it('uses the package-owned S3 adapter and exposes conditional promotion', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
          region: 'us-east-1',
        },
      }),
    );

    expect(client.capabilities.conditionalCopy).toEqual({
      etag: true,
      supported: true,
      version: true,
    });
    expect(client.capabilities.conditionalMutation).toEqual({
      create: true,
      delete: true,
      etag: true,
      replace: true,
    });
    expect(client.capabilities.signedUploadPolicy).toEqual({
      contentType: true,
      sizeRange: true,
    });
    expect(client.capabilities.signedDownloadPolicy).toEqual({
      expiresIn: true,
    });

    await client.promote('staging/a b.png', 'final/image.png', {
      sourceEtag: '"etag-1"',
      sourceVersion: 'version/1',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect((command as CopyObjectCommand).input).toEqual({
      Bucket: 'private-bucket',
      CopySource: 'private-bucket/staging%2Fa%20b.png?versionId=version%2F1',
      CopySourceIfMatch: '"etag-1"',
      Key: 'final/image.png',
    });
  });

  it('maps prefixed conditional mutations to atomic S3 commands', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ ETag: '"next-etag"' } as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
          region: 'us-east-1',
        },
        prefix: 'tenant-a',
      }),
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

  it('fails closed when S3 violates the advertised ETag guarantee', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          region: 'us-east-1',
        },
      }),
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

  it('fails closed for unknown S3-compatible endpoints and readonly stores', () => {
    const compatible = createS3StorageDriver({
      adapter: {
        bucket: 'objects',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        endpoint: 'https://objects.example.test',
        region: 'us-east-1',
      },
    });
    const readOnly = createS3StorageDriver({
      adapter: {
        bucket: 'objects',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
      },
      readonly: true,
    });

    expect(compatible.capabilities.conditionalMutation).toBeUndefined();
    expect(readOnly.capabilities.conditionalMutation).toBeUndefined();
    expect(() =>
      new StorageClient('readonly', readOnly).uploadConditional('a.txt', 'a', {
        condition: { type: 'create' },
      }),
    ).toThrow(
      expect.objectContaining({ code: StorageErrorCode.NOT_SUPPORTED }),
    );
  });

  it('rejects conditional multipart uploads without issuing a request', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          region: 'us-east-1',
        },
      }),
    );

    await expect(
      client.uploadConditional('a.txt', 'a', {
        condition: { type: 'create' },
        multipart: true,
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.NOT_SUPPORTED });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim expiring downloads for a permanent public base URL', () => {
    const driver = createS3StorageDriver({
      adapter: {
        bucket: 'public-bucket',
        credentials: {
          accessKeyId: 'test',
          secretAccessKey: 'test',
        },
        publicBaseUrl: 'https://cdn.example.test',
        region: 'us-east-1',
      },
    });

    expect(driver.capabilities.signedDownloadPolicy).toEqual({
      expiresIn: false,
    });
  });

  it('maps a failed S3 source precondition to a storage conflict', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('source changed'), {
        $metadata: { httpStatusCode: 412 },
        name: 'PreconditionFailed',
      }),
    );
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
          region: 'us-east-1',
        },
      }),
    );

    await expect(
      client.promote('staging/image.png', 'final/image.png', {
        sourceEtag: '"old-etag"',
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
  });

  it('maps failed conditional-mutation preconditions to a storage conflict', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(
      Object.assign(new Error('object changed'), {
        $metadata: { httpStatusCode: 412 },
        name: 'PreconditionFailed',
      }),
    );
    const client = new StorageClient(
      'objects',
      createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
          region: 'us-east-1',
        },
      }),
    );

    await expect(
      client.uploadConditional('image.png', 'changed', {
        condition: { etag: 'old-etag', type: 'replace' },
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
    await expect(
      client.deleteConditional('image.png', {
        condition: { etag: 'old-etag' },
      }),
    ).rejects.toMatchObject({ code: StorageErrorCode.CONFLICT });
  });
});

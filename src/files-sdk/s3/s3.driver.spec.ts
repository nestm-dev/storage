import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
});

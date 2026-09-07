import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createS3StorageDriver } from '../files-sdk/s3/index.js';
import { StorageClient } from '../storage.client.js';
import { StorageStagedContentStore } from './storage-staged-content.js';
import { storageBytesStream } from './storage-streams.js';

const partSize = 5 * 1024 * 1024;
const payloadId = '96843157-6d67-4b9a-9ca8-3d0af899f899';

function setup(conflict = false) {
  const uploaded: Uint8Array[] = [];
  const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (
    command: unknown,
  ) => {
    if (command instanceof CreateMultipartUploadCommand)
      return { UploadId: 'staged-upload' };
    if (command instanceof UploadPartCommand) {
      const body = command.input.Body;
      if (!(body instanceof Uint8Array))
        throw new Error('Expected a bounded byte part.');
      uploaded.push(body);
      return { ETag: `"part-${uploaded.length}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      if (conflict)
        throw Object.assign(new Error('Precondition failed'), {
          $metadata: { httpStatusCode: 412 },
          name: 'PreconditionFailed',
        });
      return { ETag: '"staged-etag"' };
    }
    if (command instanceof AbortMultipartUploadCommand) return {};
    if (command instanceof GetObjectCommand)
      return {
        Body: {
          transformToWebStream: () => Readable.toWeb(Readable.from(uploaded)),
        },
        ContentLength: uploaded.reduce((sum, part) => sum + part.length, 0),
        ETag: '"staged-etag"',
      };
    throw new Error('Unexpected S3 command.');
  }) as typeof S3Client.prototype.send);
  const client = new StorageClient(
    'staged',
    createS3StorageDriver({
      adapter: {
        bucket: 'test-bucket',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
      },
      prefix: 'content',
    }),
  );
  const store = new StorageStagedContentStore<string>({
    client,
    key: (scope, id) => `${scope}/${id}`,
  });
  return { client, send, store, uploaded };
}

describe('S3 staged streaming content', () => {
  it.each([64, partSize + 17])(
    'writes and exactly reads a %i-byte stream using conditional completion',
    async (size) => {
      const { client, send, store, uploaded } = setup();
      const bytes = new Uint8Array(size).fill(42);
      try {
        const receipt = await store.writeReserved(
          'workspace',
          payloadId,
          storageBytesStream(bytes),
        );
        expect(receipt).toEqual({
          payloadId,
          size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          etag: 'staged-etag',
        });
        expect(uploaded.every((part) => part.length <= partSize)).toBe(true);
        expect(uploaded).toHaveLength(Math.ceil(size / partSize));
        const complete = send.mock.calls
          .map(([command]) => command)
          .find((command) => command instanceof CompleteMultipartUploadCommand);
        expect(complete?.input).toMatchObject({
          IfNoneMatch: '*',
          Key: `content/workspace/${payloadId}`,
          UploadId: 'staged-upload',
        });
        const read = await store.read('workspace', receipt);
        expect(
          Buffer.from(await new Response(read).arrayBuffer()).equals(bytes),
        ).toBe(true);
        const get = send.mock.calls.at(-1)?.[0];
        expect(get).toBeInstanceOf(GetObjectCommand);
        expect((get as GetObjectCommand).input.IfMatch).toBe('"staged-etag"');
      } finally {
        await client.onApplicationShutdown();
      }
    },
  );

  it('rejects a create collision and aborts the uncommitted multipart upload', async () => {
    const { client, send, store } = setup(true);
    try {
      await expect(
        store.writeReserved(
          'workspace',
          payloadId,
          storageBytesStream(new Uint8Array([1])),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const commands = send.mock.calls.map(([command]) => command);
      expect(
        commands.filter(
          (command) => command instanceof CompleteMultipartUploadCommand,
        ),
      ).toHaveLength(1);
      expect(commands.at(-1)).toBeInstanceOf(AbortMultipartUploadCommand);
    } finally {
      await client.onApplicationShutdown();
    }
  });
});

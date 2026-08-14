import 'reflect-metadata';

import {
  Controller,
  Injectable,
  Module,
  Put,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  StorageGatewayModule,
  StorageGatewayOperation,
  type StorageGatewayKeyPolicy,
  type StorageGatewayKeyPolicyContext,
  type StorageGatewayMode,
  type StorageGatewayOperationName,
} from '../src/gateway/index.js';
import { StorageModule } from '../src/storage.module.js';
import type { StorageDriver } from '../src/storage.driver.js';
import {
  CLOUDFLARE_R2_PROVIDER_PROFILE,
  createS3StorageDriver,
} from '../src/files-sdk/s3/index.js';
import { createMemoryStorageDriver } from '../src/testing/index.js';

let guardCalls = 0;
const keyPolicyCalls: Array<{
  operation: StorageGatewayOperationName;
  target: StorageGatewayKeyPolicyContext['target'];
}> = [];

const MALFORMED_PROVIDER_ETAGS = [
  '',
  '"etag-a", "etag-b"',
  'etag-a", "etag-b',
  '*',
  'W/"etag"',
  'w/"etag"',
  'unsafe\r\nIf-Match: *',
  '"etag',
  'etag"',
  '""etag""',
  'etag,other',
  'etag\\other',
  ' etag',
  'etag ',
  'x'.repeat(1_025),
] as const;

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    guardCalls += 1;
    return true;
  }
}

@Module({
  providers: [AllowGuard],
  exports: [AllowGuard],
})
class GuardModule {}

@Injectable()
class ScopedKeyPolicy implements StorageGatewayKeyPolicy {
  resolve(context: StorageGatewayKeyPolicyContext): string {
    keyPolicyCalls.push({
      operation: context.operation,
      target: context.target,
    });
    const input = context.input?.value ?? '';
    return `scoped/${input}`;
  }
}

@Module({
  providers: [ScopedKeyPolicy],
  exports: [ScopedKeyPolicy],
})
class KeyPolicyModule {}

@Controller()
class UnrelatedBinaryController {
  @Put('unrelated-binary')
  accept(): { data: { accepted: true } } {
    return { data: { accepted: true } };
  }
}

type AdapterName = 'express' | 'fastify';

async function createApp(
  adapterName: AdapterName,
  maxUploadBytes = 1024,
  gateway: {
    defaultSignedUrlExpiresIn?: number;
    driver?: StorageDriver;
    maxSignedUploadBytes?: number;
    maxSignedUrlExpiresIn?: number;
    mode?: StorageGatewayMode;
    operations?: readonly StorageGatewayOperationName[];
    signedUploadContentTypes?: readonly string[];
  } = {},
): Promise<INestApplication> {
  const storage = StorageModule.forRoot({
    stores: [
      {
        driver:
          gateway.driver ??
          createMemoryStorageDriver({
            adapter: { initial: { 'outside/secret.txt': 'secret' } },
          }),
        name: 'gateway',
      },
    ],
  });
  const module = await Test.createTestingModule({
    controllers: [UnrelatedBinaryController],
    imports: [
      StorageGatewayModule.register({
        ...(gateway.defaultSignedUrlExpiresIn !== undefined && {
          defaultSignedUrlExpiresIn: gateway.defaultSignedUrlExpiresIn,
        }),
        guards: [AllowGuard],
        imports: [storage, GuardModule, KeyPolicyModule],
        keyPolicy: ScopedKeyPolicy,
        maxUploadBytes,
        ...(gateway.maxSignedUploadBytes !== undefined && {
          maxSignedUploadBytes: gateway.maxSignedUploadBytes,
        }),
        ...(gateway.maxSignedUrlExpiresIn !== undefined && {
          maxSignedUrlExpiresIn: gateway.maxSignedUrlExpiresIn,
        }),
        mode: gateway.mode ?? 'proxy',
        operations: gateway.operations ?? [
          StorageGatewayOperation.UPLOAD,
          StorageGatewayOperation.DOWNLOAD,
          StorageGatewayOperation.HEAD,
          StorageGatewayOperation.LIST,
          StorageGatewayOperation.SEARCH,
          StorageGatewayOperation.COPY,
          StorageGatewayOperation.MOVE,
          StorageGatewayOperation.DELETE,
        ],
        ...(gateway.signedUploadContentTypes !== undefined && {
          signedUploadContentTypes: gateway.signedUploadContentTypes,
        }),
        store: 'gateway',
      }),
    ],
  }).compile();
  const adapter =
    adapterName === 'fastify' ? new FastifyAdapter() : new ExpressAdapter();
  const app = module.createNestApplication(adapter, { logger: false });
  await app.init();
  if (adapterName === 'fastify') {
    await app.getHttpAdapter().getInstance().ready();
  }
  return app;
}

describe.each<AdapterName>(['express', 'fastify'])(
  'StorageGatewayModule (%s)',
  (adapterName) => {
    let app: INestApplication;

    beforeAll(async () => {
      guardCalls = 0;
      keyPolicyCalls.length = 0;
      app = await createApp(adapterName);
    });

    afterAll(async () => {
      await app?.close();
    });

    it('proxies byte uploads and downloads through the guarded store', async () => {
      await request(app.getHttpServer())
        .put('/storage/object')
        .query({ key: 'folder/hello.txt' })
        .set('content-type', 'application/octet-stream')
        .set('x-storage-content-type', 'text/plain')
        .send(Buffer.from('hello storage'))
        .expect(200);

      const response = await request(app.getHttpServer())
        .get('/storage/object')
        .query({ key: 'folder/hello.txt' })
        .expect(200);

      expect(response.text).toBe('hello storage');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['content-disposition']).toBe('attachment');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(guardCalls).toBeGreaterThanOrEqual(2);
      expect(
        keyPolicyCalls.some(
          ({ operation, target }) =>
            operation === StorageGatewayOperation.UPLOAD && target === 'key',
        ),
      ).toBe(true);
    });

    it('lists, searches, copies, moves, heads, and deletes allowed objects', async () => {
      const list = await request(app.getHttpServer())
        .get('/storage/list')
        .query({ prefix: 'folder/' })
        .expect(200);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0].key).toBe('scoped/folder/hello.txt');
      const tenantRoot = await request(app.getHttpServer())
        .get('/storage/list')
        .expect(200);
      expect(tenantRoot.body.data.items).toHaveLength(1);
      expect(tenantRoot.body.data.items[0].key).not.toContain('outside/');

      const search = await request(app.getHttpServer())
        .get('/storage/search')
        .query({ pattern: 'folder/*.txt' })
        .expect(200);
      expect(search.body.data).toHaveLength(1);

      await request(app.getHttpServer())
        .post('/storage/copy')
        .send({ from: 'folder/hello.txt', to: 'copy.txt' })
        .expect(201);
      await request(app.getHttpServer())
        .post('/storage/move')
        .send({ from: 'copy.txt', to: 'moved.txt' })
        .expect(201);
      await request(app.getHttpServer())
        .head('/storage/metadata')
        .query({ key: 'moved.txt' })
        .expect('content-length', '13')
        .expect(200);
      await request(app.getHttpServer())
        .delete('/storage/object')
        .query({ key: 'moved.txt' })
        .expect(200);
      expect(keyPolicyCalls).toEqual(
        expect.arrayContaining([
          { operation: StorageGatewayOperation.LIST, target: 'prefix' },
          { operation: StorageGatewayOperation.SEARCH, target: 'pattern' },
          { operation: StorageGatewayOperation.SEARCH, target: 'prefix' },
          { operation: StorageGatewayOperation.COPY, target: 'from' },
          { operation: StorageGatewayOperation.COPY, target: 'to' },
          { operation: StorageGatewayOperation.MOVE, target: 'from' },
          { operation: StorageGatewayOperation.MOVE, target: 'to' },
          { operation: StorageGatewayOperation.HEAD, target: 'key' },
          { operation: StorageGatewayOperation.DELETE, target: 'key' },
        ]),
      );
    });

    it('returns 403 for operations outside the allowlist', async () => {
      const response = await request(app.getHttpServer())
        .post('/storage/sign-upload')
        .send({ expiresIn: 60, key: 'blocked.txt' })
        .expect(403);
      expect(response.body.error.code).toBe('OPERATION_NOT_ALLOWED');
    });

    it('rejects proxy uploads with an ambiguous transport content type', async () => {
      await request(app.getHttpServer())
        .put('/storage/object')
        .query({ key: 'ambiguous.txt' })
        .set('content-type', 'text/plain')
        .send('not an octet stream')
        .expect(400);
    });

    it('rejects ambiguous object paths before the key policy runs', async () => {
      await request(app.getHttpServer())
        .get('/storage/object')
        .query({ key: '../escape.txt' })
        .expect(400);
      await request(app.getHttpServer())
        .get('/storage/list')
        .query({ prefix: 'folder//nested' })
        .expect(400);
    });

    it('caps materialized search results', async () => {
      await request(app.getHttpServer())
        .get('/storage/search')
        .query({ maxResults: 1001, pattern: '*' })
        .expect(400);
      await request(app.getHttpServer())
        .get('/storage/list')
        .query({ limit: 1001 })
        .expect(400);
    });

    it('returns stable public errors without provider diagnostics', async () => {
      const response = await request(app.getHttpServer())
        .get('/storage/object')
        .query({ key: 'missing-sensitive-provider-key.txt' })
        .expect(404);

      expect(response.body.error).toEqual({
        code: 'NOT_FOUND',
        message: 'Storage object was not found.',
      });
    });

    it('quotes canonical provider ETags once and rejects malformed output', async () => {
      const driver = createMemoryStorageDriver({
        adapter: { initial: { 'scoped/etag.txt': 'etag body' } },
      });
      const originalHead = driver.head.bind(driver);
      const originalDownload = driver.download.bind(driver);
      let providerEtag = 'safe-etag';
      driver.head = async (key, options) => ({
        ...(await originalHead(key, options)),
        etag: providerEtag,
      });
      driver.download = async (key, options) => ({
        ...(await originalDownload(key, options)),
        etag: providerEtag,
      });
      const etagApp = await createApp(adapterName, 1024, { driver });

      try {
        const safeHead = await request(etagApp.getHttpServer())
          .head('/storage/metadata')
          .query({ key: 'etag.txt' })
          .expect(200);
        expect(safeHead.headers.etag).toBe('"safe-etag"');

        const safeDownload = await request(etagApp.getHttpServer())
          .get('/storage/object')
          .query({ key: 'etag.txt' })
          .expect(200);
        expect(safeDownload.headers.etag).toBe('"safe-etag"');

        for (const malformed of MALFORMED_PROVIDER_ETAGS) {
          providerEtag = malformed;
          const head = await request(etagApp.getHttpServer())
            .head('/storage/metadata')
            .query({ key: 'etag.txt' })
            .expect(502);
          expect(head.headers.etag).not.toBe(malformed);

          const download = await request(etagApp.getHttpServer())
            .get('/storage/object')
            .query({ key: 'etag.txt' })
            .expect(502);
          expect(download.body.error).toEqual({
            code: 'PROVIDER',
            message: 'Storage provider operation failed.',
          });
          if (malformed.length > 0) {
            expect(download.text).not.toContain(malformed);
          }
        }
      } finally {
        await etagApp.close();
      }
    });

    it.runIf(adapterName === 'fastify')(
      'does not enable raw parsing for unrelated Fastify routes',
      async () => {
        await request(app.getHttpServer())
          .put('/unrelated-binary')
          .set('content-type', 'application/octet-stream')
          .send(Buffer.from('unbounded elsewhere'))
          .expect(415);
      },
    );
  },
);

describe.each<AdapterName>(['express', 'fastify'])(
  'StorageGatewayModule signed S3 policies (%s)',
  (adapterName) => {
    it('returns only provider-enforced upload and download policies', async () => {
      const app = await createApp(adapterName, 1024, {
        defaultSignedUrlExpiresIn: 60,
        driver: createS3StorageDriver({
          adapter: {
            bucket: 'private-bucket',
            credentials: {
              accessKeyId: 'test',
              secretAccessKey: 'test',
            },
            region: 'us-east-1',
          },
        }),
        maxSignedUploadBytes: 8,
        maxSignedUrlExpiresIn: 60,
        mode: 'signed',
        operations: [
          StorageGatewayOperation.SIGN_DOWNLOAD,
          StorageGatewayOperation.SIGN_UPLOAD,
        ],
        signedUploadContentTypes: ['image/png'],
      });
      try {
        const upload = await request(app.getHttpServer())
          .post('/storage/sign-upload')
          .send({ contentType: 'image/png', key: 'image.png', maxSize: 8 })
          .expect(201);
        expect(upload.body.data.method).toBe('POST');
        expect(upload.body.data.fields['Content-Type']).toBe('image/png');

        const download = await request(app.getHttpServer())
          .post('/storage/sign-download')
          .send({ expiresIn: 60, key: 'image.png' })
          .expect(201);
        const url = new URL(download.body.data.url);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      } finally {
        await app.close();
      }
    });

    it('refuses to mint an R2 POST upload when size limits are not provider-enforced', async () => {
      const driver = createS3StorageDriver({
        adapter: {
          bucket: 'private-bucket',
          credentials: {
            accessKeyId: 'test',
            secretAccessKey: 'test',
          },
          endpoint: 'https://account.r2.cloudflarestorage.com',
          region: 'auto',
        },
        providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
      });
      const signUpload = vi.spyOn(driver, 'signUpload');
      const app = await createApp(adapterName, 1024, {
        defaultSignedUrlExpiresIn: 60,
        driver,
        maxSignedUploadBytes: 8,
        maxSignedUrlExpiresIn: 60,
        mode: 'signed',
        operations: [StorageGatewayOperation.SIGN_UPLOAD],
        signedUploadContentTypes: ['image/png'],
      });
      try {
        const response = await request(app.getHttpServer())
          .post('/storage/sign-upload')
          .send({ contentType: 'image/png', key: 'image.png', maxSize: 8 })
          .expect(501);
        expect(response.body.error.code).toBe('NOT_SUPPORTED');
        expect(driver.capabilities.signedUploadPolicy).toEqual({
          contentType: true,
          sizeRange: false,
        });
        expect(signUpload).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it('rejects AWS POST filename templates after key scoping', async () => {
      const credentials = vi.fn(async () => ({
        accessKeyId: 'test',
        secretAccessKey: 'test',
      }));
      const app = await createApp(adapterName, 1024, {
        defaultSignedUrlExpiresIn: 60,
        driver: createS3StorageDriver({
          adapter: {
            bucket: 'private-bucket',
            credentials: credentials as never,
            region: 'us-east-1',
          },
        }),
        maxSignedUploadBytes: 8,
        maxSignedUrlExpiresIn: 60,
        mode: 'signed',
        operations: [StorageGatewayOperation.SIGN_UPLOAD],
        signedUploadContentTypes: ['image/png'],
      });
      try {
        const response = await request(app.getHttpServer())
          .post('/storage/sign-upload')
          .send({
            contentType: 'image/png',
            key: '${filename}',
            maxSize: 8,
          })
          .expect(400);
        expect(response.body.error.code).toBe('INVALID_ARGUMENT');
        expect(credentials).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  },
);

describe('StorageGatewayModule security defaults', () => {
  it('rejects registration without a guard or explicit development override', () => {
    expect(() =>
      StorageGatewayModule.register({
        operations: [StorageGatewayOperation.DOWNLOAD],
      }),
    ).toThrow('requires at least one Nest guard');
  });

  it('rejects invalid runtime modes instead of falling back', () => {
    expect(() =>
      StorageGatewayModule.register({
        allowUnauthenticated: true,
        mode: 'signned' as 'signed',
        operations: [StorageGatewayOperation.DOWNLOAD],
        unsafeAllowUnscopedKeys: true,
      }),
    ).toThrow('Unknown storage gateway mode');
  });

  it('requires a key policy or the explicitly unsafe migration escape hatch', () => {
    expect(() =>
      StorageGatewayModule.register({
        allowUnauthenticated: true,
        operations: [StorageGatewayOperation.DOWNLOAD],
      }),
    ).toThrow('requires a keyPolicy');

    expect(() =>
      StorageGatewayModule.register({
        allowUnauthenticated: true,
        keyPolicy: ScopedKeyPolicy,
        operations: [StorageGatewayOperation.DOWNLOAD],
        unsafeAllowUnscopedKeys: true,
      }),
    ).toThrow('cannot combine keyPolicy');
  });

  it('hard-caps signed URL expiry, upload size, and upload MIME', async () => {
    const app = await createApp('express', 1024, {
      defaultSignedUrlExpiresIn: 60,
      maxSignedUploadBytes: 8,
      maxSignedUrlExpiresIn: 60,
      mode: 'signed',
      operations: [
        StorageGatewayOperation.SIGN_DOWNLOAD,
        StorageGatewayOperation.SIGN_UPLOAD,
      ],
      signedUploadContentTypes: ['image/png'],
    });
    try {
      await request(app.getHttpServer())
        .post('/storage/sign-download')
        .send({ expiresIn: 61, key: 'image.png' })
        .expect(400);
      await request(app.getHttpServer())
        .post('/storage/sign-download')
        .send({
          expiresIn: 60,
          key: 'image.png',
          responseContentDisposition: 'attachment\r\nx-injected: yes',
        })
        .expect(400);
      const unsupportedDownload = await request(app.getHttpServer())
        .post('/storage/sign-download')
        .send({
          expiresIn: 60,
          key: 'image.png',
          responseContentDisposition: 'attachment',
        })
        .expect(501);
      expect(unsupportedDownload.body.error.code).toBe('NOT_SUPPORTED');
      await request(app.getHttpServer())
        .post('/storage/sign-upload')
        .send({ contentType: 'text/html', key: 'image.png', maxSize: 8 })
        .expect(400);
      await request(app.getHttpServer())
        .post('/storage/sign-upload')
        .send({ contentType: 'image/png', key: 'image.png', maxSize: 9 })
        .expect(413);
      await request(app.getHttpServer())
        .post('/storage/sign-upload')
        .send({ key: 'image.png', maxSize: 8 })
        .expect(400);
      const unsupported = await request(app.getHttpServer())
        .post('/storage/sign-upload')
        .send({ contentType: 'image/png', key: 'image.png', maxSize: 8 })
        .expect(501);
      expect(unsupported.body.error.code).toBe('NOT_SUPPORTED');
    } finally {
      await app.close();
    }
  });

  it('enforces the streaming upload limit', async () => {
    const app = await createApp('express', 4);
    try {
      const response = await request(app.getHttpServer())
        .put('/storage/object')
        .query({ key: 'large.bin' })
        .set('content-type', 'application/octet-stream')
        .send(Buffer.from('12345'))
        .expect(413);
      expect(response.body.error.code).toBe('LIMIT_EXCEEDED');
    } finally {
      await app.close();
    }
  });
});

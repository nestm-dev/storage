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
} from '../src/gateway/index.js';
import { StorageModule } from '../src/storage.module.js';
import { createMemoryStorageDriver } from '../src/testing/index.js';

let guardCalls = 0;

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
): Promise<INestApplication> {
  const storage = StorageModule.forRoot({
    stores: [
      {
        driver: createMemoryStorageDriver(),
        name: 'gateway',
      },
    ],
  });
  const module = await Test.createTestingModule({
    controllers: [UnrelatedBinaryController],
    imports: [
      StorageGatewayModule.register({
        guards: [AllowGuard],
        imports: [storage, GuardModule],
        maxUploadBytes,
        mode: 'proxy',
        operations: [
          StorageGatewayOperation.UPLOAD,
          StorageGatewayOperation.DOWNLOAD,
          StorageGatewayOperation.HEAD,
          StorageGatewayOperation.LIST,
          StorageGatewayOperation.SEARCH,
          StorageGatewayOperation.COPY,
          StorageGatewayOperation.MOVE,
          StorageGatewayOperation.DELETE,
        ],
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
    });

    it('lists, searches, copies, moves, heads, and deletes allowed objects', async () => {
      const list = await request(app.getHttpServer())
        .get('/storage/list')
        .query({ prefix: 'folder/' })
        .expect(200);
      expect(list.body.data.items).toHaveLength(1);

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
      }),
    ).toThrow('Unknown storage gateway mode');
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

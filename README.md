# @nestm/storage

Framework-neutral storage clients with NestJS 12 integration, named stores,
explicit streaming I/O, cross-store workflows, and an optional guarded HTTP
gateway.

The package uses [`files-sdk`](https://github.com/haydenbleasel/files-sdk) as
its provider engine, but owns the API injected into Nest applications. Provider
SDK types, errors, and `files.raw` do not leak through the root package.

> This package targets the NestJS 12 prerelease line and is itself published on
> the `alpha` dist-tag.

## Requirements

- Node.js 22.12 or newer
- ESM

The framework-neutral `@nestm/storage/core` entry point does not require
NestJS. The root entry point and HTTP gateway additionally require NestJS
`12.0.0-alpha.5` or newer in the Nest 12 prerelease line, `reflect-metadata`,
and RxJS. Those framework peers are optional at installation time so core-only
consumers do not download NestJS.

## Install

```sh
pnpm add @nestm/storage@alpha files-sdk@2.2.2
```

Install only the native SDKs required by the chosen provider. For example:

```sh
# S3 and S3-compatible providers
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-presigned-post \
  @aws-sdk/s3-request-presigner @aws-sdk/lib-storage

# Google Cloud Storage
pnpm add @google-cloud/storage google-auth-library

# Azure Blob Storage
pnpm add @azure/storage-blob @azure/core-auth @azure/identity
```

`files-sdk` currently declares its optional Nest peer for Nest 10 and 11. This
library does not import `files-sdk/nestjs`; the Nest 12 integration is entirely
owned here. A package manager may nevertheless report that temporary optional
peer mismatch while Nest 12 remains prerelease.

NestJS 12 alpha also has prerelease peer declarations that npm may reject under
its strict resolver. If npm reports an `ERESOLVE` error for Nest's own peers,
install with `npm install --legacy-peer-deps`; pnpm works with the repository's
checked-in peer-version policy.

## Framework-neutral core

Import storage primitives from `@nestm/storage/core` in workers, scripts, and
applications that do not use NestJS:

```ts
import {
  StorageClient,
  type StorageDriver,
  type StorageUploadOptions,
} from '@nestm/storage/core';

declare const driver: StorageDriver;

const media = new StorageClient('media', driver);

await media.upload('avatars/user.png', image, {
  contentType: 'image/png',
} satisfies StorageUploadOptions);

await media.onApplicationShutdown();
```

The core entry point exports `StorageClient`, the `StorageDriver` contract,
storage errors and operation types, and `StorageUploadControl`. It has no NestJS
runtime or declaration imports. Provider adapters remain available through
`@nestm/storage/files-sdk`.

## Configure named stores

Create provider adapters with `files-sdk`, wrap them through the explicit
bridge, and register the resulting drivers:

```ts
import { Module } from '@nestjs/common';
import { s3 } from 'files-sdk/s3';
import { gcs } from 'files-sdk/gcs';
import { createFilesSdkDriver } from '@nestm/storage/files-sdk';
import { StorageModule } from '@nestm/storage';

export const StorageKey = {
  MEDIA: 'media',
  ARCHIVE: 'archive',
} as const;

@Module({
  imports: [
    StorageModule.forRoot({
      default: StorageKey.MEDIA,
      stores: [
        {
          name: StorageKey.MEDIA,
          driver: createFilesSdkDriver({
            adapter: s3({
              bucket: 'media',
              region: 'us-east-1',
            }),
          }),
        },
        {
          name: StorageKey.ARCHIVE,
          driver: createFilesSdkDriver({
            adapter: gcs({
              bucket: 'archive',
            }),
          }),
        },
      ],
    }),
  ],
  exports: [StorageModule],
})
export class AppStorageModule {}
```

`StorageModule` is not global by default. Import the configured module wherever
its exports are needed, re-export it from an infrastructure module as above, or
set `isGlobal: true` deliberately.

Inject one store directly:

```ts
import { Injectable } from '@nestjs/common';
import { InjectStorage, type StorageClient } from '@nestm/storage';

@Injectable()
export class AvatarService {
  constructor(
    @InjectStorage(StorageKey.MEDIA)
    private readonly media: StorageClient,
  ) {}

  upload(userId: string, body: ReadableStream<Uint8Array>) {
    return this.media.upload(`avatars/${userId}.png`, body, {
      contentType: 'image/png',
      multipart: true,
    });
  }
}
```

Or select stores through the manager:

```ts
import { Injectable } from '@nestjs/common';
import { StorageService } from '@nestm/storage';

@Injectable()
export class ArchiveService {
  constructor(private readonly storage: StorageService) {}

  async archive(key: string) {
    const object = await this.storage.use(StorageKey.MEDIA).downloadStream(key);
    return this.storage
      .use(StorageKey.ARCHIVE)
      .upload(`retained/${key}`, object.body, {
        contentType: object.contentType,
        ...(object.metadata !== undefined && {
          metadata: object.metadata,
        }),
      });
  }
}
```

`storage.use()` selects the configured default. When several stores are
registered without `default`, callers must pass a name.

### Async registration

Store names remain static because Nest must create their injection tokens
before an async factory runs:

```ts
StorageModule.forRootAsync({
  default: 'media',
  imports: [ConfigModule],
  stores: [
    {
      name: 'media',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createFilesSdkDriver({
          adapter: s3({
            bucket: config.getOrThrow('MEDIA_BUCKET'),
            region: config.getOrThrow('AWS_REGION'),
          }),
        }),
    },
  ],
});
```

`useClass` and `useExisting` are also supported through
`StorageDriverFactory#createStorageDriver(name)`. Feature-owned stores use the
same shapes through `forFeature()` and `forFeatureAsync()` and export only
their named `@InjectStorage(name)` clients; the root `StorageService` remains
isolated to the stores declared by `forRoot`.

Duplicate names within one registration fail immediately. Separate feature
modules retain their own DI scope rather than mutating an application-wide
registry. Names are case-sensitive and cannot contain leading or trailing
whitespace.

## Storage API

`StorageClient` exposes:

- `upload`, `downloadStream`, `head`, `exists`, `delete`, `copy`, and `move`;
- `list`, cursor-aware `listAll`, and lazy `search`;
- `signDownload` and discriminated PUT/POST `signUpload`;
- `uploadMany`, `downloadMany`, `headMany`, `existsMany`, and `deleteMany`;
- `file(key)` handles;
- provider capability inspection; and
- pause/resume/abort through `StorageUploadControl`.

Downloads are streaming by default:

```ts
const object = await storage.use('media').downloadStream('video.mp4');
// object.body is a Web ReadableStream<Uint8Array>
```

The explicit `downloadBytes`, `downloadText`, and `downloadJson` helpers default
to a 10 MiB in-memory limit:

```ts
const manifest = await storage
  .use('media')
  .downloadJson<{ version: number }>('manifest.json', {
    maxBytes: 256 * 1024,
  });
```

Node `Readable` uploads are accepted and converted to Web streams without
buffering. Provider capability gaps fail closed with `StorageError` rather than
silently discarding a range, metadata, or cache-control request.

### Resumable uploads

```ts
import { StorageUploadControl } from '@nestm/storage';

const control = new StorageUploadControl();
const upload = media.upload('large.bin', file, {
  control,
  multipart: { partSize: 8 * 1024 * 1024, concurrency: 4 },
});

control.pause();
const token = control.toJSON(); // opaque and JSON-serializable
control.resume();
await upload;
```

Persisted tokens are intentionally opaque and versioned. Restore one with
`StorageUploadControl.from(token)`. Resumable uploads require a repeatable,
known-length body; a one-shot stream cannot be resumed.

### Cross-store transfer and sync

```ts
await storage.transfer({
  from: 'media',
  to: 'archive',
  prefix: 'uploads/',
  concurrency: 4,
});

const preview = await storage.sync({
  from: 'media',
  to: 'archive',
  compare: 'size',
  prune: true,
  dryRun: true,
});
```

Object bodies stream directly between stores. Key lists and metadata are
collected to provide deterministic progress and sync plans. Partial failures
are returned in `errors`. `prune: true` is destructive; use `dryRun` first and
scope the destination with `destinationPrefix`.

## Optional HTTP gateway

The gateway lives at `@nestm/storage/gateway` and is never mounted by
`StorageModule`.

```ts
import { Module } from '@nestjs/common';
import {
  StorageGatewayModule,
  StorageGatewayOperation,
} from '@nestm/storage/gateway';

@Module({
  imports: [
    AppStorageModule,
    AuthModule,
    StorageGatewayModule.register({
      imports: [AppStorageModule, AuthModule],
      store: 'media',
      guards: [JwtAuthGuard],
      mode: 'hybrid',
      operations: [
        StorageGatewayOperation.DOWNLOAD,
        StorageGatewayOperation.UPLOAD,
        StorageGatewayOperation.HEAD,
        StorageGatewayOperation.LIST,
        StorageGatewayOperation.SIGN_DOWNLOAD,
        StorageGatewayOperation.SIGN_UPLOAD,
      ],
      maxUploadBytes: 100 * 1024 * 1024,
      maxListResults: 1000,
      maxSearchResults: 1000,
      proxyInlineContentTypes: ['image/jpeg', 'image/png'],
    }),
  ],
})
export class AppModule {}
```

Registration fails without at least one existing Nest guard. The only bypass is
the explicit `allowUnauthenticated: true` development escape hatch. Operations
are deny-by-default and must be allowlisted individually.

Proxy downloads default to `Content-Disposition: attachment` and always send
`X-Content-Type-Options: nosniff`. Add only trusted, non-active MIME types to
`proxyInlineContentTypes` when browser rendering is required. Search responses
are capped by `maxSearchResults`, and list pages by `maxListResults` (both
1,000 by default).

The fixed gateway prefix is `/storage`:

| Method   | Path                        | Operation                            |
| -------- | --------------------------- | ------------------------------------ |
| `GET`    | `/storage/object?key=...`   | signed redirect or streamed download |
| `PUT`    | `/storage/object?key=...`   | streamed proxy upload                |
| `HEAD`   | `/storage/metadata?key=...` | object metadata                      |
| `DELETE` | `/storage/object?key=...`   | delete                               |
| `GET`    | `/storage/list`             | list one page                        |
| `GET`    | `/storage/search`           | search keys                          |
| `POST`   | `/storage/sign-download`    | sign download                        |
| `POST`   | `/storage/sign-upload`      | sign direct upload                   |
| `POST`   | `/storage/copy`             | copy                                 |
| `POST`   | `/storage/move`             | move                                 |

Proxy uploads use `Content-Type: application/octet-stream`; put the stored MIME
type in `X-Storage-Content-Type`. This keeps Express and Fastify uploads as raw
streams and avoids global body-parser changes. Generic multipart/form-data is
not mounted by the gateway—prefer direct signed uploads or handle form parsing
in an application controller.

If an application has already registered an
`application/octet-stream` parser, the gateway leaves it in place; that parser
must enforce its own body limit and expose either a byte buffer or readable
stream. Without an existing parser, the built-in Fastify parser is restricted
to the marked gateway upload route.

`hybrid` mode prefers a signed download when both `download` and
`signDownload` are allowed and the provider advertises support, then uses the
streaming proxy when signing is unavailable. `proxy` disables signing routes;
`signed` disables proxy uploads and downloads.

## Errors and capabilities

Every thrown engine/provider failure is normalized to `StorageError`. Branch on
`error.code`, not provider classes:

```ts
import { isStorageError, StorageErrorCode } from '@nestm/storage';

try {
  await media.head(key);
} catch (error) {
  if (isStorageError(error) && error.code === StorageErrorCode.NOT_FOUND) {
    return null;
  }
  throw error;
}
```

Capability flags cover range reads, native byte-level upload progress,
delimiter listing, metadata, cache control, resumable uploads, server-side
copy, and signed transfers.
Provider-specific native clients are intentionally not exposed from the root
package.

## Local and in-memory stores

The test helper wraps the `files-sdk` in-memory adapter:

```ts
import { createMemoryStorageDriver } from '@nestm/storage/testing';

StorageModule.forRoot({
  stores: [{ name: 'test', driver: createMemoryStorageDriver() }],
});
```

For local filesystem storage, import `fs` from `files-sdk/fs` and pass it to
`createFilesSdkDriver` exactly like a cloud adapter.

## License

MIT

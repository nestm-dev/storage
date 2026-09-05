import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeMajor = Number.parseInt(
  process.versions.node.split('.')[0] ?? '',
  10,
);

if (!Number.isSafeInteger(nodeMajor) || nodeMajor < 24) {
  throw new Error(
    'The packed core consumer test requires Node.js 24 or newer.',
  );
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'nestm-storage-core-'));
const consumerRoot = join(temporaryRoot, 'consumer');
const tarballPath = join(temporaryRoot, 'nestm-storage.tgz');
const rootPackage = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8'),
);
const awsPeerNames = [
  '@aws-sdk/client-s3',
  '@aws-sdk/lib-storage',
  '@aws-sdk/s3-presigned-post',
  '@aws-sdk/s3-request-presigner',
];
const minimumAwsPeerVersions = Object.fromEntries(
  awsPeerNames.map((name) => [
    name,
    caretMinimum(rootPackage.peerDependencies?.[name], name),
  ]),
);

try {
  run('pnpm', ['pack', '--out', tarballPath], projectRoot);

  mkdirSync(join(consumerRoot, 'src'), { recursive: true });
  writeFileSync(
    join(consumerRoot, 'src/file-workflow-smoke.ts'),
    readFileSync(
      join(projectRoot, 'scripts/fixtures/file-workflow-consumer.ts'),
      'utf8',
    ),
  );
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@nestm/storage-core-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@aws-sdk/client-s3': minimumAwsPeerVersions['@aws-sdk/client-s3'],
          '@aws-sdk/lib-storage':
            minimumAwsPeerVersions['@aws-sdk/lib-storage'],
          '@aws-sdk/s3-presigned-post':
            minimumAwsPeerVersions['@aws-sdk/s3-presigned-post'],
          '@aws-sdk/s3-request-presigner':
            minimumAwsPeerVersions['@aws-sdk/s3-request-presigner'],
          '@nestm/storage': `file:${tarballPath}`,
        },
        devDependencies: {
          '@types/node': rootPackage.devDependencies['@types/node'],
          typescript: rootPackage.devDependencies.typescript,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          exactOptionalPropertyTypes: true,
          isolatedModules: true,
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noUncheckedIndexedAccess: true,
          outDir: 'dist',
          rootDir: 'src',
          skipLibCheck: false,
          strict: true,
          target: 'ES2023',
          types: ['node'],
          verbatimModuleSyntax: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(consumerRoot, 'src', 'smoke.ts'), getConsumerSource());
  writeFileSync(
    join(consumerRoot, 's3-minimum-peer.mjs'),
    getS3MinimumPeerSource(minimumAwsPeerVersions),
  );

  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    consumerRoot,
  );

  if (existsSync(join(consumerRoot, 'node_modules', '@nestjs'))) {
    throw new Error('The core-only consumer unexpectedly installed NestJS.');
  }

  run('npm', ['exec', '--', 'tsc', '-p', '.'], consumerRoot);
  run(process.execPath, ['dist/smoke.js'], consumerRoot);
  run(process.execPath, ['dist/file-workflow-smoke.js'], consumerRoot);
  run(process.execPath, ['s3-minimum-peer.mjs'], consumerRoot);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}

function run(command, arguments_, cwd) {
  execFileSync(command, arguments_, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
}

function caretMinimum(range, packageName) {
  const match = /^\^(\d+\.\d+\.\d+)$/.exec(range ?? '');
  if (match?.[1] === undefined) {
    throw new Error(
      `${packageName} must use one exact caret peer range for the packed minimum-peer test.`,
    );
  }
  return match[1];
}

function getConsumerSource() {
  return `import assert from 'node:assert/strict';

import {
  DEFAULT_BUFFER_LIMIT,
  StorageClient,
  StorageErrorCode,
  StorageUploadControl,
  isStorageError,
  type StorageCapabilities,
  type StorageDriver,
  type StorageObjectMetadata,
} from '@nestm/storage/core';
import { createS3StorageDriver } from '@nestm/storage/files-sdk/s3';
import {
  Aes256GcmStorageWorkspaceCursorCodec,
  STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
  mountStorageWorkspace,
} from '@nestm/storage/workspace';

const capabilities = {
  cacheControl: true,
  delimiter: true,
  metadata: true,
  nativeUploadProgress: false,
  rangeRead: false,
  resumableUpload: false,
  serverSideCopy: true,
  signedDownload: { supported: true },
  signedUpload: true,
} satisfies StorageCapabilities;
const objects = new Map<string, { body: Uint8Array; contentType: string }>();
let closeCalls = 0;

function metadata(key: string): StorageObjectMetadata {
  const stored = objects.get(key);
  if (stored === undefined) {
    throw new Error(\`Missing object: \${key}\`);
  }
  return {
    contentType: stored.contentType,
    key,
    name: key.split('/').at(-1) ?? key,
    size: stored.body.byteLength,
  };
}

function createDriver(): StorageDriver {
  return {
    capabilities,
    name: 'packed-memory',
    async upload(key, body, options) {
      if (typeof body !== 'string') {
        throw new TypeError('The smoke driver accepts string bodies only.');
      }
      const stored = {
        body: new TextEncoder().encode(body),
        contentType: options?.contentType ?? 'application/octet-stream',
      };
      objects.set(key, stored);
      return {
        contentType: stored.contentType,
        key,
        size: stored.body.byteLength,
      };
    },
    async download(key) {
      const object = metadata(key);
      const stored = objects.get(key);
      assert.ok(stored);
      return {
        ...object,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(stored.body);
            controller.close();
          },
        }),
      };
    },
    async head(key) {
      return metadata(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async delete(key) {
      objects.delete(key);
    },
    async copy(sourceKey, destinationKey) {
      const source = objects.get(sourceKey);
      if (source === undefined) {
        throw new Error(\`Missing object: \${sourceKey}\`);
      }
      objects.set(destinationKey, {
        body: source.body.slice(),
        contentType: source.contentType,
      });
    },
    async move(sourceKey, destinationKey) {
      const source = objects.get(sourceKey);
      if (source === undefined) {
        throw new Error(\`Missing object: \${sourceKey}\`);
      }
      objects.set(destinationKey, source);
      objects.delete(sourceKey);
    },
    async list(options) {
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .toSorted();
      const startIndex =
        options?.cursor === undefined
          ? 0
          : keys.findIndex((key) => key > options.cursor!);
      const start = startIndex < 0 ? keys.length : startIndex;
      const limit = options?.limit ?? 1_000;
      const selected = keys.slice(start, start + limit);
      const lastKey = selected.at(-1);
      return {
        items: selected.map(metadata),
        ...(lastKey !== undefined && start + selected.length < keys.length
          ? { cursor: lastKey }
          : {}),
      };
    },
    async *search(pattern, options) {
      const expression =
        pattern instanceof RegExp ? pattern : new RegExp(pattern.replace('*', '.*'));
      for (const key of objects.keys()) {
        if (!key.startsWith(options?.prefix ?? '')) {
          continue;
        }
        const object = metadata(key);
        if (expression.test(object.key)) {
          yield object;
        }
      }
    },
    async signDownload(key) {
      return \`https://storage.invalid/download/\${encodeURIComponent(key)}\`;
    },
    async signUpload(key) {
      return {
        method: 'PUT',
        url: \`https://storage.invalid/upload/\${encodeURIComponent(key)}\`,
      };
    },
    async close() {
      closeCalls += 1;
    },
  } satisfies StorageDriver;
}

const driver = createDriver();

let nestResolved = true;
try {
  import.meta.resolve('@nestjs/common');
} catch {
  nestResolved = false;
}

assert.equal(nestResolved, false);
assert.equal(DEFAULT_BUFFER_LIMIT, 10 * 1024 * 1024);
assert.equal(StorageErrorCode.NOT_FOUND, 'NOT_FOUND');
assert.equal(new StorageUploadControl().status, 'idle');
assert.equal(STORAGE_WORKSPACE_MAX_CURSOR_BYTES, 4096);
const cursorCodec = new Aes256GcmStorageWorkspaceCursorCodec({
  activeKeyId: 'packed',
  keys: { packed: new Uint8Array(32).fill(7) },
});
const cursorPayload = new TextEncoder().encode('provider-secret');
const cursorToken = cursorCodec.encode(cursorPayload, {
  expiresAt: Date.now() + 60_000,
});
assert.match(cursorToken, /^swc1\\.packed\\./u);
assert.deepEqual(cursorCodec.decode(cursorToken), cursorPayload);
const foreignStorageError = Object.assign(new Error('foreign'), {
  [Symbol.for('@nestm/storage/StorageError')]: true,
  aborted: false,
  code: StorageErrorCode.NOT_FOUND,
  key: 'missing.bin',
  name: 'StorageError',
  operation: 'head',
  permanent: true,
  store: 'foreign',
  timedOut: false,
});
assert.equal(isStorageError(foreignStorageError), true);

const s3Driver = createS3StorageDriver({
  adapter: {
    bucket: 'packed-test',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    region: 'us-east-1',
  },
});
assert.deepEqual(s3Driver.capabilities.conditionalCreate, {
  resultEtag: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalReplace, {
  resultEtag: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalDelete, {
  etag: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalRead, {
  etag: true,
  version: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalCopySource, {
  etag: true,
  version: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalCopyDestination, {
  atomicWithSource: true,
  create: true,
  replace: true,
});
assert.deepEqual(s3Driver.capabilities.conditionalMultipartCompletion, {
  create: true,
  replace: true,
});
assert.deepEqual(s3Driver.capabilities.physicalKey, { maxBytes: 1_024 });
assert.deepEqual(s3Driver.capabilities.signedUploadPolicy, {
  contentType: true,
  sizeRange: true,
});
assert.deepEqual(s3Driver.capabilities.signedDownloadPolicy, {
  expiresIn: true,
});

const client = new StorageClient('packed', driver);
const uploaded = await client.upload('hello.txt', 'hello core', {
  contentType: 'text/plain',
});
assert.equal(uploaded.key, 'hello.txt');
assert.equal(await client.downloadText('hello.txt'), 'hello core');

const workspaceCursorConfiguration = () => ({
  codec: new Aes256GcmStorageWorkspaceCursorCodec({
    activeKeyId: 'packed-workspace',
    keys: { 'packed-workspace': new Uint8Array(32).fill(8) },
  }),
  mountId: 'packed-artifacts',
  scope: 'organization:packed/workspace:packed',
});
const workspaceClientA = new StorageClient('packed-workspace', createDriver());
for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  await workspaceClientA.upload('scope/' + name, name);
}
const workspaceA = mountStorageWorkspace(workspaceClientA, {
  cursor: workspaceCursorConfiguration(),
  prefix: 'scope',
});
const firstList = await workspaceA.list({ limit: 1, recursive: true });
const firstListCursor = firstList.cursor;
assert.ok(firstListCursor);
const firstSearch = await workspaceA.search('*.txt', { limit: 1 });
const firstSearchCursor = firstSearch.cursor;
assert.ok(firstSearchCursor);
await workspaceClientA.onApplicationShutdown();

const workspaceClientB = new StorageClient('packed-workspace', createDriver());
const workspaceB = mountStorageWorkspace(workspaceClientB, {
  cursor: workspaceCursorConfiguration(),
  prefix: 'scope',
});
const continuedList = await workspaceB.list({ cursor: firstListCursor });
assert.ok(continuedList.cursor);
const continuedListDescendant = await workspaceB.list({
  cursor: continuedList.cursor,
});
const replayedList = await workspaceB.list({ cursor: firstListCursor });
assert.deepEqual(replayedList.entries, continuedList.entries);
assert.ok(replayedList.cursor);
assert.deepEqual(
  (await workspaceB.list({ cursor: replayedList.cursor })).entries,
  continuedListDescendant.entries,
);
const continuedSearch = await workspaceB.search('', {
  cursor: firstSearchCursor,
});
assert.ok(continuedSearch.cursor);
const continuedSearchDescendant = await workspaceB.search('', {
  cursor: continuedSearch.cursor,
});
const replayedSearch = await workspaceB.search('', {
  cursor: firstSearchCursor,
});
assert.deepEqual(replayedSearch.entries, continuedSearch.entries);
assert.ok(replayedSearch.cursor);
assert.deepEqual(
  (await workspaceB.search('', { cursor: replayedSearch.cursor })).entries,
  continuedSearchDescendant.entries,
);
await workspaceClientB.onApplicationShutdown();

await client.onApplicationShutdown();
await client.onApplicationShutdown();
assert.equal(closeCalls, 3);
`;
}

function getS3MinimumPeerSource(minimumVersions) {
  return `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { S3Client } from '@aws-sdk/client-s3';
import {
  StorageClient,
  StorageErrorCode,
} from '@nestm/storage/core';
import { createFilesSdkDriver } from '@nestm/storage/files-sdk';
import {
  CLOUDFLARE_R2_PROVIDER_PROFILE,
  createS3StorageDriver,
  defineS3ProviderProfile,
  s3,
  withS3Capabilities,
} from '@nestm/storage/files-sdk/s3';

const require = createRequire(import.meta.url);
for (const [name, expected] of Object.entries(${JSON.stringify(minimumVersions)})) {
  const installed = require(name + '/package.json');
  assert.equal(installed.version, expected, name + ' minimum peer drifted');
}

const serializedRequests = [];
const instrumentedClients = new WeakSet();
const originalSend = S3Client.prototype.send;
process.env.AWS_ENDPOINT_URL_S3 = 'https://minimum-peer-redirect.invalid';
process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = 'false';

S3Client.prototype.send = function (...arguments_) {
  if (!instrumentedClients.has(this)) {
    this.middlewareStack.add(
      () => async (middlewareArguments) => {
        serializedRequests.push(middlewareArguments.request);
        return {
          output: { $metadata: { httpStatusCode: 200 } },
          response: { headers: {}, statusCode: 200 },
        };
      },
      {
        name: 'captureSerializedCopyDestinationConditions',
        priority: 'high',
        step: 'finalizeRequest',
      },
    );
    instrumentedClients.add(this);
  }
  return Reflect.apply(originalSend, this, arguments_);
};

try {
  const baseAdapterOptions = {
    bucket: 'minimum-peer-bucket',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    region: 'us-east-1',
  };

  const widenedNative = s3(baseAdapterOptions);
  try {
    assert.throws(
      () =>
        withS3Capabilities(widenedNative, {
          providerProfile: defineS3ProviderProfile({
            name: 'invalid-widened-minimum-peer-native',
            physicalKey: { maxBytes: 2048 },
          }),
        }),
      /cannot widen aws-s3-general-purpose physicalKey\\.maxBytes/u,
    );
  } finally {
    widenedNative.raw.destroy();
  }
  assert.equal(serializedRequests.length, 0);

  const forgedUndecorated = s3(baseAdapterOptions);
  try {
    Object.defineProperty(
      forgedUndecorated.raw,
      Symbol.for('@nestm/storage/files-sdk/s3-adapter-provenance'),
      {
        configurable: false,
        enumerable: false,
        value: 'verified',
        writable: false,
      },
    );
    assert.throws(
      () => createFilesSdkDriver({ adapter: forgedUndecorated }),
      (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
    );
    assert.throws(
      () =>
        createFilesSdkDriver({
          adapter: { ...forgedUndecorated, name: 'renamed-forged-s3' },
        }),
      (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
    );
    assert.throws(
      () =>
        createFilesSdkDriver({
          adapter: {
            ...forgedUndecorated,
            name: 'renamed-replaced-raw-s3',
            raw: {},
          },
        }),
      (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
    );
    const symbolForgingRaw = new Proxy(forgedUndecorated.raw, {
      get(target, property, receiver) {
        if (
          typeof property === 'symbol' &&
          property.description?.toLowerCase().includes('provenance')
        ) {
          return 'verified';
        }
        return Reflect.get(target, property, receiver);
      },
    });
    assert.throws(
      () =>
        createFilesSdkDriver({
          adapter: {
            ...forgedUndecorated,
            name: 'renamed-symbol-forging-s3',
            raw: symbolForgingRaw,
          },
        }),
      (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
    );
  } finally {
    forgedUndecorated.raw.destroy();
  }

  const unverifiedBase = s3({
    ...baseAdapterOptions,
    endpoint: 'https://unverified.minimum-peer.invalid',
  });
  const unverifiedClient = new StorageClient(
    'minimum-peer-unverified',
    createFilesSdkDriver({
      adapter: withS3Capabilities(unverifiedBase),
      readonly: false,
    }),
  );
  try {
    assert.equal(unverifiedClient.capabilities.signedUpload, false);
    await assert.rejects(
      () => unverifiedClient.upload('blocked.txt', 'blocked'),
      (error) => error?.code === StorageErrorCode.READ_ONLY,
    );
  } finally {
    await unverifiedClient.onApplicationShutdown();
  }

  const narrowBase = s3({
    ...baseAdapterOptions,
    endpoint: 'https://verified.minimum-peer.invalid',
  });
  const narrowAdapter = withS3Capabilities(narrowBase, {
    providerProfile: defineS3ProviderProfile({
      name: 'minimum-peer-narrow',
      physicalKey: { maxBytes: 512 },
      conditionalRead: { etag: true, version: false },
    }),
  });
  try {
    assert.deepEqual(narrowAdapter.signedUploadPolicy, {
      contentType: false,
      sizeRange: false,
    });
    assert.throws(
      () =>
        createFilesSdkDriver({
          adapter: {
            ...narrowAdapter,
            conditionalCreate: { resultEtag: true },
            async uploadConditional() {
              throw new Error('widened alias must never dispatch');
            },
          },
        }),
      (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
    );
  } finally {
    narrowBase.raw.destroy();
  }

  assert.equal(serializedRequests.length, 0);

  const client = new StorageClient(
    'minimum-peer',
    createS3StorageDriver({
      adapter: baseAdapterOptions,
    }),
  );

  await client.promote('source.txt', 'create.txt', {
    destination: { type: 'create' },
    sourceEtag: 'source-etag',
  });
  await client.promote('source.txt', 'replace.txt', {
    destination: { etag: 'destination-etag', type: 'replace' },
    sourceEtag: 'source-etag',
  });

  assert.equal(serializedRequests.length, 2);
  const [createRequest, replaceRequest] = serializedRequests;
  assert.ok(createRequest);
  assert.ok(replaceRequest);
  assert.equal(
    createRequest.hostname,
    'minimum-peer-bucket.s3.us-east-1.amazonaws.com',
  );
  assert.equal(
    replaceRequest.hostname,
    'minimum-peer-bucket.s3.us-east-1.amazonaws.com',
  );

  assert.equal(createRequest.headers['if-none-match'], '*');
  assert.equal(createRequest.headers['if-match'], undefined);
  assert.equal(
    createRequest.headers['x-amz-copy-source-if-match'],
    '"source-etag"',
  );

  assert.equal(replaceRequest.headers['if-match'], '"destination-etag"');
  assert.equal(replaceRequest.headers['if-none-match'], undefined);
  assert.equal(
    replaceRequest.headers['x-amz-copy-source-if-match'],
    '"source-etag"',
  );

  const typedPut = await client.signUpload('typed.txt', {
    contentType: 'text/plain',
    expiresIn: 60,
  });
  assert.equal(typedPut.method, 'PUT');
  assert.deepEqual(typedPut.headers, { 'Content-Type': 'text/plain' });
  assert.equal(
    new URL(typedPut.url).searchParams.get('X-Amz-SignedHeaders'),
    'content-type;host',
  );

  const boundedPost = await client.signUpload('bounded.txt', {
    contentType: 'text/plain',
    expiresIn: 60,
    maxSize: 1000,
    minSize: 100,
  });
  assert.equal(boundedPost.method, 'POST');
  const boundedPolicy = JSON.parse(
    Buffer.from(boundedPost.fields.Policy, 'base64').toString('utf8'),
  );
  assert.ok(
    boundedPolicy.conditions.some(
      (condition) =>
        Array.isArray(condition) &&
        condition[0] === 'content-length-range' &&
        condition[1] === 100 &&
        condition[2] === 1000,
    ),
  );
  assert.ok(
    boundedPolicy.conditions.some(
      (condition) =>
        Array.isArray(condition) &&
        condition[0] === 'eq' &&
        condition[1] === '$Content-Type' &&
        condition[2] === 'text/plain',
    ),
  );
  await assert.rejects(
    () => client.signUpload('min-only.txt', { expiresIn: 60, minSize: 1 }),
    (error) => error?.code === StorageErrorCode.NOT_SUPPORTED,
  );
  await assert.rejects(
    () =>
      client.signUpload('\${filename}', {
        expiresIn: 60,
        maxSize: 1000,
      }),
    (error) => error?.code === StorageErrorCode.INVALID_ARGUMENT,
  );

  const r2 = new StorageClient(
    'minimum-peer-r2',
    createS3StorageDriver({
      adapter: {
        ...baseAdapterOptions,
        endpoint: 'https://account.r2.cloudflarestorage.com',
        region: 'auto',
      },
      providerProfile: CLOUDFLARE_R2_PROVIDER_PROFILE,
    }),
  );
  const r2TypedPut = await r2.signUpload('typed.txt', {
    contentType: 'text/plain',
    expiresIn: 60,
  });
  assert.equal(r2TypedPut.method, 'PUT');
  assert.equal(
    new URL(r2TypedPut.url).searchParams.get('X-Amz-SignedHeaders'),
    'content-type;host',
  );
  await assert.rejects(
    () =>
      r2.signUpload('bounded.txt', {
        expiresIn: 60,
        maxSize: 1000,
      }),
    (error) => error?.code === StorageErrorCode.NOT_SUPPORTED,
  );
  await r2.onApplicationShutdown();
  assert.equal(serializedRequests.length, 2);

  await client.onApplicationShutdown();
} finally {
  S3Client.prototype.send = originalSend;
  delete process.env.AWS_ENDPOINT_URL_S3;
  delete process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS;
}
`;
}

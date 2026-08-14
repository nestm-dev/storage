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
const minimumS3PeerVersion = caretMinimum(
  rootPackage.peerDependencies?.['@aws-sdk/client-s3'],
  '@aws-sdk/client-s3',
);

try {
  run('pnpm', ['pack', '--out', tarballPath], projectRoot);

  mkdirSync(join(consumerRoot, 'src'), { recursive: true });
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: '@nestm/storage-core-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
        dependencies: {
          '@aws-sdk/client-s3': minimumS3PeerVersion,
          '@aws-sdk/lib-storage': minimumS3PeerVersion,
          '@aws-sdk/s3-presigned-post': minimumS3PeerVersion,
          '@aws-sdk/s3-request-presigner': minimumS3PeerVersion,
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
    getS3MinimumPeerSource(minimumS3PeerVersion),
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

const driver = {
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
    return {
      items: [...objects.keys()]
        .filter((key) => key.startsWith(options?.prefix ?? ''))
        .map(metadata),
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

await client.onApplicationShutdown();
await client.onApplicationShutdown();
assert.equal(closeCalls, 1);
`;
}

function getS3MinimumPeerSource(minimumVersion) {
  return `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { S3Client } from '@aws-sdk/client-s3';
import { StorageClient } from '@nestm/storage/core';
import { createS3StorageDriver } from '@nestm/storage/files-sdk/s3';

const require = createRequire(import.meta.url);
const clientS3Package = require('@aws-sdk/client-s3/package.json');
assert.equal(clientS3Package.version, '${minimumVersion}');

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
  const client = new StorageClient(
    'minimum-peer',
    createS3StorageDriver({
      adapter: {
        bucket: 'minimum-peer-bucket',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        region: 'us-east-1',
      },
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

  await client.onApplicationShutdown();
} finally {
  S3Client.prototype.send = originalSend;
  delete process.env.AWS_ENDPOINT_URL_S3;
  delete process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS;
}
`;
}

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

function getConsumerSource() {
  return `import assert from 'node:assert/strict';

import {
  DEFAULT_BUFFER_LIMIT,
  StorageClient,
  StorageErrorCode,
  StorageUploadControl,
  type StorageCapabilities,
  type StorageDriver,
  type StorageObjectMetadata,
} from '@nestm/storage/core';

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

import {
  Module,
  type CanActivate,
  type DynamicModule,
  type Provider,
} from '@nestjs/common';

import { StorageGatewayController } from './storage-gateway.controller.js';
import { StorageGatewayFastifyParser } from './storage-gateway-fastify-parser.js';
import { StorageGatewayGuard } from './storage-gateway.guard.js';
import {
  STORAGE_GATEWAY_GUARDS,
  STORAGE_GATEWAY_KEY_POLICY,
  STORAGE_GATEWAY_OPTIONS,
} from './storage-gateway.tokens.js';
import {
  StorageGatewayOperation,
  type ResolvedStorageGatewayOptions,
  type StorageGatewayKeyPolicy,
  type StorageGatewayOptions,
} from './storage-gateway.types.js';

const operations = new Set(Object.values(StorageGatewayOperation));

function isExactContentType(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value)
  );
}

function resolveOptions(
  options: StorageGatewayOptions,
): ResolvedStorageGatewayOptions {
  if (options.operations.length === 0) {
    throw new TypeError(
      'StorageGatewayModule requires a non-empty operation allowlist.',
    );
  }
  for (const operation of options.operations) {
    if (!operations.has(operation)) {
      throw new TypeError(
        `Unknown storage gateway operation: ${String(operation)}.`,
      );
    }
  }
  if (
    (options.guards?.length ?? 0) === 0 &&
    options.allowUnauthenticated !== true
  ) {
    throw new TypeError(
      'StorageGatewayModule requires at least one Nest guard. Set allowUnauthenticated: true only for explicit development use.',
    );
  }
  if (
    options.keyPolicy === undefined &&
    options.unsafeAllowUnscopedKeys !== true
  ) {
    throw new TypeError(
      'StorageGatewayModule requires a keyPolicy. Set unsafeAllowUnscopedKeys: true only as an explicit migration escape hatch.',
    );
  }
  if (
    options.keyPolicy !== undefined &&
    options.unsafeAllowUnscopedKeys === true
  ) {
    throw new TypeError(
      'StorageGatewayModule cannot combine keyPolicy with unsafeAllowUnscopedKeys.',
    );
  }
  if (
    options.mode !== undefined &&
    !['proxy', 'signed', 'hybrid'].includes(options.mode)
  ) {
    throw new TypeError(`Unknown storage gateway mode: ${options.mode}.`);
  }
  const maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new TypeError('maxUploadBytes must be a positive safe integer.');
  }
  const maxListResults = options.maxListResults ?? 1000;
  if (!Number.isSafeInteger(maxListResults) || maxListResults <= 0) {
    throw new TypeError('maxListResults must be a positive safe integer.');
  }
  const maxSearchResults = options.maxSearchResults ?? 1000;
  if (!Number.isSafeInteger(maxSearchResults) || maxSearchResults <= 0) {
    throw new TypeError('maxSearchResults must be a positive safe integer.');
  }
  const defaultSignedUrlExpiresIn = options.defaultSignedUrlExpiresIn ?? 300;
  if (
    !Number.isSafeInteger(defaultSignedUrlExpiresIn) ||
    defaultSignedUrlExpiresIn <= 0
  ) {
    throw new TypeError(
      'defaultSignedUrlExpiresIn must be a positive safe integer.',
    );
  }
  const maxSignedUrlExpiresIn = options.maxSignedUrlExpiresIn ?? 3600;
  if (
    !Number.isSafeInteger(maxSignedUrlExpiresIn) ||
    maxSignedUrlExpiresIn <= 0
  ) {
    throw new TypeError(
      'maxSignedUrlExpiresIn must be a positive safe integer.',
    );
  }
  if (defaultSignedUrlExpiresIn > maxSignedUrlExpiresIn) {
    throw new TypeError(
      'defaultSignedUrlExpiresIn cannot exceed maxSignedUrlExpiresIn.',
    );
  }
  const maxSignedUploadBytes = options.maxSignedUploadBytes ?? maxUploadBytes;
  if (
    !Number.isSafeInteger(maxSignedUploadBytes) ||
    maxSignedUploadBytes <= 0
  ) {
    throw new TypeError(
      'maxSignedUploadBytes must be a positive safe integer.',
    );
  }
  const signedUploadContentTypes = options.signedUploadContentTypes ?? [
    'application/octet-stream',
  ];
  if (signedUploadContentTypes.length === 0) {
    throw new TypeError(
      'signedUploadContentTypes must contain at least one exact MIME type.',
    );
  }
  for (const contentType of signedUploadContentTypes) {
    if (!isExactContentType(contentType)) {
      throw new TypeError(
        'signedUploadContentTypes must contain lowercase exact MIME types without parameters.',
      );
    }
  }
  const proxyInlineContentTypes = options.proxyInlineContentTypes ?? [];
  for (const contentType of proxyInlineContentTypes) {
    if (
      typeof contentType !== 'string' ||
      contentType.length === 0 ||
      contentType.trim() !== contentType ||
      contentType.includes(';')
    ) {
      throw new TypeError(
        'proxyInlineContentTypes must contain exact, non-empty MIME types without parameters.',
      );
    }
  }

  return {
    allowUnauthenticated: options.allowUnauthenticated === true,
    defaultSignedUrlExpiresIn,
    maxListResults,
    maxSearchResults,
    maxSignedUploadBytes,
    maxSignedUrlExpiresIn,
    maxUploadBytes,
    mode: options.mode ?? 'hybrid',
    operations: new Set(options.operations),
    proxyInlineContentTypes: new Set(
      proxyInlineContentTypes.map((contentType) => contentType.toLowerCase()),
    ),
    signedUploadContentTypes: new Set(signedUploadContentTypes),
    ...(options.store !== undefined && { store: options.store }),
  };
}

@Module({})
export class StorageGatewayModule {
  static register(options: StorageGatewayOptions): DynamicModule {
    const resolved = resolveOptions(options);
    const guardTokens = options.guards ?? [];
    const guardsProvider: Provider =
      guardTokens.length === 0
        ? { provide: STORAGE_GATEWAY_GUARDS, useValue: [] }
        : {
            provide: STORAGE_GATEWAY_GUARDS,
            inject: [...guardTokens],
            useFactory: (...guards: CanActivate[]) => guards,
          };
    const keyPolicyProvider: Provider =
      options.keyPolicy === undefined
        ? {
            provide: STORAGE_GATEWAY_KEY_POLICY,
            useValue: {
              resolve({ input, target }) {
                if (input !== undefined) {
                  return input.value;
                }
                if (target === 'prefix') {
                  return '';
                }
                throw new TypeError(`${target} is required.`);
              },
            } satisfies StorageGatewayKeyPolicy,
          }
        : {
            provide: STORAGE_GATEWAY_KEY_POLICY,
            useExisting: options.keyPolicy,
          };

    return {
      module: StorageGatewayModule,
      imports: options.imports ?? [],
      controllers: [StorageGatewayController],
      providers: [
        { provide: STORAGE_GATEWAY_OPTIONS, useValue: resolved },
        guardsProvider,
        keyPolicyProvider,
        StorageGatewayGuard,
        StorageGatewayFastifyParser,
      ],
    };
  }
}

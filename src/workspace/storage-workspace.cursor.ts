import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { StorageErrorCode, isStorageError } from '../storage.error.js';

import { workspaceError } from './storage-workspace.error.js';
import type {
  StorageWorkspaceLimits,
  StorageWorkspaceSearchMatch,
} from './storage-workspace.types.js';

export const STORAGE_WORKSPACE_CURSOR_VERSION = 1 as const;
export const STORAGE_WORKSPACE_MAX_CURSOR_BYTES = 4_096;

const AES_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_CURSOR_KEYS = 32;
const MAX_CURSOR_KEY_ID_BYTES = 64;
const MAX_CURSOR_PAYLOAD_BYTES = 2_990;
const MAX_CURSOR_SCOPE_BYTES = 1_024;
const TOKEN_VERSION = 'swc1';
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/u;
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const forbiddenIdentityCharacter = /\p{C}/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface StorageWorkspaceCursorEncodeOptions {
  /** Absolute Unix timestamp in milliseconds used by durable stores for TTL. */
  readonly expiresAt: number;
}

/**
 * Server-side opaque cursor contract. Implementations must either authenticate
 * and encrypt payloads or keep them behind a shared durable random token.
 * Tokens use only `[A-Za-z0-9._-]`, are at most 4,096 bytes, and `decode` must
 * be non-destructive so the same token remains replayable until its authenticated
 * expiry. Durable stores must expire records at `options.expiresAt` and read
 * rather than consume them. Missing or expired records should fail with
 * `StorageErrorCode.NOT_FOUND` or `StorageErrorCode.INVALID_ARGUMENT`;
 * availability failures retain their operational storage error code.
 */
export interface StorageWorkspaceCursorCodec {
  encode(
    payload: Uint8Array,
    options: StorageWorkspaceCursorEncodeOptions,
  ): Promise<string> | string;
  decode(token: string): Promise<Uint8Array> | Uint8Array;
}

export interface StorageWorkspaceCursorConfiguration {
  /** Codec shared by every replica that serves this logical mount. */
  readonly codec: StorageWorkspaceCursorCodec;
  /** Stable server-derived mount or binding identity. */
  readonly mountId: string;
  /** Stable trusted tenant/workspace scope. */
  readonly scope: string;
}

export interface Aes256GcmStorageWorkspaceCursorCodecOptions {
  /** Key used for newly issued cursors. */
  readonly activeKeyId: string;
  /** Decryption key ring. Retain rotated keys for at least one cursor TTL. */
  readonly keys: Readonly<Record<string, Uint8Array>>;
}

/** Stateless AES-256-GCM cursor codec suitable for shared multi-replica use. */
export class Aes256GcmStorageWorkspaceCursorCodec implements StorageWorkspaceCursorCodec {
  readonly #activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  constructor(options: Aes256GcmStorageWorkspaceCursorCodecOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      !validKeyId(options.activeKeyId)
    ) {
      throw new TypeError(
        'Workspace cursor activeKeyId must be a 1-64 byte base64url identifier.',
      );
    }
    if (
      typeof options.keys !== 'object' ||
      options.keys === null ||
      Array.isArray(options.keys)
    ) {
      throw new TypeError('Workspace cursor keys must be a key-id record.');
    }
    const entries = Object.entries(options.keys);
    if (entries.length === 0 || entries.length > MAX_CURSOR_KEYS) {
      throw new TypeError(
        `Workspace cursor key ring must contain 1-${MAX_CURSOR_KEYS} keys.`,
      );
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, key] of entries) {
      if (!validKeyId(keyId)) {
        throw new TypeError(
          'Workspace cursor key IDs must be 1-64 byte base64url identifiers.',
        );
      }
      if (!(key instanceof Uint8Array) || key.byteLength !== AES_KEY_BYTES) {
        throw new TypeError(
          `Workspace cursor key "${keyId}" must contain exactly ${AES_KEY_BYTES} bytes.`,
        );
      }
      keys.set(keyId, Buffer.from(key));
    }
    if (!keys.has(options.activeKeyId)) {
      throw new TypeError(
        'Workspace cursor activeKeyId must identify a configured key.',
      );
    }
    this.#activeKeyId = options.activeKeyId;
    this.#keys = keys;
  }

  encode(
    payload: Uint8Array,
    options: StorageWorkspaceCursorEncodeOptions,
  ): string {
    if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
      throw new TypeError('Workspace cursor payload must not be empty.');
    }
    if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= 0) {
      throw new TypeError(
        'Workspace cursor expiry must be a positive safe integer.',
      );
    }
    if (payload.byteLength > MAX_CURSOR_PAYLOAD_BYTES) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        'Workspace cursor payload exceeds the bounded token size.',
        { permanent: true },
      );
    }

    const key = this.#keys.get(this.#activeKeyId);
    if (key === undefined) {
      throw new TypeError('Workspace cursor active key is unavailable.');
    }
    const iv = randomBytes(AES_GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: AES_GCM_TAG_BYTES,
    });
    cipher.setAAD(cursorAad(this.#activeKeyId));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const body = Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
    const token = `${TOKEN_VERSION}.${this.#activeKeyId}.${body.toString('base64url')}`;
    if (token.length > STORAGE_WORKSPACE_MAX_CURSOR_BYTES) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        'Workspace cursor exceeds the bounded token size.',
        { permanent: true },
      );
    }
    return token;
  }

  decode(token: string): Uint8Array {
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > STORAGE_WORKSPACE_MAX_CURSOR_BYTES ||
      !TOKEN_PATTERN.test(token)
    ) {
      throw invalidCursor();
    }
    const parts = token.split('.');
    const version = parts[0];
    const keyId = parts[1];
    const encodedBody = parts[2];
    if (
      parts.length !== 3 ||
      version !== TOKEN_VERSION ||
      keyId === undefined ||
      encodedBody === undefined ||
      !validKeyId(keyId) ||
      !TOKEN_PART_PATTERN.test(encodedBody)
    ) {
      throw invalidCursor();
    }
    const key = this.#keys.get(keyId);
    if (key === undefined) {
      throw invalidCursor();
    }
    const body = Buffer.from(encodedBody, 'base64url');
    if (
      body.toString('base64url') !== encodedBody ||
      body.byteLength <= AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES
    ) {
      throw invalidCursor();
    }
    const iv = body.subarray(0, AES_GCM_IV_BYTES);
    const ciphertext = body.subarray(
      AES_GCM_IV_BYTES,
      body.byteLength - AES_GCM_TAG_BYTES,
    );
    const tag = body.subarray(body.byteLength - AES_GCM_TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: AES_GCM_TAG_BYTES,
      });
      decipher.setAAD(cursorAad(keyId));
      decipher.setAuthTag(tag);
      return Uint8Array.from(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    } catch {
      throw invalidCursor();
    }
  }
}

interface StorageWorkspaceCursorBinding {
  readonly limits: Readonly<StorageWorkspaceLimits>;
  readonly prefix: string;
  readonly store: string;
}

export interface StorageWorkspaceListCursorData {
  readonly backendCursor: string;
  readonly directory: string;
  readonly limit: number;
  readonly operation: 'list';
  readonly recursive: boolean;
}

export interface StorageWorkspaceSearchCursorData {
  readonly backendCursor: string;
  readonly caseInsensitive: boolean;
  readonly directory: string;
  readonly limit: number;
  readonly match: StorageWorkspaceSearchMatch;
  readonly operation: 'search';
  readonly query: string;
  readonly scanned: number;
}

export type StorageWorkspaceCursorData =
  StorageWorkspaceListCursorData | StorageWorkspaceSearchCursorData;

interface WireCursorCommon {
  readonly b: string;
  readonly e: number;
  readonly v: typeof STORAGE_WORKSPACE_CURSOR_VERSION;
}

interface WireListCursor extends WireCursorCommon {
  readonly o: 'list';
  readonly q: {
    readonly d: string;
    readonly l: number;
    readonly r: boolean;
  };
  readonly s: { readonly c: string };
}

interface WireSearchCursor extends WireCursorCommon {
  readonly o: 'search';
  readonly q: {
    readonly c: boolean;
    readonly d: string;
    readonly l: number;
    readonly m: StorageWorkspaceSearchMatch;
    readonly q: string;
  };
  readonly s: {
    readonly c: string;
    readonly n: number;
  };
}

type WireCursor = WireListCursor | WireSearchCursor;

export function resolveStorageWorkspaceCursorConfiguration(
  configuration: StorageWorkspaceCursorConfiguration | undefined,
): Readonly<StorageWorkspaceCursorConfiguration> | undefined {
  if (configuration === undefined) {
    return undefined;
  }
  if (
    typeof configuration !== 'object' ||
    configuration === null ||
    typeof configuration.codec !== 'object' ||
    configuration.codec === null ||
    typeof configuration.codec.encode !== 'function' ||
    typeof configuration.codec.decode !== 'function'
  ) {
    throw workspaceError(
      StorageErrorCode.INVALID_ARGUMENT,
      'Workspace cursor configuration requires a codec.',
      { permanent: true },
    );
  }
  assertStableIdentity(configuration.mountId, 'cursor.mountId');
  assertStableIdentity(configuration.scope, 'cursor.scope');
  return Object.freeze({
    codec: configuration.codec,
    mountId: configuration.mountId,
    scope: configuration.scope,
  });
}

export async function issueStorageWorkspaceCursor(
  configuration: Readonly<StorageWorkspaceCursorConfiguration> | undefined,
  binding: StorageWorkspaceCursorBinding,
  cursor: StorageWorkspaceCursorData,
): Promise<string> {
  if (configuration === undefined) {
    throw cursorNotConfigured();
  }
  const expiresAt = Date.now() + binding.limits.cursorTtlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw workspaceError(
      StorageErrorCode.LIMIT_EXCEEDED,
      'Workspace cursor expiry exceeds the supported range.',
      { permanent: true },
    );
  }
  const common: WireCursorCommon = {
    b: cursorBindingDigest(configuration, binding, cursor.operation),
    e: expiresAt,
    v: STORAGE_WORKSPACE_CURSOR_VERSION,
  };
  const wire: WireCursor =
    cursor.operation === 'list'
      ? {
          ...common,
          o: 'list',
          q: {
            d: cursor.directory,
            l: cursor.limit,
            r: cursor.recursive,
          },
          s: { c: cursor.backendCursor },
        }
      : {
          ...common,
          o: 'search',
          q: {
            c: cursor.caseInsensitive,
            d: cursor.directory,
            l: cursor.limit,
            m: cursor.match,
            q: cursor.query,
          },
          s: { c: cursor.backendCursor, n: cursor.scanned },
        };
  const payload = encoder.encode(JSON.stringify(wire));
  if (payload.byteLength > MAX_CURSOR_PAYLOAD_BYTES) {
    throw workspaceError(
      StorageErrorCode.LIMIT_EXCEEDED,
      'Workspace cursor state exceeds the bounded token size.',
      { permanent: true },
    );
  }

  let token: string;
  try {
    token = await configuration.codec.encode(payload, { expiresAt });
  } catch (error) {
    throw issueFailure(error);
  }
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    !TOKEN_PATTERN.test(token)
  ) {
    throw workspaceError(
      StorageErrorCode.PROVIDER,
      'Workspace cursor codec returned an invalid token.',
    );
  }
  if (
    token.length >
    Math.min(STORAGE_WORKSPACE_MAX_CURSOR_BYTES, binding.limits.maxCursorBytes)
  ) {
    throw workspaceError(
      StorageErrorCode.LIMIT_EXCEEDED,
      'Workspace cursor exceeds the configured byte limit.',
      { permanent: true },
    );
  }
  return token;
}

export function decodeStorageWorkspaceCursor(
  configuration: Readonly<StorageWorkspaceCursorConfiguration> | undefined,
  binding: StorageWorkspaceCursorBinding,
  operation: 'list',
  token: string,
): Promise<StorageWorkspaceListCursorData>;
export function decodeStorageWorkspaceCursor(
  configuration: Readonly<StorageWorkspaceCursorConfiguration> | undefined,
  binding: StorageWorkspaceCursorBinding,
  operation: 'search',
  token: string,
): Promise<StorageWorkspaceSearchCursorData>;
export async function decodeStorageWorkspaceCursor(
  configuration: Readonly<StorageWorkspaceCursorConfiguration> | undefined,
  binding: StorageWorkspaceCursorBinding,
  operation: StorageWorkspaceCursorData['operation'],
  token: string,
): Promise<StorageWorkspaceCursorData> {
  if (configuration === undefined) {
    throw cursorNotConfigured();
  }
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length >
      Math.min(
        STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
        binding.limits.maxCursorBytes,
      ) ||
    !TOKEN_PATTERN.test(token)
  ) {
    throw invalidCursor();
  }

  let payload: Uint8Array;
  try {
    payload = await configuration.codec.decode(token);
  } catch (error) {
    throw decodeFailure(error);
  }
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength === 0 ||
    payload.byteLength > MAX_CURSOR_PAYLOAD_BYTES
  ) {
    throw invalidCursor();
  }
  const wire = parseWireCursor(payload);
  const now = Date.now();
  if (
    wire.e <= now ||
    wire.o !== operation ||
    wire.b !== cursorBindingDigest(configuration, binding, operation)
  ) {
    throw invalidCursor();
  }
  if (
    (wire.o === 'list' && wire.q.l > binding.limits.maxPageSize) ||
    (wire.o === 'search' &&
      (wire.q.l > binding.limits.maxSearchResults ||
        wire.s.n > binding.limits.maxSearchScan))
  ) {
    throw invalidCursor();
  }
  return wire.o === 'list'
    ? {
        backendCursor: wire.s.c,
        directory: wire.q.d,
        limit: wire.q.l,
        operation: 'list',
        recursive: wire.q.r,
      }
    : {
        backendCursor: wire.s.c,
        caseInsensitive: wire.q.c,
        directory: wire.q.d,
        limit: wire.q.l,
        match: wire.q.m,
        operation: 'search',
        query: wire.q.q,
        scanned: wire.s.n,
      };
}

function parseWireCursor(payload: Uint8Array): WireCursor {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payload));
  } catch {
    throw invalidCursor();
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['b', 'e', 'o', 'q', 's', 'v'])
  ) {
    throw invalidCursor();
  }
  if (
    value.v !== STORAGE_WORKSPACE_CURSOR_VERSION ||
    typeof value.b !== 'string' ||
    !BINDING_PATTERN.test(value.b) ||
    !positiveSafeInteger(value.e) ||
    !isRecord(value.q) ||
    !isRecord(value.s)
  ) {
    throw invalidCursor();
  }
  if (value.o === 'list') {
    if (
      !hasExactKeys(value.q, ['d', 'l', 'r']) ||
      !hasExactKeys(value.s, ['c']) ||
      typeof value.q.d !== 'string' ||
      !positiveSafeInteger(value.q.l) ||
      typeof value.q.r !== 'boolean' ||
      !nonEmptyString(value.s.c)
    ) {
      throw invalidCursor();
    }
    return {
      b: value.b,
      e: value.e,
      o: 'list',
      q: { d: value.q.d, l: value.q.l, r: value.q.r },
      s: { c: value.s.c },
      v: STORAGE_WORKSPACE_CURSOR_VERSION,
    };
  }
  if (value.o === 'search') {
    if (
      !hasExactKeys(value.q, ['c', 'd', 'l', 'm', 'q']) ||
      !hasExactKeys(value.s, ['c', 'n']) ||
      typeof value.q.c !== 'boolean' ||
      typeof value.q.d !== 'string' ||
      !positiveSafeInteger(value.q.l) ||
      !searchMatch(value.q.m) ||
      !nonEmptyString(value.q.q) ||
      !nonEmptyString(value.s.c) ||
      !nonNegativeSafeInteger(value.s.n)
    ) {
      throw invalidCursor();
    }
    return {
      b: value.b,
      e: value.e,
      o: 'search',
      q: {
        c: value.q.c,
        d: value.q.d,
        l: value.q.l,
        m: value.q.m,
        q: value.q.q,
      },
      s: { c: value.s.c, n: value.s.n },
      v: STORAGE_WORKSPACE_CURSOR_VERSION,
    };
  }
  throw invalidCursor();
}

function cursorBindingDigest(
  configuration: Readonly<StorageWorkspaceCursorConfiguration>,
  binding: StorageWorkspaceCursorBinding,
  operation: StorageWorkspaceCursorData['operation'],
): string {
  const limits = binding.limits;
  const canonical = JSON.stringify({
    limits: {
      cursorTtlMs: limits.cursorTtlMs,
      maxCursorBytes: limits.maxCursorBytes,
      maxPageSize: limits.maxPageSize,
      maxPathBytes: limits.maxPathBytes,
      maxReadBytes: limits.maxReadBytes,
      maxSearchResults: limits.maxSearchResults,
      maxSearchScan: limits.maxSearchScan,
      maxWriteBytes: limits.maxWriteBytes,
    },
    mountId: configuration.mountId,
    operation,
    prefix: binding.prefix,
    scope: configuration.scope,
    store: binding.store,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

function issueFailure(error: unknown): Error {
  if (isStorageError(error)) {
    return workspaceError(error.code, 'Workspace cursor could not be issued.', {
      permanent: error.permanent,
    });
  }
  return workspaceError(
    StorageErrorCode.PROVIDER,
    'Workspace cursor codec failed while issuing a token.',
  );
}

function decodeFailure(error: unknown): Error {
  if (isStorageError(error)) {
    if (
      error.code === StorageErrorCode.INVALID_ARGUMENT ||
      error.code === StorageErrorCode.NOT_FOUND
    ) {
      return invalidCursor();
    }
    return workspaceError(
      error.code,
      'Workspace cursor codec failed while decoding a token.',
      { permanent: error.permanent },
    );
  }
  return workspaceError(
    StorageErrorCode.PROVIDER,
    'Workspace cursor codec failed while decoding a token.',
  );
}

function cursorNotConfigured(): Error {
  return workspaceError(
    StorageErrorCode.NOT_SUPPORTED,
    'Workspace pagination requires a configured cursor codec.',
    { permanent: true },
  );
}

function invalidCursor(): Error {
  return workspaceError(
    StorageErrorCode.INVALID_ARGUMENT,
    'Workspace cursor is invalid, expired, or belongs to another query.',
    { permanent: true },
  );
}

function cursorAad(keyId: string): Buffer {
  return Buffer.from(
    `@nestm/storage/workspace-cursor\0${TOKEN_VERSION}\0${keyId}`,
  );
}

function validKeyId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TOKEN_PART_PATTERN.test(value) &&
    encoder.encode(value).byteLength <= MAX_CURSOR_KEY_ID_BYTES
  );
}

function assertStableIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value !== value.normalize('NFC') ||
    forbiddenIdentityCharacter.test(value) ||
    encoder.encode(value).byteLength > MAX_CURSOR_SCOPE_BYTES
  ) {
    throw workspaceError(
      StorageErrorCode.INVALID_ARGUMENT,
      `${label} must be a non-empty stable NFC identity of at most ${MAX_CURSOR_SCOPE_BYTES} bytes.`,
      { permanent: true },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function searchMatch(value: unknown): value is StorageWorkspaceSearchMatch {
  return value === 'glob' || value === 'substring' || value === 'exact';
}

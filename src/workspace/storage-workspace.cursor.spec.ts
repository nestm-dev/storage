import { StorageErrorCode } from '../storage.error.js';

import {
  Aes256GcmStorageWorkspaceCursorCodec,
  STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
} from './storage-workspace.cursor.js';

const OLD_KEY = new Uint8Array(32).fill(0x11);
const NEW_KEY = new Uint8Array(32).fill(0x22);
const expiresAt = new Date('2026-08-14T12:00:00.000Z').getTime();

function codec(
  activeKeyId = 'current',
  keys: Readonly<Record<string, Uint8Array>> = { current: OLD_KEY },
): Aes256GcmStorageWorkspaceCursorCodec {
  return new Aes256GcmStorageWorkspaceCursorCodec({ activeKeyId, keys });
}

describe('Aes256GcmStorageWorkspaceCursorCodec', () => {
  it('round-trips opaque payloads across independently constructed replicas', () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        providerCursor: 'provider-secret',
        prefix: 'private/root',
      }),
    );
    const first = codec();
    const second = codec();

    const token = first.encode(payload, { expiresAt });

    expect(token).toMatch(/^swc1\.current\.[A-Za-z0-9_-]+$/u);
    expect(token.length).toBeLessThanOrEqual(
      STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
    );
    expect(token).not.toContain('provider-secret');
    expect(token).not.toContain('private/root');
    expect(second.decode(token)).toEqual(payload);
  });

  it('supports key rotation while issuing only with the active key', () => {
    const payload = new TextEncoder().encode('continuation');
    const oldCodec = codec('old', { old: OLD_KEY });
    const oldToken = oldCodec.encode(payload, { expiresAt });
    const rotating = codec('new', { new: NEW_KEY, old: OLD_KEY });

    expect(rotating.decode(oldToken)).toEqual(payload);
    const newToken = rotating.encode(payload, { expiresAt });
    expect(newToken).toMatch(/^swc1\.new\./u);
    expect(rotating.decode(newToken)).toEqual(payload);
    expect(() => codec('new', { new: NEW_KEY }).decode(oldToken)).toThrow(
      expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
    );
  });

  it.each([
    '',
    'swc0.current.payload',
    'swc1.unknown.payload',
    'swc1.current.not+base64url',
    `swc1.current.${'a'.repeat(STORAGE_WORKSPACE_MAX_CURSOR_BYTES)}`,
  ])('rejects malformed token %j', (token) => {
    expect(() => codec().decode(token)).toThrow(
      expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('rejects ciphertext and authentication-tag tampering', () => {
    const instance = codec();
    const token = instance.encode(new TextEncoder().encode('payload'), {
      expiresAt,
    });
    const final = token.at(-1);
    const tampered = `${token.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`;

    expect(() => instance.decode(tampered)).toThrow(
      expect.objectContaining({ code: StorageErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('rejects invalid key rings and oversized payloads', () => {
    expect(
      () =>
        new Aes256GcmStorageWorkspaceCursorCodec({
          activeKeyId: 'missing',
          keys: { current: OLD_KEY },
        }),
    ).toThrow(/activeKeyId/u);
    expect(
      () =>
        new Aes256GcmStorageWorkspaceCursorCodec({
          activeKeyId: 'short',
          keys: { short: new Uint8Array(31) },
        }),
    ).toThrow(/exactly 32 bytes/u);
    expect(() => codec().encode(new Uint8Array(3_000), { expiresAt })).toThrow(
      expect.objectContaining({ code: StorageErrorCode.LIMIT_EXCEEDED }),
    );
  });
});

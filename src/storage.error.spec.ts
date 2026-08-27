import {
  StorageError,
  StorageErrorCode,
  isStorageError,
  normalizeStorageError,
} from './storage.error.js';

describe('StorageError', () => {
  it('is recognized across duplicated package copies', () => {
    const brand = Symbol.for('@nestm/storage/StorageError');
    class ForeignStorageError extends Error {
      override readonly name = 'StorageError';
      readonly [brand] = true;
      readonly code = StorageErrorCode.NOT_FOUND;
      readonly store = 'foreign';
      readonly operation = 'head';
      readonly key = 'missing.bin';
      readonly aborted = false;
      readonly timedOut = false;
      readonly permanent = true;
      readonly applied = true;
      readonly appliedEtag = 'committed-etag';
    }

    const error = new ForeignStorageError('missing');
    expect(isStorageError(error)).toBe(true);
    expect(normalizeStorageError(error)).toBe(error);
    expect(error.applied).toBe(true);
    expect(error.appliedEtag).toBe('committed-etag');
  });

  it('recognizes the exact legacy structural shape without a brand', () => {
    const error = Object.assign(new Error('legacy'), {
      aborted: false,
      code: StorageErrorCode.PROVIDER,
      key: undefined,
      name: 'StorageError',
      operation: undefined,
      permanent: false,
      store: undefined,
      timedOut: false,
    });

    expect(isStorageError(error)).toBe(true);
  });

  it('defaults reconciliation metadata and preserves an applied ETag', () => {
    const unapplied = new StorageError('not committed', {
      code: StorageErrorCode.CONFLICT,
    });
    const applied = new StorageError('commit acknowledgement failed', {
      applied: true,
      appliedEtag: 'committed-etag',
      code: StorageErrorCode.PROVIDER,
    });

    expect(unapplied.applied).toBe(false);
    expect(unapplied.appliedEtag).toBeUndefined();
    expect(applied.applied).toBe(true);
    expect(applied.appliedEtag).toBe('committed-etag');
  });

  it('only retains a canonical applied ETag with positive applied evidence', () => {
    const unapplied = new StorageError('not committed', {
      appliedEtag: 'unconfirmed-etag',
      code: StorageErrorCode.PROVIDER,
    });
    const malformed = new StorageError('bad provider metadata', {
      applied: true,
      appliedEtag: '"quoted-etag"',
      code: StorageErrorCode.PROVIDER,
    });

    expect(unapplied.appliedEtag).toBeUndefined();
    expect(malformed.appliedEtag).toBeUndefined();
  });

  it.each([
    { applied: 'true' },
    { appliedEtag: 42 },
    { appliedEtag: '"quoted-etag"' },
    { applied: false, appliedEtag: 'unconfirmed-etag' },
  ])('rejects malformed reconciliation metadata: %o', (metadata) => {
    const error = Object.assign(new Error('foreign'), {
      aborted: false,
      code: StorageErrorCode.PROVIDER,
      name: 'StorageError',
      permanent: false,
      timedOut: false,
      ...metadata,
    });

    expect(isStorageError(error)).toBe(false);
  });

  it('does not classify unrelated errors from a coincidental code or name', () => {
    expect(
      isStorageError(
        Object.assign(new Error('provider'), {
          code: StorageErrorCode.NOT_FOUND,
        }),
      ),
    ).toBe(false);
    expect(
      isStorageError(
        Object.assign(new Error('incomplete'), {
          code: StorageErrorCode.NOT_FOUND,
          name: 'StorageError',
        }),
      ),
    ).toBe(false);
    expect(isStorageError({ code: StorageErrorCode.NOT_FOUND })).toBe(false);
  });

  it('brands owned errors without exposing the marker during enumeration', () => {
    const error = new StorageError('missing', {
      code: StorageErrorCode.NOT_FOUND,
    });

    expect(isStorageError(error)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        error,
        Symbol.for('@nestm/storage/StorageError'),
      ),
    ).toMatchObject({ enumerable: false, value: true, writable: false });
  });
});

export const StorageErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  CONFLICT: 'CONFLICT',
  READ_ONLY: 'READ_ONLY',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  ABORTED: 'ABORTED',
  TIMEOUT: 'TIMEOUT',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  PROVIDER: 'PROVIDER',
} as const;

export type StorageErrorCode =
  (typeof StorageErrorCode)[keyof typeof StorageErrorCode];

export interface StorageErrorOptions {
  code: StorageErrorCode;
  store?: string;
  operation?: string;
  key?: string;
  aborted?: boolean;
  timedOut?: boolean;
  permanent?: boolean;
  cause?: unknown;
}

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly store: string | undefined;
  readonly operation: string | undefined;
  readonly key: string | undefined;
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly permanent: boolean;
  override readonly cause?: unknown;

  constructor(message: string, options: StorageErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'StorageError';
    this.code = options.code;
    this.store = options.store;
    this.operation = options.operation;
    this.key = options.key;
    this.aborted = options.aborted === true;
    this.timedOut = options.timedOut === true;
    this.permanent = options.permanent === true;
    this.cause = options.cause;
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

export function normalizeStorageError(
  error: unknown,
  options: Omit<StorageErrorOptions, 'code' | 'cause'> & {
    code?: StorageErrorCode;
  } = {},
): StorageError {
  if (isStorageError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);

  return new StorageError(message, {
    ...options,
    cause: error,
    code: options.code ?? StorageErrorCode.PROVIDER,
  });
}

import {
  StorageError,
  StorageErrorCode,
  isStorageError,
} from '../storage.error.js';
import type { StorageErrorCode as StorageErrorCodeValue } from '../storage.error.js';

const STORAGE_WORKSPACE_ERROR_BRAND = Symbol('StorageWorkspaceError');

export class StorageWorkspaceError extends StorageError {
  declare readonly [STORAGE_WORKSPACE_ERROR_BRAND]: true;
  override readonly code: StorageErrorCodeValue;
  override readonly operation: string | undefined;
  readonly path: string | undefined;
  override readonly permanent: boolean;

  constructor(
    message: string,
    options: {
      applied?: boolean;
      appliedEtag?: string;
      code: StorageErrorCodeValue;
      operation?: string;
      path?: string;
      permanent?: boolean;
    },
  ) {
    super(message, {
      ...(options.applied !== undefined && { applied: options.applied }),
      ...(options.appliedEtag !== undefined && {
        appliedEtag: options.appliedEtag,
      }),
      code: options.code,
      ...(options.path !== undefined && { key: options.path }),
      ...(options.operation !== undefined && {
        operation: options.operation,
      }),
      permanent: options.permanent === true,
    });
    Object.defineProperty(this, STORAGE_WORKSPACE_ERROR_BRAND, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    this.name = 'StorageWorkspaceError';
    this.code = options.code;
    this.operation = options.operation;
    this.path = options.path;
    this.permanent = options.permanent === true;
  }
}

export function isStorageWorkspaceError(
  error: unknown,
): error is StorageWorkspaceError {
  if (error instanceof StorageWorkspaceError) {
    return true;
  }
  if (!(error instanceof Error) || error.name !== 'StorageWorkspaceError') {
    return false;
  }
  try {
    const candidate = error as Error & {
      readonly [STORAGE_WORKSPACE_ERROR_BRAND]?: unknown;
      readonly code?: unknown;
      readonly operation?: unknown;
      readonly path?: unknown;
      readonly permanent?: unknown;
    };
    return (
      candidate[STORAGE_WORKSPACE_ERROR_BRAND] === true &&
      Object.values(StorageErrorCode).includes(
        candidate.code as StorageErrorCodeValue,
      ) &&
      (candidate.operation === undefined ||
        typeof candidate.operation === 'string') &&
      (candidate.path === undefined || typeof candidate.path === 'string') &&
      typeof candidate.permanent === 'boolean'
    );
  } catch {
    return false;
  }
}

export function workspaceError(
  code: StorageErrorCodeValue,
  message: string,
  options: {
    applied?: boolean;
    appliedEtag?: string;
    operation?: string;
    path?: string;
    permanent?: boolean;
  } = {},
): StorageWorkspaceError {
  return new StorageWorkspaceError(message, { code, ...options });
}

export function sanitizeWorkspaceError(
  error: unknown,
  options: { operation: string; path?: string },
): StorageWorkspaceError {
  if (isStorageWorkspaceError(error)) {
    return error;
  }

  const code = isStorageError(error) ? error.code : StorageErrorCode.PROVIDER;
  const permanent = isStorageError(error) ? error.permanent : false;
  const applied = isStorageError(error) && error.applied;
  const appliedEtag = isStorageError(error) ? error.appliedEtag : undefined;
  const logicalPath = options.path;
  const target = logicalPath === undefined ? '' : ` for "${logicalPath}"`;

  return workspaceError(
    code,
    `Workspace ${options.operation} failed${target}.`,
    {
      applied,
      ...(appliedEtag !== undefined && { appliedEtag }),
      operation: options.operation,
      ...(logicalPath !== undefined && { path: logicalPath }),
      permanent,
    },
  );
}

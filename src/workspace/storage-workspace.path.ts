import { StorageErrorCode } from '../storage.error.js';

import { workspaceError } from './storage-workspace.error.js';

const FORBIDDEN_UNICODE_CHARACTER = /\p{C}/u;
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const encoder = new TextEncoder();

export function containsControlCharacter(value: string): boolean {
  return FORBIDDEN_UNICODE_CHARACTER.test(value);
}

function invalidPath(label: string, reason: string): never {
  throw workspaceError(
    StorageErrorCode.INVALID_ARGUMENT,
    `${label} ${reason}.`,
    { permanent: true },
  );
}

export function assertWorkspacePath(
  value: string,
  maxBytes: number,
  options: { allowRoot: boolean; label?: string },
): string {
  const label = options.label ?? 'path';
  if (typeof value !== 'string') {
    invalidPath(label, 'must be a string');
  }
  if (value.length === 0) {
    if (options.allowRoot) {
      return '';
    }
    invalidPath(label, 'must not be empty');
  }
  if (value.startsWith('/')) {
    invalidPath(label, 'must be relative');
  }
  if (value !== value.normalize('NFC')) {
    invalidPath(label, 'must use NFC Unicode normalization');
  }
  if (value.includes('\\')) {
    invalidPath(label, 'must use POSIX separators');
  }
  if (containsControlCharacter(value)) {
    invalidPath(label, 'must not contain control characters');
  }
  if (encoder.encode(value).byteLength > maxBytes) {
    invalidPath(label, `exceeds the ${maxBytes}-byte path limit`);
  }

  const segments = value.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      invalidPath(label, 'must not contain empty path segments');
    }
    if (segment === '.' || segment === '..') {
      invalidPath(label, 'must not contain . or .. segments');
    }
    if (segment.includes(':')) {
      invalidPath(label, 'must not contain colon characters');
    }
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      invalidPath(label, 'segments must not end with a dot or space');
    }
    if (WINDOWS_DEVICE_NAME.test(segment)) {
      invalidPath(label, 'must not contain a reserved device segment');
    }
  }
  return value;
}

export function workspaceBasename(path: string): string {
  const separator = path.lastIndexOf('/');
  return separator === -1 ? path : path.slice(separator + 1);
}

export function joinWorkspacePath(directory: string, path: string): string {
  return directory.length === 0 ? path : `${directory}/${path}`;
}

export function isPathInside(directory: string, path: string): boolean {
  return directory.length === 0 || path.startsWith(`${directory}/`);
}

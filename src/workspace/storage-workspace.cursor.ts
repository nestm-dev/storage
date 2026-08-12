import { randomBytes } from 'node:crypto';

import { StorageErrorCode } from '../storage.error.js';

import { workspaceError } from './storage-workspace.error.js';

interface CursorRecord<State> {
  readonly binding: string;
  readonly expiresAt: number;
  readonly state: State;
}

const MAX_ACTIVE_CURSORS = 1024;

export class StorageWorkspaceCursorStore {
  readonly #records = new Map<string, CursorRecord<unknown>>();

  issue<State>(binding: string, state: State, ttlMs: number): string {
    this.#prune();
    if (this.#records.size >= MAX_ACTIVE_CURSORS) {
      throw workspaceError(
        StorageErrorCode.LIMIT_EXCEEDED,
        'Workspace has too many active cursors.',
        { permanent: true },
      );
    }
    let cursor: string;
    do {
      cursor = randomBytes(24).toString('base64url');
    } while (this.#records.has(cursor));
    this.#records.set(cursor, {
      binding,
      expiresAt: Date.now() + ttlMs,
      state,
    });
    return cursor;
  }

  consume<State>(cursor: string, binding: string): State {
    if (!/^[A-Za-z0-9_-]{32}$/u.test(cursor)) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Workspace cursor has an invalid format.',
        { permanent: true },
      );
    }
    const record = this.#records.get(cursor);
    this.#records.delete(cursor);
    if (
      record === undefined ||
      record.expiresAt <= Date.now() ||
      record.binding !== binding
    ) {
      throw workspaceError(
        StorageErrorCode.INVALID_ARGUMENT,
        'Workspace cursor is invalid, expired, or belongs to another query.',
        { permanent: true },
      );
    }
    return record.state as State;
  }

  #prune(): void {
    const now = Date.now();
    for (const [cursor, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(cursor);
      }
    }
  }
}

import { StorageError } from '../storage.error.js';
import { storageInteger } from './storage-streams.js';

export type StorageTextChange =
  | { readonly kind: 'append'; readonly text: string }
  | {
      readonly kind: 'replace';
      readonly oldText: string;
      readonly newText: string;
    };
export type StorageTextEdit =
  | StorageTextChange
  | {
      readonly kind: 'batch';
      readonly changes: readonly StorageTextChange[];
    };
export interface StorageTextContext {
  /** UTF-8 byte position and one-based UTF-16 line/column of the snippet start. */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}
export interface StorageTextEditDiagnostic {
  readonly editIndex: number;
  readonly reason: 'empty_target' | 'missing_target' | 'ambiguous_target';
  /** Bounded source data from the intermediate buffer; no edits were persisted. */
  readonly contexts: readonly StorageTextContext[];
}
export class StorageTextEditConflict extends StorageError {
  readonly diagnostic: StorageTextEditDiagnostic;
  constructor(diagnostic: StorageTextEditDiagnostic) {
    super(
      'The replacement target must match exactly once. No edits were applied.',
      { code: 'CONFLICT' },
    );
    this.diagnostic = diagnostic;
  }
}

/** A bounded source window. Coordinates count UTF-16 columns, like JS parsers. */
export function storageTextContext(
  content: string,
  index: number,
): StorageTextContext {
  storageInteger(index, 'index');
  index = Math.min(index, content.length);
  let start = Math.max(0, index - 100);
  if (/[\uDC00-\uDFFF]/u.test(content.charAt(start))) start++;
  const before = content.slice(0, start);
  return {
    offset: new TextEncoder().encode(before).byteLength,
    line: before.split('\n').length,
    column: start - before.lastIndexOf('\n'),
    text: Array.from(content.slice(start, start + 640))
      .slice(0, 320)
      .join(''),
  };
}

/** Sequential exact edits in memory. The host persists only the complete result. */
export function applyStorageTextEdit(
  content: string,
  edit: StorageTextEdit,
  options: { readonly maxBytes: number; readonly maxEdits?: number },
): string {
  storageInteger(options.maxBytes, 'maxBytes');
  const changes = edit.kind === 'batch' ? edit.changes : [edit];
  storageInteger(options.maxEdits ?? 64, 'maxEdits', 1);
  if (changes.length < 1 || changes.length > (options.maxEdits ?? 64))
    throw new StorageError('Edit batch exceeds the operation limit.', {
      code: 'LIMIT_EXCEEDED',
    });
  const validate = (text: string) => {
    if (/[\uD800-\uDFFF]/u.test(text))
      throw new StorageError('Text must be well-formed UTF-8.', {
        code: 'INVALID_ARGUMENT',
      });
  };
  validate(content);
  for (const [editIndex, change] of changes.entries()) {
    if (change.kind === 'append') {
      validate(change.text);
      content += change.text;
    } else {
      validate(change.oldText);
      validate(change.newText);
      const first = content.indexOf(change.oldText);
      const second =
        first < 0 ? -1 : content.indexOf(change.oldText, first + 1);
      if (change.oldText.length === 0 || first < 0 || second >= 0) {
        const reason =
          change.oldText.length === 0
            ? 'empty_target'
            : first < 0
              ? 'missing_target'
              : 'ambiguous_target';
        // An anchor helps locate stale whitespace/context; it never relaxes matching.
        const anchor =
          change.oldText
            .split('\n')
            .find((line) => line.trim().length > 0)
            ?.trim()
            .slice(0, 80) ?? '';
        const near =
          anchor.length === 0 ? 0 : Math.max(0, content.indexOf(anchor));
        throw new StorageTextEditConflict({
          editIndex,
          reason,
          contexts: (reason === 'ambiguous_target'
            ? [first, second]
            : [near]
          ).map((at) => storageTextContext(content, at)),
        });
      }
      content =
        content.slice(0, first) +
        change.newText +
        content.slice(first + change.oldText.length);
    }
    if (new TextEncoder().encode(content).byteLength > options.maxBytes)
      throw new StorageError('Edited content exceeds the byte budget.', {
        code: 'LIMIT_EXCEEDED',
      });
  }
  return content;
}

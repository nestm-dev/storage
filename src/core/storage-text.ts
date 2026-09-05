import { StorageError } from '../storage.error.js';
import {
  readStorageTextWindow,
  storageInteger,
  type StorageRangeReader,
} from './storage-streams.js';

export interface StorageTextSearchOptions {
  readonly size: number;
  readonly query: string;
  readonly offset?: number | undefined;
  readonly maxScanBytes: number;
  readonly maxMatches: number;
  readonly maxSnippetCharacters: number;
  readonly maxReadBytes: number;
  readonly signal?: AbortSignal | undefined;
}
export interface StorageTextSearchResult {
  readonly matches: readonly {
    readonly offset: number;
    readonly text: string;
  }[];
  readonly nextOffset: number | null;
}

/** Literal, non-overlapping matches. Continuations retain cross-window candidates. */
export async function searchStorageText(
  read: StorageRangeReader,
  options: StorageTextSearchOptions,
): Promise<StorageTextSearchResult> {
  const { query, size, signal } = options;
  const encode = (text: string) => new TextEncoder().encode(text).byteLength;
  if (
    query.length === 0 ||
    query.length > 256 ||
    /[\uD800-\uDFFF]/u.test(query)
  )
    throw new StorageError('Query must contain 1–256 well-formed characters.', {
      code: 'INVALID_ARGUMENT',
    });
  storageInteger(size, 'size');
  storageInteger(options.maxReadBytes, 'maxReadBytes', 4);
  storageInteger(options.maxScanBytes, 'maxScanBytes', encode(query) + 4);
  storageInteger(options.maxMatches, 'maxMatches', 1);
  storageInteger(options.maxSnippetCharacters, 'maxSnippetCharacters', 1);
  let cursor = options.offset ?? 0;
  storageInteger(cursor, 'offset');
  if (cursor > size)
    throw new StorageError('Offset exceeds body size.', {
      code: 'INVALID_ARGUMENT',
    });
  let pending = '';
  let pendingOffset = cursor;
  let scanned = 0;
  const matches: { offset: number; text: string }[] = [];
  signal?.throwIfAborted();
  while (cursor < size && options.maxScanBytes - scanned >= 4) {
    const maxBytes = Math.min(
      options.maxReadBytes,
      options.maxScanBytes - scanned,
    );
    const page = await readStorageTextWindow(read, {
      size,
      offset: cursor,
      maxBytes,
      signal,
    });
    scanned += Math.min(maxBytes, size - cursor);
    const text = pending + page.content;
    const safeEnd =
      page.nextOffset === null
        ? text.length
        : Math.max(0, text.length - query.length + 1);
    let at = 0;
    for (;;) {
      const found = text.indexOf(query, at);
      if (found < 0 || found >= safeEnd) break;
      matches.push({
        offset: pendingOffset + encode(text.slice(0, found)),
        text: Array.from(text.slice(found))
          .slice(0, options.maxSnippetCharacters)
          .join(''),
      });
      at = found + query.length;
      if (matches.length === options.maxMatches) {
        const next = pendingOffset + encode(text.slice(0, at));
        return { matches, nextOffset: next < size ? next : null };
      }
    }
    let consumed = Math.max(at, safeEnd);
    if (consumed > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(consumed)))
      consumed--;
    pendingOffset += encode(text.slice(0, consumed));
    pending = text.slice(consumed);
    cursor = page.nextOffset ?? size;
  }
  return { matches, nextOffset: cursor < size ? pendingOffset : null };
}

export type StorageTextEdit =
  | { readonly kind: 'append'; readonly text: string }
  | {
      readonly kind: 'replace';
      readonly oldText: string;
      readonly newText: string;
    };

/** Whole-text operation; callers must also bound the original buffered read. */
export function applyStorageTextEdit(
  content: string,
  change: StorageTextEdit,
  options: { readonly maxBytes: number },
): string {
  storageInteger(options.maxBytes, 'maxBytes');
  const strings =
    change.kind === 'append'
      ? [content, change.text]
      : [content, change.oldText, change.newText];
  if (strings.some((value) => /[\uD800-\uDFFF]/u.test(value)))
    throw new StorageError('Text must be well-formed UTF-8.', {
      code: 'INVALID_ARGUMENT',
    });
  let result: string;
  if (change.kind === 'append') result = content + change.text;
  else {
    const first = content.indexOf(change.oldText);
    if (
      change.oldText.length === 0 ||
      first < 0 ||
      content.indexOf(change.oldText, first + 1) >= 0
    )
      throw new StorageError(
        'The replacement target must match exactly once.',
        { code: 'CONFLICT' },
      );
    result =
      content.slice(0, first) +
      change.newText +
      content.slice(first + change.oldText.length);
  }
  if (new TextEncoder().encode(result).byteLength > options.maxBytes)
    throw new StorageError('Edited content exceeds the byte budget.', {
      code: 'LIMIT_EXCEEDED',
    });
  return result;
}

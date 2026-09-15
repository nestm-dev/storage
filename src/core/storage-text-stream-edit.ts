import { StorageError } from '../storage.error.js';
import {
  StorageTextEditConflict,
  storageTextContext,
  type StorageTextChange,
} from './storage-text-edit.js';
import { storageInteger } from './storage-streams.js';

/** Exact ordered edits with bounded lookbehind. The consumer must stage before committing. */
export function editStorageTextStream(
  source: ReadableStream<Uint8Array>,
  changes: readonly StorageTextChange[],
  options: {
    readonly maxEditBytes: number;
    readonly maxEdits?: number;
    readonly signal?: AbortSignal;
  },
): ReadableStream<Uint8Array> {
  storageInteger(options.maxEditBytes, 'maxEditBytes', 1);
  const encoder = new TextEncoder();
  if (!changes.length || changes.length > (options.maxEdits ?? 64))
    throw new StorageError('Edit batch exceeds the operation limit.', {
      code: 'LIMIT_EXCEEDED',
    });
  let size = 0;
  for (const [editIndex, change] of changes.entries()) {
    for (const text of change.kind === 'append'
      ? [change.text]
      : [change.oldText, change.newText]) {
      if (/[\uD800-\uDFFF]/u.test(text))
        throw new StorageError('Text must be well-formed UTF-8.', {
          code: 'INVALID_ARGUMENT',
        });
      size += encoder.encode(text).byteLength;
    }
    if (change.kind === 'replace' && !change.oldText.length)
      throw new StorageTextEditConflict({
        editIndex,
        reason: 'empty_target',
        contexts: [],
      });
  }
  if (size > options.maxEditBytes)
    throw new StorageError('Edit text exceeds the per-operation limit.', {
      code: 'LIMIT_EXCEEDED',
    });
  let result = source;
  for (const [editIndex, change] of changes.entries()) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let pending = '';
    let consumed = 0;
    let byteOffset = 0;
    let line = 1;
    let column = 1;
    let skipUntil = 0;
    let matches = 0;
    const contexts: ReturnType<typeof storageTextContext>[] = [];
    let firstContext: ReturnType<typeof storageTextContext> | undefined;
    const process = (
      text: string,
      final: boolean,
      output: TransformStreamDefaultController<Uint8Array>,
    ) => {
      options.signal?.throwIfAborted();
      pending += text;
      firstContext ??= pending.length
        ? storageTextContext(pending, 0)
        : undefined;
      const target = change.kind === 'replace' ? change.oldText : '';
      let end =
        final || !target.length
          ? pending.length
          : Math.max(0, pending.length - target.length + 1);
      if (end < pending.length && /[\uDC00-\uDFFF]/u.test(pending.charAt(end)))
        end--;
      let start = Math.min(end, Math.max(0, skipUntil - consumed));
      if (change.kind === 'replace') {
        for (
          let found = pending.indexOf(target);
          found >= 0 && found < end;
          found = pending.indexOf(target, found + 1)
        ) {
          const context = storageTextContext(pending, found);
          contexts.push({
            ...context,
            offset: byteOffset + context.offset,
            line: line + context.line - 1,
            column:
              context.line === 1 ? column + context.column - 1 : context.column,
          });
          if (++matches > 1)
            throw new StorageTextEditConflict({
              editIndex,
              reason: 'ambiguous_target',
              contexts,
            });
          if (found > start)
            output.enqueue(encoder.encode(pending.slice(start, found)));
          if (change.newText) output.enqueue(encoder.encode(change.newText));
          skipUntil = consumed + found + target.length;
          start = Math.min(end, skipUntil - consumed);
        }
      }
      if (start < end)
        output.enqueue(encoder.encode(pending.slice(start, end)));
      const prefix = pending.slice(0, end);
      const lastNewline = prefix.lastIndexOf('\n');
      line += prefix.split('\n').length - 1;
      column =
        lastNewline < 0 ? column + prefix.length : prefix.length - lastNewline;
      byteOffset += encoder.encode(prefix).byteLength;
      consumed += end;
      pending = pending.slice(end);
      if (final) {
        if (change.kind === 'replace' && matches !== 1)
          throw new StorageTextEditConflict({
            editIndex,
            reason: 'missing_target',
            contexts: firstContext ? [firstContext] : [],
          });
        if (change.kind === 'append' && change.text)
          output.enqueue(encoder.encode(change.text));
      }
    };
    result = result.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, output) {
          process(decoder.decode(chunk, { stream: true }), false, output);
        },
        flush(output) {
          process(decoder.decode(), true, output);
        },
      }),
      options.signal ? { signal: options.signal } : {},
    );
  }
  return result;
}

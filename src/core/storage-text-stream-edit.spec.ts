import { describe, expect, it } from 'vitest';
import {
  applyStorageTextEdit,
  type StorageTextChange,
} from './storage-text-edit.js';
import { collectStorageBytes } from './storage-streams.js';
import { editStorageTextStream } from './storage-text-stream-edit.js';

async function edit(
  text: string,
  changes: StorageTextChange[],
  chunkSize: number,
) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
  return new TextDecoder().decode(
    await collectStorageBytes(
      editStorageTextStream(stream, changes, { maxEditBytes: 10000 }),
      1000000,
    ),
  );
}

describe('streaming exact edits', () => {
  it('matches ordered in-memory semantics across every small byte boundary', async () => {
    for (const text of [
      'abc😀déf\nhello\nend',
      'aaaaab',
      'x\ufeffy😀z',
      '',
      'first\nsecond',
    ]) {
      const changes: StorageTextChange[] = text.length
        ? [
            { kind: 'replace', oldText: text.slice(0, 1), newText: 'Ω😀' },
            { kind: 'append', text: '!' },
          ]
        : [{ kind: 'append', text: 'Ω😀' }];
      let expected: string | undefined;
      try {
        expected = applyStorageTextEdit(
          text,
          { kind: 'batch', changes },
          { maxBytes: 10000 },
        );
      } catch {
        /* Ambiguity must reject both implementations. */
      }
      for (let width = 1; width < 12; width++) {
        if (expected === undefined)
          await expect(edit(text, changes, width)).rejects.toMatchObject({
            code: 'CONFLICT',
          });
        else expect(await edit(text, changes, width)).toBe(expected);
      }
    }
  });
  it('detects overlapping matches and missing later edits without accepting partial output', async () => {
    for (let width = 1; width < 8; width++) {
      await expect(
        edit(
          'aaaa',
          [{ kind: 'replace', oldText: 'aaa', newText: 'X' }],
          width,
        ),
      ).rejects.toMatchObject({ diagnostic: { reason: 'ambiguous_target' } });
      await expect(
        edit(
          'one',
          [
            { kind: 'replace', oldText: 'one', newText: 'two' },
            { kind: 'replace', oldText: 'absent', newText: 'x' },
          ],
          width,
        ),
      ).rejects.toMatchObject({
        diagnostic: { editIndex: 1, reason: 'missing_target' },
      });
      expect(
        await edit(
          'before😀targetafter',
          [
            { kind: 'replace', oldText: '😀target', newText: 'z' },
            { kind: 'replace', oldText: 'zafter', newText: 'done' },
          ],
          width,
        ),
      ).toBe('beforedone');
    }
  });
});

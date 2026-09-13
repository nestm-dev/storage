import {
  applyStorageTextEdit,
  StorageTextEditConflict,
  storageTextContext,
} from './storage-text-edit.js';

describe('atomic exact text edits', () => {
  it('applies dependent changes to plain Unicode text without altering unrelated bytes', () => {
    expect(
      applyStorageTextEdit(
        '\uFEFFone\r\n😀 two\r\nend',
        {
          kind: 'batch',
          changes: [
            { kind: 'replace', oldText: 'one', newText: 'first' },
            { kind: 'replace', oldText: 'first\r\n', newText: '1\r\n' },
            { kind: 'append', text: '\r\nlast' },
          ],
        },
        { maxBytes: 100 },
      ),
    ).toBe('\uFEFF1\r\n😀 two\r\nend\r\nlast');
  });
  it('rejects the whole batch with bounded context for the failed intermediate target', () => {
    const original = 'start\n😀 repeat repeat\n' + 'z'.repeat(5000);
    try {
      applyStorageTextEdit(
        original,
        {
          kind: 'batch',
          changes: [
            { kind: 'replace', oldText: 'start', newText: 'changed' },
            { kind: 'replace', oldText: 'repeat', newText: 'new' },
          ],
        },
        { maxBytes: 10000 },
      );
      expect.fail('Expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageTextEditConflict);
      expect(error).toMatchObject({
        applied: false,
        diagnostic: {
          editIndex: 1,
          reason: 'ambiguous_target',
          contexts: [{ line: 1 }, { line: 1 }],
        },
      });
      if (error instanceof StorageTextEditConflict)
        for (const context of error.diagnostic.contexts)
          expect(Array.from(context.text).length).toBeLessThanOrEqual(320);
    }
    expect(original.startsWith('start')).toBe(true);
  });
  it('provides an anchor for a missing target without fuzzy replacement', () => {
    expect(() =>
      applyStorageTextEdit(
        'prefix\nselected line\nupdated',
        { kind: 'replace', oldText: 'selected line\nold', newText: 'new' },
        { maxBytes: 100 },
      ),
    ).toThrow(
      expect.objectContaining({
        diagnostic: expect.objectContaining({ reason: 'missing_target' }),
      }),
    );
  });
  it('rejects overlapping occurrences, invalid Unicode, excess edits and excess output', () => {
    expect(() =>
      applyStorageTextEdit(
        'aaa',
        { kind: 'replace', oldText: 'aa', newText: 'b' },
        { maxBytes: 10 },
      ),
    ).toThrow(StorageTextEditConflict);
    expect(() =>
      applyStorageTextEdit(
        'a',
        { kind: 'append', text: '\uD800' },
        { maxBytes: 10 },
      ),
    ).toThrow(/well-formed/);
    expect(() =>
      applyStorageTextEdit(
        'a',
        { kind: 'batch', changes: [] },
        { maxBytes: 10 },
      ),
    ).toThrow(/limit/);
    expect(() =>
      applyStorageTextEdit(
        'a',
        { kind: 'append', text: '😀' },
        { maxBytes: 4 },
      ),
    ).toThrow(/budget/);
  });
  it('reports source offsets in UTF-8 bytes and keeps surrogate pairs intact', () => {
    const text = '😀'.repeat(75) + '\nabc';
    const context = storageTextContext(text, 151);
    expect(context.offset).toBe(104);
    expect(context.column).toBe(53);
    expect(/[\uD800-\uDFFF]/u.test(context.text)).toBe(false);
  });
});

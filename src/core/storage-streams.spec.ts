import { applyStorageTextEdit, searchStorageText } from './storage-text.js';
import {
  collectStorageBytes,
  readStorageTextWindow,
  storageBytesStream,
  type StorageRangeReader,
} from './storage-streams.js';

const bytes = (text: string) => new TextEncoder().encode(text);
function reader(text: string) {
  const source = bytes(text);
  return vi.fn<StorageRangeReader>(async (range) =>
    storageBytesStream(source.slice(range.start, range.end + 1)),
  );
}

describe('bounded text and stream mechanics', () => {
  it('cancels overflow and pending reads on abort', async () => {
    const cancel = vi.fn();
    const oversized = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(5));
      },
      cancel,
    });
    await expect(collectStorageBytes(oversized, 4)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    expect(cancel).toHaveBeenCalledOnce();
    const control = new AbortController();
    const cancelPending = vi.fn();
    const pending = collectStorageBytes(
      new ReadableStream<Uint8Array>({ cancel: cancelPending }),
      4,
      control.signal,
    );
    control.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelPending).toHaveBeenCalledOnce();
  });
  it('preserves BOM and splits windows only at complete UTF-8 boundaries', async () => {
    const text = '\ufeffAé😀日本B';
    const read = reader(text);
    let offset = 0;
    let result = '';
    for (;;) {
      const page = await readStorageTextWindow(read, {
        size: bytes(text).length,
        maxBytes: 4,
        offset,
      });
      result += page.content;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(result).toBe(text);
    expect(
      read.mock.calls.every(([range]) => range.end - range.start < 4),
    ).toBe(true);
    await expect(
      readStorageTextWindow(read, {
        size: bytes(text).length,
        maxBytes: 4,
        offset: 1,
      }),
    ).rejects.toThrow();
  });
  it('rejects truncated/malformed terminal bytes instead of hiding them', async () => {
    for (const data of [
      [0x61, 0xe2, 0x82],
      [0x61, 0xff],
      [0xed, 0xa0, 0x80],
    ]) {
      await expect(
        readStorageTextWindow(
          async () => storageBytesStream(new Uint8Array(data)),
          { size: data.length, maxBytes: 4 },
        ),
      ).rejects.toThrow();
    }
    await expect(
      readStorageTextWindow(async () => storageBytesStream(bytes('a')), {
        size: 2,
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER' });
  });
  it('finds matches across windows and scan pages without exceeding requested byte budgets', async () => {
    const text = 'a😀跨界needle é '.repeat(12);
    const size = bytes(text).length;
    let offset = 0;
    const found: number[] = [];
    const read = reader(text);
    for (;;) {
      const before = read.mock.calls.length;
      const result = await searchStorageText(read, {
        size,
        query: '跨界needle',
        offset,
        maxScanBytes: 25,
        maxMatches: 2,
        maxSnippetCharacters: 8,
        maxReadBytes: 9,
      });
      expect(
        read.mock.calls
          .slice(before)
          .reduce((sum, [range]) => sum + range.end - range.start + 1, 0),
      ).toBeLessThanOrEqual(25);
      found.push(...result.matches.map((match) => match.offset));
      if (result.nextOffset === null) break;
      expect(result.nextOffset).toBeGreaterThan(offset);
      offset = result.nextOffset;
    }
    expect(found).toEqual(
      Array.from(
        { length: 12 },
        (_, index) =>
          index * bytes('a😀跨界needle é ').length + bytes('a😀').length,
      ),
    );
  });
  it('advances empty search pages and preserves unique replacement semantics', async () => {
    const read = reader('😀'.repeat(30));
    expect(
      (
        await searchStorageText(read, {
          size: 120,
          query: 'missing',
          maxScanBytes: 20,
          maxMatches: 4,
          maxSnippetCharacters: 8,
          maxReadBytes: 8,
        })
      ).nextOffset,
    ).toBeGreaterThan(0);
    expect(
      applyStorageTextEdit(
        'a😀b',
        { kind: 'replace', oldText: '😀', newText: 'é' },
        { maxBytes: 4 },
      ),
    ).toBe('aéb');
    expect(() =>
      applyStorageTextEdit(
        'aaa',
        { kind: 'replace', oldText: 'aa', newText: 'b' },
        { maxBytes: 100 },
      ),
    ).toThrow(/exactly once/u);
    expect(() =>
      applyStorageTextEdit(
        'a',
        { kind: 'append', text: '😀' },
        { maxBytes: 4 },
      ),
    ).toThrow(/budget/u);
  });
});

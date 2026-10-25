// Text editor (ADR-051): UTF-8 in and out, keeping the byte-order mark and Windows line endings.
import { describe, expect, it } from 'vitest';
import { NotTextError, decodeText, encodeText } from '../../src/web/editors/text/codec';

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)),
  );
const back = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('text files', () => {
  it('reads UTF-8 and writes it back byte for byte', async () => {
    const src = bytes('Halo, dunia — café ✓\nbaris dua\n');
    const f = decodeText(src);
    expect(f).toEqual({ text: 'Halo, dunia — café ✓\nbaris dua\n', bom: false, crlf: false });
    expect(await back(encodeText(f.text, f, 'text/plain'))).toEqual(src);
  });

  it('keeps a byte-order mark and Windows line endings', async () => {
    const src = bytes([0xef, 0xbb, 0xbf], 'a\r\nb\r\n');
    const f = decodeText(src);
    expect(f.bom).toBe(true);
    expect(f.crlf).toBe(true);
    expect(f.text.startsWith('a')).toBe(true);
    // The editor hands back "\n" lines.
    expect(await back(encodeText('a\nb\nc', f, 'text/plain'))).toEqual(
      bytes([0xef, 0xbb, 0xbf], 'a\r\nb\r\nc'),
    );
  });

  it('refuses what is not UTF-8 text', () => {
    expect(() => decodeText(new Uint8Array([0x48, 0xe9, 0x6c]))).toThrow(NotTextError); // Latin-1 "Hél"
    expect(() => decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toThrow(NotTextError);
  });

  it('opens an empty file', () => {
    expect(decodeText(new Uint8Array())).toEqual({ text: '', bom: false, crlf: false });
  });
});

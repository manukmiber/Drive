// ZIP viewer (ADR-051): the archive's list, safe paths, and files that come out checked.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { contents, filesUnder } from '../../src/web/editors/zip/tree';
import {
  crc32,
  isJunk,
  listZip,
  readEntry,
  safePath,
  ZipError,
} from '../../src/web/editors/zip/zip';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ZIP list', () => {
  const zip = zipSync({
    'laporan/2026/kas.csv': strToU8('a;b\n1;2\n'),
    'laporan/catatan.txt': [strToU8('halo '.repeat(1000)), { level: 9 }],
    'foto.jpg': [new Uint8Array([1, 2, 3]), { level: 0 }],
    'kosong/': new Uint8Array(0),
  });

  it('lists names, sizes and folders', () => {
    const list = listZip(zip);
    expect(list.map((e) => [e.name, e.dir, e.size])).toEqual([
      ['laporan/2026/kas.csv', false, 8],
      ['laporan/catatan.txt', false, 5000],
      ['foto.jpg', false, 3],
      ['kosong/', true, 0],
    ]);
    expect(list.every((e) => !e.encrypted)).toBe(true);
  });

  it('reads stored and deflated files back, checked against their CRC', async () => {
    const list = listZip(zip);
    expect(text(await readEntry(zip, list[0]!))).toBe('a;b\n1;2\n');
    expect(text(await readEntry(zip, list[1]!))).toBe('halo '.repeat(1000));
    expect([...(await readEntry(zip, list[2]!))]).toEqual([1, 2, 3]);
  });

  it('refuses a damaged file instead of handing out wrong bytes', async () => {
    const bad = zip.slice();
    const e = listZip(bad)[2]!; // stored, so its bytes are in the archive as they are
    const start = e.offset + 30 + 'foto.jpg'.length;
    bad[start] = 9;
    await expect(readEntry(bad, e)).rejects.toThrow(ZipError);
  });

  it('knows password-protected files without unpacking them', async () => {
    const locked = zip.slice();
    // Set the "encrypted" flag on the first entry of the central directory (PK\1\2).
    for (let i = 0; i < locked.length - 4; i++)
      if (
        locked[i] === 0x50 &&
        locked[i + 1] === 0x4b &&
        locked[i + 2] === 1 &&
        locked[i + 3] === 2
      ) {
        locked[i + 8]! |= 1;
        break;
      }
    const e = listZip(locked)[0]!;
    expect(e.encrypted).toBe(true);
    await expect(readEntry(locked, e)).rejects.toThrow('encrypted');
  });

  it('says so when it is not a ZIP', () => {
    expect(() => listZip(strToU8('bukan zip sama sekali'))).toThrow(ZipError);
    expect(() => listZip(new Uint8Array(0))).toThrow(ZipError);
  });

  it('computes the CRC-32 every ZIP uses', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
});

describe('ZIP paths', () => {
  it('keeps every file inside the folder it is unpacked to', () => {
    expect(safePath('../../etc/passwd')).toEqual(['etc', 'passwd']);
    expect(safePath('/abs/file.txt')).toEqual(['abs', 'file.txt']);
    expect(safePath('C:\\Users\\a\\..\\b.txt')).toEqual(['Users', 'a', 'b.txt']);
    expect(safePath('a/./b/ c .txt')).toEqual(['a', 'b', 'c .txt']);
    expect(safePath('nama\u0000aneh\u001f.txt')).toEqual(['namaaneh.txt']);
    expect(safePath('folder.../file. ')).toEqual(['folder', 'file']);
  });

  it('leaves out what Macs and Windows add', () => {
    expect(isJunk(['__MACOSX', 'a', '._foto.jpg'])).toBe(true);
    expect(isJunk(['a', '.DS_Store'])).toBe(true);
    expect(isJunk(['a', 'Thumbs.db'])).toBe(true);
    expect(isJunk(['a', 'foto.jpg'])).toBe(false);
  });
});

describe('ZIP folders', () => {
  const entries = listZip(
    zipSync({
      'b/2.txt': strToU8('22'),
      'b/10.txt': strToU8('1010'),
      'a/x/y.txt': strToU8('y'),
      'top.txt': strToU8('t'),
    }),
  );

  it('shows the folders and files of one folder, in natural order', () => {
    const root = contents(entries, []);
    expect(root.folders).toEqual([
      { name: 'a', files: 1, size: 1 },
      { name: 'b', files: 2, size: 6 },
    ]);
    expect(root.files.map((e) => e.name)).toEqual(['top.txt']);
    expect(contents(entries, ['b']).files.map((e) => e.name)).toEqual(['b/2.txt', 'b/10.txt']);
    expect(contents(entries, ['a']).folders.map((f) => f.name)).toEqual(['x']);
  });

  it('takes a ticked folder as everything in it', () => {
    expect(filesUnder(entries, ['b']).map((e) => e.name)).toEqual(['b/2.txt', 'b/10.txt']);
    expect(filesUnder(entries, ['top.txt']).map((e) => e.name)).toEqual(['top.txt']);
    expect(filesUnder(entries, ['bb'])).toEqual([]);
  });
});

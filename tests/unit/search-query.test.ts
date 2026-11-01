// D6 (ADR-090): the search syntax, in Indonesian and English, and what it does with odd input.
import { describe, expect, it } from 'vitest';
import {
  datePeriod,
  hasCriteria,
  highlightRanges,
  parseSearch,
  sizeBound,
  toQuery,
  wordsMatch,
} from '../../src/shared/search-query';

const WIB = 7 * 3600_000;

describe('parseSearch', () => {
  it('reads words, phrases, exclusions and OR the way Google does', () => {
    const p = parseSearch('nota ATAU kuitansi 2024 "laporan akhir" -draf -"versi lama"');
    expect(p.groups.map((g) => g.map((t) => t.raw))).toEqual([
      ['nota', 'kuitansi'],
      ['2024'],
      ['laporan akhir'],
    ]);
    expect(p.groups[2]![0]!.phrase).toBe(true);
    expect(p.exclude.map((t) => t.raw)).toEqual(['draf', 'versi lama']);
    expect(parseSearch('invoice OR receipt').groups).toHaveLength(1);
    // A leading OR has nothing to join.
    expect(parseSearch('OR foto').groups.map((g) => g.length)).toEqual([1]);
  });

  it('knows the filters in both languages', () => {
    const id = parseSearch(
      'jenis:gambar ext:.PDF setelah:2024-01 sebelum:2024-03-15 tanggal:diambil ukuran:>10mb ukuran:<=1,5gb di:"Foto Liburan" ruang:keluarga berbintang dibagikan cocok:kata urut:tanggal',
    );
    const en = parseSearch(
      'type:image ext:pdf after:2024-01 before:2024-03-15 date:taken size:>10mb size:<=1.5gb in:"Foto Liburan" space:family is:starred shared match:word sort:date',
    );
    for (const p of [id, en]) {
      expect(p.types).toEqual(['image']);
      expect(p.exts).toEqual(['pdf']);
      expect(p.after).toBe(Date.UTC(2024, 0, 1) - WIB);
      expect(p.before).toBe(Date.UTC(2024, 2, 15) - WIB);
      expect(p.dateField).toBe('taken');
      expect(p.minSize).toBe(10 * 1024 ** 2 + 1);
      expect(p.maxSize).toBe(Math.round(1.5 * 1024 ** 3));
      expect(p.inFolder).toBe('Foto Liburan');
      expect(p.space).toBe('family');
      expect(p.starred && p.shared).toBe(true);
      expect(p.match).toBe('word');
      expect(p.sort).toBe('date');
      expect(p.groups).toEqual([]);
      expect(p.warnings).toEqual([]);
    }
  });

  it('never throws: bad values are warnings, unknown keys are words', () => {
    const p = parseSearch(
      'jenis:roket setelah:kemarin ukuran:besar ruang:mars cocok:x urut:y foo:bar',
    );
    expect(p.warnings).toHaveLength(6);
    expect(p.groups.map((g) => g[0]!.raw)).toEqual(['foo:bar']);
    for (const odd of [
      '"',
      '""',
      '-',
      '- -',
      '"unclosed phrase',
      'jenis:',
      ':::',
      'NEAR(a b) AND * ^ "x" OR',
      '\u0000￿',
      'a'.repeat(5000),
      '-"" OR OR ATAU',
      'di:""',
    ])
      expect(() => parseSearch(odd)).not.toThrow();
    expect(parseSearch('a b c d e f g h i j').groups).toHaveLength(8);
    expect(hasCriteria(parseSearch('   '))).toBe(false);
    expect(hasCriteria(parseSearch('berbintang'))).toBe(true);
  });

  it('puts a query back together so the filter panel and the box agree', () => {
    for (const q of [
      'nota ATAU kuitansi "laporan akhir" -draf jenis:pdf setelah:2024-01-01 sebelum:2024-03-01 ukuran:>=10mb di:"Foto Liburan" ruang:pribadi berbintang cocok:kata urut:tanggal',
      'type:video tanggal:dibuat after:2023 size:<1gb',
    ]) {
      const once = parseSearch(q);
      const again = parseSearch(toQuery(once));
      expect({ ...again, warnings: [] }).toEqual({ ...once, warnings: [] });
    }
  });
});

describe('matching and highlighting', () => {
  it('matches word prefixes by default, whole words on request, phrases in order', () => {
    expect(wordsMatch('Laporan-Keuangan_2024.pdf', parseSearch('lap keu'))).toBe(true);
    expect(wordsMatch('Laporan-Keuangan_2024.pdf', parseSearch('lap keu cocok:kata'))).toBe(false);
    expect(wordsMatch('Laporan-Keuangan_2024.pdf', parseSearch('laporan cocok:kata'))).toBe(true);
    expect(wordsMatch('laporan akhir tahun.docx', parseSearch('"laporan akhir"'))).toBe(true);
    expect(wordsMatch('akhir laporan.docx', parseSearch('"laporan akhir"'))).toBe(false);
    expect(wordsMatch('Résumé.pdf', parseSearch('resume'))).toBe(true);
    expect(wordsMatch('nota.pdf', parseSearch('nota -nota'))).toBe(false);
    expect(wordsMatch('kuitansi.jpg', parseSearch('nota ATAU kuitansi'))).toBe(true);
  });

  it('marks the matched part of each word', () => {
    const name = 'Laporan Keuangan 2024.pdf';
    const ranges = highlightRanges(name, parseSearch('lap 2024'));
    expect(ranges.map(([a, b]) => name.slice(a, b))).toEqual(['Lap', '2024']);
    expect(highlightRanges('Résumé final', parseSearch('resu'))).toEqual([[0, 4]]);
  });

  it('reads periods in WIB and sizes with units', () => {
    expect(datePeriod('2024')).toEqual({
      start: Date.UTC(2024, 0, 1) - WIB,
      end: Date.UTC(2025, 0, 1) - WIB,
    });
    expect(datePeriod('2024-02-30')).toBeNull();
    expect(datePeriod('2024-13')).toBeNull();
    expect(sizeBound('>10MB')).toEqual({ op: '>', bytes: 10 * 1024 ** 2 });
    expect(sizeBound('500kb')).toEqual({ op: '>=', bytes: 500 * 1024 });
    expect(sizeBound('10 parsec')).toBeNull();
  });
});

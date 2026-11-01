// D6 (ADR-090): taking text from files in the browser (the parts that need no DOM or pdf.js).
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { textKind } from '../../src/shared/mime';
import { basicText, tidyText, xlsxText } from '../../src/web/lib/content-text-basic';

describe('content text', () => {
  it('knows which files it can read', () => {
    expect(textKind('laporan.PDF', null)).toBe('pdf');
    expect(textKind('surat.docx', 'application/octet-stream')).toBe('docx');
    expect(textKind('data.xlsx', null)).toBe('xlsx');
    expect(textKind('main.rs', null)).toBe('text');
    expect(textKind('catatan', 'text/plain')).toBe('text');
    expect(textKind('foto.jpg', 'image/jpeg')).toBeNull();
    expect(textKind('lama.doc', null)).toBeNull();
  });

  it('folds whitespace and cuts on whole characters', () => {
    expect(tidyText('a\u0000b \t c\r\n\n\n d', 100)).toBe('ab c\nd');
    expect(tidyText('😀😀😀', 2)).toBe('😀😀');
  });

  it('reads shared strings and inline cells of a spreadsheet', async () => {
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8(
        '<sst><si><t>Nama</t></si><si><t xml:space="preserve">Budi &amp; Sari</t></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row><c t="inlineStr"><is><t>Total gaji</t></is></c></row></sheetData></worksheet>',
      ),
      'xl/styles.xml': strToU8('<styleSheet><t>bukan teks</t></styleSheet>'),
    });
    expect(await xlsxText(xlsx, 1000)).toBe('Nama\nBudi & Sari\nTotal gaji');
    const blob = new Blob([xlsx]);
    expect(await basicText(blob, 'gaji.xlsx', null, 1000)).toBe('Nama\nBudi & Sari\nTotal gaji');
    expect(
      tidyText((await basicText(new Blob(['halo dunia']), 'a.txt', 'text/plain', 4))!, 4),
    ).toBe('halo');
    expect(await basicText(new Blob(['%PDF']), 'a.pdf', null, 100)).toBeUndefined();
    expect(await basicText(new Blob(['x']), 'a.jpg', null, 100)).toBeNull();
    await expect(basicText(new Blob(['xx']), 'rusak.xlsx', null, 100)).rejects.toThrow();
  });
});

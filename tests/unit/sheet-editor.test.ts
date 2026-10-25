// Spreadsheet (ADR-051): CSV in and out, and numbers that stay numbers through an .xlsx.
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  cellText,
  detectDelimiter,
  parseCsv,
  rowsOf,
  sheetFromRows,
  textCell,
  toCsv,
  type SheetData,
} from '../../src/web/editors/sheet/csv';
import { numberCells, typeNumbers } from '../../src/web/editors/sheet/xlsx';

describe('CSV', () => {
  it('finds the separator of the first line, outside quotes', () => {
    expect(detectDelimiter('a;b;"c,d"\n1;2;3')).toBe(';');
    expect(detectDelimiter('a,b\n1;2;3;4')).toBe(',');
    expect(detectDelimiter('a\tb\tc')).toBe('\t');
    expect(detectDelimiter('satu kolom')).toBe(',');
  });

  it('reads quotes, doubled quotes, line breaks inside quotes and Windows lines', () => {
    const text = '﻿Nama;Catatan\r\nBudi;"lunas; tunai"\r\nSiti;"kata ""oke""\nbaris dua"\r\n';
    expect(parseCsv(text, ';')).toEqual([
      ['Nama', 'Catatan'],
      ['Budi', 'lunas; tunai'],
      ['Siti', 'kata "oke"\nbaris dua'],
    ]);
    expect(parseCsv('a,b\n1,', ',')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });

  it('writes back with the same separator, quoting only what needs it', () => {
    const rows = [
      ['Nama', 'Catatan'],
      ['Budi', 'lunas; tunai'],
      ['Siti', 'kata "oke"'],
      ['Andi', 'baru, koma'],
    ];
    expect(toCsv(rows, ';')).toBe(
      'Nama;Catatan\r\nBudi;"lunas; tunai"\r\nSiti;"kata ""oke"""\r\nAndi;baru, koma\r\n',
    );
    expect(parseCsv(toCsv(rows, ','), ',')).toEqual(rows);
  });

  it('makes numbers of plain decimals only, so phone numbers and codes stay as typed', () => {
    expect(textCell('12500')).toMatchObject({ v: 12500, ct: { t: 'n' } });
    expect(textCell('-3.25')).toMatchObject({ v: -3.25, ct: { t: 'n' } });
    for (const s of ['0812345678', '1e5', '1.000,50', '1234567890123456', ' 7'])
      expect(textCell(s)).toMatchObject({ v: s, ct: { t: 's' } });
  });

  it('reads a sheet back as rows, without the empty edges', () => {
    const sheet = sheetFromRows(
      [
        ['Nama', 'Jumlah'],
        ['Budi', '12500'],
      ],
      'Lembar1',
    );
    const data: Array<Array<(typeof sheet.celldata)[number]['v'] | null>> = [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ];
    for (const { r, c, v } of sheet.celldata) data[r]![c] = v;
    expect(rowsOf(data)).toEqual([
      ['Nama', 'Jumlah'],
      ['Budi', '12500'],
    ]);
  });

  it('writes what a cell holds: numbers as numbers, rich text joined', () => {
    expect(cellText({ v: 1000, m: 'Rp1.000', ct: { t: 'n' } })).toBe('1000');
    expect(cellText({ ct: { t: 'inlineStr', s: [{ v: 'Sura' }, { v: 'baya' }] } })).toBe(
      'Surabaya',
    );
    expect(cellText({ v: 'x', m: 'x' })).toBe('x');
    expect(cellText(null)).toBe('');
  });
});

describe('.xlsx numbers', () => {
  it('finds the cells Excel keeps as numbers, formula results included', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Penjualan');
    ws.addRow(['Kota', 'Jan', 'Total']);
    ws.addRow(['Jakarta', 100, { formula: 'B2*2', result: 200 }]);
    ws.addRow(['0812', '7', null]);
    const bytes = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    const cells = await numberCells(bytes);
    expect([...(cells.get('Penjualan') ?? [])].sort()).toEqual(['1_1', '1_2']);
  });

  it('turns those cells back into numbers and leaves text alone', () => {
    const sheets: SheetData[] = [
      {
        name: 'Penjualan',
        celldata: [
          { r: 1, c: 1, v: { v: '100' } },
          { r: 1, c: 2, v: { v: '200', f: '=B2*2', ct: { fa: '#,##0', t: 'n' } } },
          { r: 2, c: 0, v: { v: '0812' } },
        ],
      },
    ];
    typeNumbers(sheets, new Map([['Penjualan', new Set(['1_1', '1_2'])]]));
    const [b2, c2, a3] = sheets[0]!.celldata.map((d) => d.v);
    expect(b2).toEqual({ v: 100, m: '100', ct: { fa: 'General', t: 'n' } });
    expect(c2).toMatchObject({ v: 200, ct: { fa: '#,##0', t: 'n' } });
    expect(a3).toEqual({ v: '0812' });
  });
});

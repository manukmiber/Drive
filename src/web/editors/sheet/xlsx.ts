// Excel files in and out of the spreadsheet (ADR-051), through FortuneExcel (exceljs). Loaded only
// for a .xlsx, or when saving one.
import { transformExcelToFortune, transformFortuneToExcel } from '@corbe30/fortune-excel';
import ExcelJS from 'exceljs';
import type { SheetData } from './csv';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The cells each sheet keeps as numbers ("row_column", from 0), as exceljs reads them. */
export async function numberCells(bytes: ArrayBuffer): Promise<Map<string, Set<string>>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes);
  const out = new Map<string, Set<string>>();
  wb.eachSheet((ws) => {
    const cells = new Set<string>();
    ws.eachRow((row, r) =>
      row.eachCell((cell, c) => {
        const v = cell.type === ExcelJS.ValueType.Formula ? cell.result : cell.value;
        if (typeof v === 'number') cells.add(`${r - 1}_${c - 1}`);
      }),
    );
    out.set(ws.name, cells);
  });
  return out;
}

/**
 * FortuneExcel reads every value as text and types only cells with a number format, and it writes
 * untyped text back as text: a plain 100 would come back to Excel as "100". The numbers are made
 * numbers again here.
 */
export function typeNumbers(sheets: SheetData[], numbers: Map<string, Set<string>>): void {
  for (const sheet of sheets) {
    const cells = numbers.get(sheet.name);
    if (!cells) continue;
    for (const { r, c, v } of sheet.celldata) {
      if (!cells.has(`${r}_${c}`) || typeof v.v !== 'string' || !Number.isFinite(+v.v)) continue;
      v.m ??= v.v;
      v.v = +v.v;
      v.ct ??= { fa: 'General', t: 'n' };
    }
  }
}

export async function readXlsx(blob: Blob, name: string): Promise<SheetData[]> {
  let sheets: SheetData[] = [];
  // FortuneExcel hands the sheets to a React setter; the column widths are in them already.
  await transformExcelToFortune(
    new File([blob], name),
    (s: SheetData[]) => (sheets = s),
    () => {},
    { current: null },
  );
  typeNumbers(sheets, await numberCells(await blob.arrayBuffer()));
  return sheets;
}

export async function writeXlsx(workbook: { getAllSheets: () => unknown[] }): Promise<Blob> {
  // 'xlsx' is FortuneExcel's IFileType.XLSX, which it doesn't export.
  const blob = await transformFortuneToExcel({ current: workbook }, 'xlsx' as never, false);
  return new Blob([blob], { type: XLSX_MIME });
}

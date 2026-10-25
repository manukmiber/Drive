// CSV and TSV in and out of the spreadsheet (ADR-051). Quoted fields, line breaks inside quotes and
// the separator Excel in Indonesia writes (;) are read; the file is written back with the separator
// it came with. Numbers become numbers only when that cannot change them (0812… stays text).

/** A cell the way FortuneSheet keeps it (the parts used here). */
export interface SheetCell {
  v?: string | number | boolean | null;
  m?: string | number;
  f?: string;
  ct?: { fa?: string; t?: string; s?: Array<{ v?: string }> };
}

export interface SheetData {
  name: string;
  celldata: Array<{ r: number; c: number; v: SheetCell }>;
  order?: number;
  status?: number;
  luckysheet_select_save?: Array<{ row?: Array<number | null>; column?: Array<number | null> }>;
}

export type Delimiter = ',' | ';' | '\t';

/** The separator of the first line: the one it has most of, outside quotes. */
export function detectDelimiter(text: string, fallback: Delimiter = ','): Delimiter {
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch as Delimiter]++;
  }
  const best = (Object.keys(counts) as Delimiter[]).sort((a, b) => counts[b] - counts[a])[0]!;
  return counts[best] > 0 ? best : fallback;
}

export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const quote = (s: string, d: Delimiter) =>
  s.includes(d) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

export function toCsv(rows: string[][], delimiter: Delimiter): string {
  return rows.map((r) => r.map((s) => quote(s, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

// Plain decimals only: no leading zeros (phone numbers, codes), no exponents, at most 15 digits.
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

export function textCell(s: string): SheetCell {
  if (NUMBER.test(s) && s.replace(/[-.]/g, '').length <= 15)
    return { v: Number(s), m: s, ct: { fa: 'General', t: 'n' } };
  return { v: s, m: s, ct: { fa: '@', t: 's' } };
}

export function sheetFromRows(rows: string[][], name: string): SheetData {
  const celldata: SheetData['celldata'] = [];
  rows.forEach((row, r) =>
    row.forEach((s, c) => {
      if (s !== '') celldata.push({ r, c, v: textCell(s) });
    }),
  );
  return { name, celldata, order: 0, status: 1 };
}

/** What a cell shows, for a CSV: numbers as they are (not "Rp1.000"), rich text joined. */
export function cellText(cell: SheetCell | null | undefined): string {
  if (!cell) return '';
  if (cell.ct?.s) return cell.ct.s.map((p) => p.v ?? '').join('');
  if (cell.ct?.t === 'n' && typeof cell.v === 'number') return String(cell.v);
  const shown = cell.m ?? cell.v;
  return shown == null ? '' : String(shown);
}

/** A sheet's cells as rows of text, without the empty rows and columns after the last value. */
export function rowsOf(data: Array<Array<SheetCell | null>>): string[][] {
  const rows = data.map((r) => r.map(cellText));
  let last = rows.length - 1;
  while (last >= 0 && rows[last]!.every((s) => s === '')) last--;
  const kept = rows.slice(0, last + 1);
  const width = kept.reduce((w, r) => {
    let end = r.length - 1;
    while (end >= 0 && r[end] === '') end--;
    return Math.max(w, end + 1);
  }, 0);
  return kept.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
}

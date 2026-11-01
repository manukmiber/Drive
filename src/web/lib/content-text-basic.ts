// D6 (ADR-090): the parts of taking text from files that need neither the DOM nor pdf.js or mammoth
// (plain text and spreadsheets), so they can be tested on their own.
import { textKind } from '../../shared/mime';

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whitespace folded and cut to `max` characters (on a character, not in the middle of a pair). */
export function tidyText(s: string, max: number): string {
  const folded = s
    .replaceAll('\0', '')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n\s*/g, '\n')
    .trim();
  return Array.from(folded.slice(0, max * 2))
    .slice(0, max)
    .join('');
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** The words of a spreadsheet: shared strings and inline strings, in order. */
export async function xlsxText(bytes: Uint8Array, max: number): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(bytes, {
    filter: (f) =>
      f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
  });
  const parts: string[] = [];
  let size = 0;
  const take = (xml: string) => {
    for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) {
      const t = decodeXml(m[1]!);
      parts.push(t);
      size += t.length + 1;
      if (size > max) return;
    }
  };
  const shared = files['xl/sharedStrings.xml'];
  if (shared) take(strFromU8(shared));
  for (const [name, data] of Object.entries(files))
    if (name !== 'xl/sharedStrings.xml' && size <= max) take(strFromU8(data));
  return parts.join('\n');
}

/**
 * Text of a plain-text file or a spreadsheet, uncut; undefined for kinds this module does not read
 * (PDF, Word), null when there is none.
 */
export async function basicText(
  file: Blob,
  name: string,
  mime: string | null,
  max: number,
): Promise<string | null | undefined> {
  const kind = textKind(name, mime);
  if (kind === 'text') {
    let text = await file.slice(0, max * 4).text();
    if (extOf(name) === 'html' || extOf(name) === 'htm') text = text.replace(/<[^>]*>/g, ' ');
    return text;
  }
  if (kind === 'xlsx') return xlsxText(new Uint8Array(await file.arrayBuffer()), max);
  return kind ? undefined : null;
}

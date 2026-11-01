// D6 (ADR-090): the text inside a file, taken in this browser so its content never leaves it for
// anywhere but the person's own Drive. Text and code, PDFs with a text layer (pdf.js), .docx
// (mammoth) and .xlsx (shared strings and inline cells, read with fflate). Libraries load only when
// a file of that kind comes along.
import { textKind } from '../../shared/mime';
import { basicText, tidyText } from './content-text-basic';

export { textKind, tidyText };

async function pdfText(bytes: Uint8Array, max: number): Promise<string> {
  const { openPdf, pageText } = await import('../editors/pdf/pdfjs');
  const doc = await openPdf(bytes);
  try {
    let out = '';
    for (let i = 1; i <= doc.numPages && out.length < max; i++) {
      out += `${await pageText(await doc.getPage(i))}\n`;
    }
    return out;
  } finally {
    void doc.loadingTask.destroy();
  }
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const r = await mammoth.extractRawText({
    arrayBuffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  });
  return r.value;
}

/**
 * The text of a file, at most `max` characters; null when there is none to take (an image-only PDF,
 * a locked one, a broken file). Never throws.
 */
export async function extractText(
  file: Blob,
  name: string,
  mime: string | null,
  max: number,
): Promise<string | null> {
  const kind = textKind(name, mime);
  if (!kind) return null;
  try {
    let text = await basicText(file, name, mime, max);
    if (text === undefined) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      text = kind === 'pdf' ? await pdfText(bytes, max) : await docxText(bytes);
    }
    if (text === null) return null;
    const out = tidyText(text, max);
    return out.length >= 3 ? out : null;
  } catch {
    return null;
  }
}

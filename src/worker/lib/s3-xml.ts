// The little XML Zeiko S3 needs (ADR-044): responses built from plain objects, and the two request
// bodies S3 clients send (CompleteMultipartUpload, DeleteObjects) read with a tolerant extractor.
// Workers have no DOMParser, and these documents are flat.

export const S3_NS = 'http://s3.amazonaws.com/doc/2006-03-01/';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An element's content: text, nested elements (in key order), or a list = repeated element. */
export type XmlValue = string | number | boolean | null | undefined | XmlObject | XmlObject[];
export interface XmlObject {
  [tag: string]: XmlValue | string[];
}

function render(tag: string, value: XmlValue | string[]): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return (value as XmlValue[]).map((v) => render(tag, v)).join('');
  if (typeof value === 'object') {
    const inner = Object.entries(value)
      .map(([k, v]) => render(k, v))
      .join('');
    return `<${tag}>${inner}</${tag}>`;
  }
  return `<${tag}>${esc(String(value))}</${tag}>`;
}

/** `<?xml …?><Root xmlns="…">…</Root>` */
export function xmlDoc(root: string, body: XmlObject): string {
  const inner = Object.entries(body)
    .map(([k, v]) => render(k, v))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${S3_NS}">${inner}</${root}>`;
}

export function xmlResponse(
  xml: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(xml, {
    status,
    headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store', ...headers },
  });
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, t: string) => t)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e: string) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e] ?? m;
    });
}

/** Raw inner XML of every `<tag>` element (namespace prefixes ignored, no same-tag nesting). */
export function xmlElements(xml: string, tag: string): string[] {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tag}>)`,
    'g',
  );
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(m[1] ?? '');
  return out;
}

/** Decoded text of the first `<tag>` in `xml`, or null. */
export function xmlText(xml: string, tag: string): string | null {
  const el = xmlElements(xml, tag)[0];
  return el === undefined ? null : decodeXmlText(el);
}

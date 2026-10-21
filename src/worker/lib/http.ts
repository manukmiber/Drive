// HTTP helpers for file responses: Range (RFC 9110 §14) and Content-Disposition (RFC 6266/5987).

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'single'; start: number; end: number } // inclusive end
  | { kind: 'unsatisfiable' }
  | { kind: 'multi' }; // served as a full 200 (SPEC §5.3)

export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  const m = /^bytes=(.+)$/i.exec(header.trim());
  if (!m) return { kind: 'none' };
  const specs = m[1]!.split(',').map((s) => s.trim());
  if (specs.length > 1) return { kind: 'multi' };
  const spec = specs[0]!;
  const dash = spec.indexOf('-');
  if (dash === -1) return { kind: 'none' };
  const a = spec.slice(0, dash);
  const b = spec.slice(dash + 1);
  if (a === '' && b === '') return { kind: 'none' };
  if (a === '') {
    // suffix range: last N bytes
    if (!/^\d+$/.test(b)) return { kind: 'none' };
    const n = Number(b);
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'single', start: Math.max(0, size - n), end: size - 1 };
  }
  if (!/^\d+$/.test(a) || (b !== '' && !/^\d+$/.test(b))) return { kind: 'none' };
  const start = Number(a);
  let end = b === '' ? size - 1 : Number(b);
  if (b !== '' && end < start) return { kind: 'none' };
  if (start >= size) return { kind: 'unsatisfiable' };
  end = Math.min(end, size - 1);
  return { kind: 'single', start, end };
}

/** RFC 5987 percent-encoding (attr-char set). */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(
  filename: string,
  type: 'attachment' | 'inline' = 'attachment',
): string {
  const fallback =
    filename
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\%;]/g, '_')
      .trim() || 'download';
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** ETag helpers: R2 returns httpEtag already quoted. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  const strip = (s: string) => s.trim().replace(/^W\//, '');
  return ifNoneMatch.split(',').some((t) => strip(t) === strip(etag));
}

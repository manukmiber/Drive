// Streams an R2 object as a file response: HEAD, Range (206/416), ETag/If-None-Match/If-Range
// (SPEC §5.3). Blob content is immutable per blob ID, so the ETag is derived from the ID and
// conditional requests are answered without touching R2.
import { contentDisposition, etagMatches, parseRange } from './http';

export interface ServeOptions {
  key: string;
  size: number;
  etag: string;
  filename: string;
  contentType: string;
  disposition: 'attachment' | 'inline';
  /** Browser caching policy; defaults to private, no-store. */
  cacheControl?: string;
  /** Omit the `CSP: sandbox` header (only for PDFs on USERCONTENT_ORIGIN). */
  noSandbox?: boolean;
  extraHeaders?: Record<string, string>;
}

export interface ServeResult {
  response: Response;
  /** Bytes the response body will carry (for metrics). */
  bytes: number;
  /** True when the request starts at byte 0 (counts as a "download", SPEC §6.1). */
  fromStart: boolean;
}

export async function serveObject(
  bucket: R2Bucket,
  req: Request,
  o: ServeOptions,
): Promise<ServeResult> {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    ETag: o.etag,
    'Content-Type': o.contentType,
    'Content-Disposition': contentDisposition(o.filename, o.disposition),
    'Cache-Control': o.cacheControl ?? 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    ...o.extraHeaders,
  });
  if (o.noSandbox) headers.delete('Content-Security-Policy');

  if (etagMatches(req.headers.get('if-none-match'), o.etag)) {
    return { response: new Response(null, { status: 304, headers }), bytes: 0, fromStart: false };
  }

  let range = parseRange(req.headers.get('range'), o.size);
  const ifRange = req.headers.get('if-range');
  if (range.kind !== 'none' && ifRange && ifRange.trim() !== o.etag) range = { kind: 'none' };
  if (range.kind === 'multi') range = { kind: 'none' };

  if (range.kind === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${o.size}`);
    headers.delete('Content-Disposition');
    return { response: new Response(null, { status: 416, headers }), bytes: 0, fromStart: false };
  }

  const isHead = req.method === 'HEAD';
  if (range.kind === 'single') {
    const length = range.end - range.start + 1;
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${o.size}`);
    headers.set('Content-Length', String(length));
    if (isHead)
      return {
        response: new Response(null, { status: 206, headers }),
        bytes: 0,
        fromStart: range.start === 0,
      };
    const obj = await bucket.get(o.key, { range: { offset: range.start, length } });
    if (!obj || !('body' in obj)) return notFound();
    return {
      response: new Response(obj.body, { status: 206, headers }),
      bytes: length,
      fromStart: range.start === 0,
    };
  }

  headers.set('Content-Length', String(o.size));
  if (isHead)
    return { response: new Response(null, { status: 200, headers }), bytes: 0, fromStart: true };
  const obj = await bucket.get(o.key);
  if (!obj || !('body' in obj)) return notFound();
  return {
    response: new Response(obj.body, { status: 200, headers }),
    bytes: o.size,
    fromStart: true,
  };
}

function notFound(): ServeResult {
  return {
    response: new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    bytes: 0,
    fromStart: false,
  };
}

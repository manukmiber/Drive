// GET/HEAD /z/:token/:filename — streamed ZIP of the user's selection (no cookies needed).
import { Hono } from 'hono';
import { sha256Hex } from '../lib/crypto';
import { contentDisposition, parseRange } from '../lib/http';
import { planZip, withKnownLength, zipDeflateStream, zipStream } from '../lib/zip';
import { loadArchive, verifyArchiveToken } from '../services/archives';
import type { AppBindings } from '../types';

export const archiveDownload = new Hono<AppBindings>().on(
  ['GET', 'HEAD'],
  '/:token/:filename',
  async (c) => {
    const ctx = c.get('ctx');
    const id = await verifyArchiveToken(ctx, c.req.param('token'));
    if (!id) return c.text('Link unduhan sudah kedaluwarsa.', 410);
    const job = await loadArchive(ctx, id);
    if (!job || !job.content.fileCount) return c.text('Not found', 404);
    const filename = decodeURIComponent(c.req.param('filename'));
    const headers = new Headers({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (job.format === 'zip_deflate') {
      if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(zipDeflateStream(c.env.BUCKET, job.content.entries), {
        status: 200,
        headers,
      });
    }
    const plan = planZip(job.content.entries);
    const etag = `"z${(await sha256Hex(JSON.stringify(job.content.entries.map((e) => [e.path, e.key, e.size])))).slice(0, 32)}"`;
    headers.set('Accept-Ranges', 'bytes');
    headers.set('ETag', etag);
    let r = parseRange(c.req.header('range'), plan.size);
    const ifRange = c.req.header('if-range');
    if (r.kind !== 'none' && ifRange && ifRange !== etag) r = { kind: 'none' };
    if (r.kind === 'unsatisfiable') {
      headers.set('Content-Range', `bytes */${plan.size}`);
      return new Response(null, { status: 416, headers });
    }
    if (r.kind === 'single') {
      const len = r.end - r.start + 1;
      headers.set('Content-Range', `bytes ${r.start}-${r.end}/${plan.size}`);
      headers.set('Content-Length', String(len));
      if (c.req.method === 'HEAD') return new Response(null, { status: 206, headers });
      return new Response(withKnownLength(zipStream(c.env.BUCKET, plan, r.start, r.end), len), {
        status: 206,
        headers,
      });
    }
    headers.set('Content-Length', String(plan.size));
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(withKnownLength(zipStream(c.env.BUCKET, plan), plan.size), {
      status: 200,
      headers,
    });
  },
);

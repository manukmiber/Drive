// GET/HEAD /p/:token/:filename — inline previews, served ONLY on USERCONTENT_ORIGIN (SPEC §14.4).
// No cookies exist on that host; the signed path is the only credential. CORS allows APP_ORIGIN
// (pdf.js and the text viewer fetch the bytes).
import { Hono } from 'hono';
import { previewContentType, previewKind } from '../../shared/preview';
import { isAppError } from '../lib/errors';
import { serveObject } from '../lib/serve';
import { isUserContentHost } from '../middleware/base';
import { loadNode, nodeAccess, poolLocked } from '../services/access';
import { assertDownloadable, verifyDownloadToken } from '../services/download';
import type { AppBindings } from '../types';

export const preview = new Hono<AppBindings>()
  .use('*', async (c, next) => {
    if (!isUserContentHost(new URL(c.req.url), c.env)) return c.text('Not found', 404);
    await next();
    c.header('Access-Control-Allow-Origin', new URL(c.env.APP_ORIGIN).origin);
    c.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag');
    c.header('Vary', 'Origin');
  })
  .options('/:token/:filename', (c) => {
    c.header('Access-Control-Allow-Methods', 'GET, HEAD');
    c.header('Access-Control-Allow-Headers', 'Range');
    c.header('Access-Control-Max-Age', '600');
    return c.body(null, 204);
  })
  .on(['GET', 'HEAD'], '/:token/:filename', async (c) => {
    const ctx = c.get('ctx');
    const token = c.req.param('token');
    const user = await verifyDownloadToken(ctx.env.PREVIEW_SECRET, token, ctx.now(), 'p');
    const review = user
      ? null
      : await verifyDownloadToken(ctx.env.PREVIEW_SECRET, token, ctx.now(), 'a');
    const claims = user ?? review;
    if (!claims) return c.text('Link pratinjau kedaluwarsa.', 410);
    const node = await loadNode(ctx, claims.nodeId);
    if (!node || node.blob_id !== claims.blobId) return c.text('Not found', 404);
    if (review) {
      // Abuse review: the token was minted for a staff member and the view is in the audit log.
      const staff = await ctx.env.DB.prepare(`SELECT role, status FROM users WHERE id = ?1`)
        .bind(claims.userId)
        .first<{ role: string; status: string }>();
      if (
        !staff ||
        staff.status !== 'active' ||
        (staff.role !== 'admin' && staff.role !== 'moderator')
      )
        return c.text('Forbidden', 403);
    } else {
      if (!(await nodeAccess(ctx, claims.userId, node)).view) return c.text('Not found', 404);
      if (await poolLocked(ctx, node.pool_id)) return c.text('Forbidden', 403);
    }
    const blob = await ctx.env.DB.prepare(
      'SELECT r2_key, size, scan_status, sniffed_mime FROM blobs WHERE id = ?1',
    )
      .bind(claims.blobId)
      .first<{ r2_key: string; size: number; scan_status: string; sniffed_mime: string | null }>();
    if (!blob) return c.text('Not found', 404);
    try {
      if (!review || blob.scan_status === 'infected')
        assertDownloadable(node, blob.scan_status, claims.userId);
    } catch (e) {
      if (isAppError(e)) return c.text('Forbidden', 403);
      throw e;
    }
    const cfg = await ctx.config();
    const mime = blob.sniffed_mime ?? node.mime;
    const kind = previewKind(mime, node.name, blob.size, cfg.preview_text_max_bytes);
    const { response } = await serveObject(ctx.env.BUCKET, c.req.raw, {
      key: blob.r2_key,
      size: blob.size,
      etag: `"${claims.blobId}"`,
      filename: node.name,
      // Unknown types still download instead of rendering.
      contentType: kind ? previewContentType(kind, mime) : 'application/octet-stream',
      disposition: kind ? 'inline' : 'attachment',
      cacheControl: 'private, max-age=300',
      // Chrome's PDF viewer refuses sandboxed documents; this origin holds no cookies or app code.
      noSandbox: kind === 'pdf',
    });
    return response;
  });

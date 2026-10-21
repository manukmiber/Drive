// GET/HEAD /d/:token/:filename — cookie-less signed download (SPEC §5.3).
import { Hono } from 'hono';
import { track } from '../lib/analytics';
import { serveObject } from '../lib/serve';
import { clientIp, enforceRateLimit } from '../middleware/ratelimit';
import { loadNode, nodeAccess, poolLocked } from '../services/access';
import { assertDownloadable, verifyDownloadToken } from '../services/download';
import { isAppError } from '../lib/errors';
import type { AppBindings } from '../types';

function gone(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export const download = new Hono<AppBindings>().on(
  ['GET', 'HEAD'],
  '/:token/:filename',
  async (c) => {
    const ctx = c.get('ctx');
    const claims = await verifyDownloadToken(
      ctx.env.DOWNLOAD_SECRET,
      c.req.param('token'),
      ctx.now(),
    );
    if (!claims)
      return gone(
        410,
        'Link unduhan tidak valid atau sudah kedaluwarsa. Minta link baru dari Zeiko.',
      );
    await enforceRateLimit(ctx.env, 'RL_DOWNLOAD', `dl:${clientIp(c.req.raw)}:${claims.nodeId}`);

    const node = await loadNode(ctx, claims.nodeId);
    if (!node || node.blob_id !== claims.blobId) return gone(404, 'File tidak ditemukan.');
    if (await poolLocked(ctx, node.pool_id))
      return gone(403, 'Akses file dikunci sampai pembayaran paket masuk.');
    const access = await nodeAccess(ctx, claims.userId, node);
    if (!access.view) return gone(404, 'File tidak ditemukan.');
    const blob = await ctx.env.DB.prepare(
      'SELECT r2_key, size, scan_status, sniffed_mime FROM blobs WHERE id = ?1',
    )
      .bind(claims.blobId)
      .first<{ r2_key: string; size: number; scan_status: string; sniffed_mime: string | null }>();
    if (!blob) return gone(404, 'File tidak ditemukan.');
    try {
      assertDownloadable(node, blob.scan_status, claims.userId);
    } catch (e) {
      if (isAppError(e)) return gone(403, 'File ini tidak bisa diunduh.');
      throw e;
    }

    const { response, bytes } = await serveObject(ctx.env.BUCKET, c.req.raw, {
      key: blob.r2_key,
      size: blob.size,
      etag: `"${claims.blobId}"`,
      filename: node.name,
      contentType: blob.sniffed_mime ?? node.mime ?? 'application/octet-stream',
      disposition: 'attachment',
    });
    if (bytes > 0)
      track(ctx.env.ANALYTICS, 'download', { blobs: [node.pool_id], doubles: [bytes] });
    return response;
  },
);

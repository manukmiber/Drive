// Signed, cookie-less download URLs (SPEC §5.3): /d/{token}/{filename}. Download managers (IDM,
// ADM, aria2) can open many connections because no cookie is needed.
import type { Ctx } from '../context';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isUlid } from '../lib/ids';
import { requireNode } from './access';

const SIG_LEN = 32;

async function sign(
  secret: string,
  blobId: string,
  nodeId: string,
  userId: string,
  exp: number,
): Promise<string> {
  return hmacBase62(secret, `d|${blobId}|${nodeId}|${userId}|${exp}`, SIG_LEN);
}

export async function createDownloadToken(
  secret: string,
  p: { blobId: string; nodeId: string; userId: string; exp: number },
): Promise<string> {
  const exp = Math.floor(p.exp / 1000);
  return `${p.blobId}.${p.nodeId}.${p.userId}.${exp}.${await sign(secret, p.blobId, p.nodeId, p.userId, exp)}`;
}

export interface DownloadClaims {
  blobId: string;
  nodeId: string;
  userId: string;
}

/** Verifies the HMAC and expiry before any D1 query. Returns null when invalid. */
export async function verifyDownloadToken(
  secret: string,
  token: string,
  now: number,
): Promise<DownloadClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [blobId, nodeId, userId, expStr, sig] = parts as [string, string, string, string, string];
  if (!isUlid(blobId) || !isUlid(nodeId) || !isUlid(userId) || !/^\d{1,12}$/.test(expStr))
    return null;
  const exp = Number(expStr);
  if (exp * 1000 < now) return null;
  const expected = await sign(secret, blobId, nodeId, userId, exp);
  if (!timingSafeEqual(sig, expected)) return null;
  return { blobId, nodeId, userId };
}

/** Rules for who may fetch the bytes of a file node (SPEC §14.2). */
export function assertDownloadable(
  node: { kind: string; status: string; created_by: string; blob_id: string | null },
  scanStatus: string | null,
  userId: string,
): void {
  if (node.kind !== 'file' || !node.blob_id) throw new AppError('BAD_REQUEST', 'not a file');
  if (node.status === 'rejected' || scanStatus === 'infected')
    throw new AppError('FORBIDDEN', 'file was rejected');
  if (node.status === 'uploading') throw new AppError('UPLOAD_STATE', 'upload not finished');
  // While pending, only the uploader may access the file.
  if (node.status === 'scanning' && node.created_by !== userId)
    throw new AppError('FORBIDDEN', 'file is being scanned');
}

export async function downloadUrl(
  ctx: Ctx,
  userId: string,
  nodeId: string,
): Promise<{ url: string; expiresAt: number }> {
  const { node } = await requireNode(ctx, userId, nodeId, 'view');
  const blob = await ctx.env.DB.prepare('SELECT scan_status FROM blobs WHERE id = ?1')
    .bind(node.blob_id)
    .first<{ scan_status: string }>();
  assertDownloadable(node, blob?.scan_status ?? null, userId);
  const cfg = await ctx.config();
  const expiresAt = ctx.now() + cfg.download_link_ttl_seconds * 1000;
  const token = await createDownloadToken(ctx.env.DOWNLOAD_SECRET, {
    blobId: node.blob_id!,
    nodeId: node.id,
    userId,
    exp: expiresAt,
  });
  await ctx.env.DB.prepare(
    `INSERT INTO node_recent (user_id, node_id, accessed_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, node_id) DO UPDATE SET accessed_at = excluded.accessed_at`,
  )
    .bind(userId, node.id, ctx.now())
    .run();
  return { url: `/d/${token}/${encodeURIComponent(node.name)}`, expiresAt };
}

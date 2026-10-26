// Signed, cookie-less download URLs (SPEC §5.3): /d/{token}/{filename}. Download managers (IDM,
// ADM, aria2) can open many connections because no cookie is needed.
import type { Ctx } from '../context';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isUlid } from '../lib/ids';
import { previewKind, type PreviewKind } from '../../shared/preview';
import { requireNode } from './access';
import { collectFiles } from './archive';

const SIG_LEN = 32;

/** `d` = download (/d/…), `p` = inline preview on USERCONTENT_ORIGIN (/p/…). */
// `a` = abuse review by staff (audited, 5 min; may show quarantined files).
export type TokenPurpose = 'd' | 'p' | 'a';

async function sign(
  secret: string,
  blobId: string,
  nodeId: string,
  userId: string,
  exp: number,
  purpose: TokenPurpose,
): Promise<string> {
  return hmacBase62(secret, `${purpose}|${blobId}|${nodeId}|${userId}|${exp}`, SIG_LEN);
}

export async function createDownloadToken(
  secret: string,
  p: { blobId: string; nodeId: string; userId: string; exp: number },
  purpose: TokenPurpose = 'd',
): Promise<string> {
  const exp = Math.floor(p.exp / 1000);
  const sig = await sign(secret, p.blobId, p.nodeId, p.userId, exp, purpose);
  return `${p.blobId}.${p.nodeId}.${p.userId}.${exp}.${sig}`;
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
  purpose: TokenPurpose = 'd',
): Promise<DownloadClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [blobId, nodeId, userId, expStr, sig] = parts as [string, string, string, string, string];
  if (!isUlid(blobId) || !isUlid(nodeId) || !isUlid(userId) || !/^\d{1,12}$/.test(expStr))
    return null;
  const exp = Number(expStr);
  if (exp * 1000 < now) return null;
  const expected = await sign(secret, blobId, nodeId, userId, exp, purpose);
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
  if (scanStatus === 'quarantined')
    throw new AppError('FORBIDDEN', 'file is under review', { reason: 'QUARANTINED' });
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
  await touchRecent(ctx, userId, node.id);
  return { url: `/d/${token}/${encodeURIComponent(node.name)}`, expiresAt };
}

export interface PlannedDownload {
  nodeId: string;
  name: string;
  /** Path from the chosen item ("Foto/2024/a.jpg"; just the name for a chosen file). */
  path: string;
  size: number;
  mime: string | null;
  url: string;
}

/**
 * "Download separately" (ADR-053): every ready file under the chosen items, each with its own
 * signed /d/ link, so the app's download queue can fetch a few at a time and resume with Range.
 * Folders are expanded like an archive; files still scanning or rejected are counted as skipped.
 */
export async function downloadPlan(
  ctx: Ctx,
  userId: string,
  nodeIds: string[],
): Promise<{
  items: PlannedDownload[];
  folders: string[];
  skipped: number;
  totalBytes: number;
  expiresAt: number;
}> {
  const ids = [...new Set(nodeIds)];
  for (const id of ids) await requireNode(ctx, userId, id, 'view');
  const cfg = await ctx.config();
  const tree = await collectFiles(ctx, ids, cfg.download_plan_max_items);
  const expiresAt = ctx.now() + cfg.download_link_ttl_seconds * 1000;
  const seen = new Set<string>();
  const items: PlannedDownload[] = [];
  let totalBytes = 0;
  for (const f of tree.files) {
    // A file chosen next to its own folder comes once.
    if (seen.has(f.nodeId)) continue;
    seen.add(f.nodeId);
    const token = await createDownloadToken(ctx.env.DOWNLOAD_SECRET, {
      blobId: f.blobId,
      nodeId: f.nodeId,
      userId,
      exp: expiresAt,
    });
    items.push({
      nodeId: f.nodeId,
      name: f.name,
      path: f.path,
      size: f.size,
      mime: f.mime,
      url: `/d/${token}/${encodeURIComponent(f.name)}`,
    });
    totalBytes += f.size;
  }
  return {
    items,
    folders: [...new Set(tree.folders)],
    skipped: tree.skipped,
    totalBytes,
    expiresAt,
  };
}

/** "Terbaru": remember opened files, keeping at most 200 rows per user (SPEC §4). */
export async function touchRecent(ctx: Ctx, userId: string, nodeId: string): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO node_recent (user_id, node_id, accessed_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id, node_id) DO UPDATE SET accessed_at = excluded.accessed_at`,
    ).bind(userId, nodeId, ctx.now()),
    ctx.env.DB.prepare(
      `DELETE FROM node_recent WHERE user_id = ?1 AND node_id NOT IN
         (SELECT node_id FROM node_recent WHERE user_id = ?1 ORDER BY accessed_at DESC LIMIT 200)`,
    ).bind(userId),
  ]);
}

/** Short-lived inline preview URL on USERCONTENT_ORIGIN (SPEC §14.4). */
export async function previewUrl(
  ctx: Ctx,
  userId: string,
  nodeId: string,
): Promise<{ url: string; kind: PreviewKind | null; expiresAt: number }> {
  const { node } = await requireNode(ctx, userId, nodeId, 'view');
  const blob = await ctx.env.DB.prepare('SELECT scan_status, sniffed_mime FROM blobs WHERE id = ?1')
    .bind(node.blob_id)
    .first<{ scan_status: string; sniffed_mime: string | null }>();
  assertDownloadable(node, blob?.scan_status ?? null, userId);
  const cfg = await ctx.config();
  const kind = previewKind(
    blob?.sniffed_mime ?? node.mime,
    node.name,
    node.size,
    cfg.preview_text_max_bytes,
  );
  const expiresAt = ctx.now() + cfg.preview_link_ttl_seconds * 1000;
  const token = await createDownloadToken(
    ctx.env.PREVIEW_SECRET,
    { blobId: node.blob_id!, nodeId: node.id, userId, exp: expiresAt },
    'p',
  );
  await touchRecent(ctx, userId, node.id);
  const origin = new URL(ctx.env.USERCONTENT_ORIGIN).origin;
  return { url: `${origin}/p/${token}/${encodeURIComponent(node.name)}`, kind, expiresAt };
}

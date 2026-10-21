// "Unduh sebagai ZIP" for several files/folders (SPEC §7.2). ZIP store and ZIP deflate are streamed
// on the fly from R2 behind a signed, cookie-less /z/ URL; nothing is written back to R2.
import type { Ctx } from '../context';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isUlid, ulid } from '../lib/ids';
import { collectEntries, type ArchiveContent } from './archive';
import { requireNode } from './access';

export type StreamFormat = 'zip_store' | 'zip_deflate';

const sign = (secret: string, id: string, exp: number) => hmacBase62(secret, `z|${id}|${exp}`, 32);

export async function createArchive(
  ctx: Ctx,
  userId: string,
  input: { nodeIds: string[]; format: StreamFormat },
): Promise<{ id: string; url: string; totalBytes: number; fileCount: number; expiresAt: number }> {
  const ids = [...new Set(input.nodeIds)];
  if (!ids.length || ids.length > 1000)
    throw new AppError('VALIDATION', 'between 1 and 1000 items');
  for (const id of ids) await requireNode(ctx, userId, id, 'view');
  const cfg = await ctx.config();
  const content = await collectEntries(ctx, ids);
  if (!content.fileCount) throw new AppError('CONFLICT', 'nothing downloadable in the selection');
  if (input.format === 'zip_deflate' && content.totalBytes > cfg.zip_deflate_stream_max_bytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'too large for a compressed ZIP', {
      max: cfg.zip_deflate_stream_max_bytes,
    });
  }
  const now = ctx.now();
  const id = ulid(now);
  const expiresAt = now + cfg.archive_link_ttl_hours * 3600_000;
  await ctx.env.DB.prepare(
    `INSERT INTO archive_jobs (id, user_id, node_ids_json, format, status, progress, total_bytes, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'done', 100, ?5, ?6, ?7, ?7)`,
  )
    .bind(id, userId, JSON.stringify(ids), input.format, content.totalBytes, expiresAt, now)
    .run();
  const exp = Math.floor(expiresAt / 1000);
  const token = `${id}.${exp}.${await sign(ctx.env.DOWNLOAD_SECRET, id, exp)}`;
  return {
    id,
    url: `/z/${token}/${encodeURIComponent(archiveName(ctx, content))}`,
    totalBytes: content.totalBytes,
    fileCount: content.fileCount,
    expiresAt,
  };
}

function archiveName(ctx: Ctx, content: ArchiveContent): string {
  const roots = new Set(content.entries.map((e) => e.path.split('/')[0]));
  const d = new Date(ctx.now() + 7 * 3600_000).toISOString().slice(0, 10);
  return roots.size === 1 ? `${[...roots][0]}.zip` : `Zeiko-${d}.zip`;
}

export async function verifyArchiveToken(ctx: Ctx, token: string): Promise<string | null> {
  const [id, expStr, sig] = token.split('.');
  if (!id || !expStr || !sig || !isUlid(id) || !/^\d{1,12}$/.test(expStr)) return null;
  const exp = Number(expStr);
  if (exp * 1000 < ctx.now()) return null;
  return timingSafeEqual(sig, await sign(ctx.env.DOWNLOAD_SECRET, id, exp)) ? id : null;
}

/** Re-checks access at download time: removed members or trashed items drop out. */
export async function loadArchive(
  ctx: Ctx,
  id: string,
): Promise<{ format: StreamFormat; content: ArchiveContent } | null> {
  const job = await ctx.env.DB.prepare(
    'SELECT user_id, node_ids_json, format, expires_at FROM archive_jobs WHERE id = ?1',
  )
    .bind(id)
    .first<{ user_id: string; node_ids_json: string; format: string; expires_at: number | null }>();
  if (!job || (job.expires_at !== null && job.expires_at < ctx.now())) return null;
  if (job.format !== 'zip_store' && job.format !== 'zip_deflate') return null;
  const ids: string[] = [];
  for (const nodeId of JSON.parse(job.node_ids_json) as string[]) {
    try {
      await requireNode(ctx, job.user_id, nodeId, 'view');
      ids.push(nodeId);
    } catch {
      // gone or no longer accessible — skip
    }
  }
  return { format: job.format, content: await collectEntries(ctx, ids) };
}

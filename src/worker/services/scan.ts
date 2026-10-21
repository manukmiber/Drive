// Security scan pipeline (SPEC §3 "Jalankan pengecekan keamanan", §14.2). Runs from Queue `scan`.
// clean/skipped → reservation becomes usage, nodes `ready`; infected → object deleted, reservation
// released, nodes `rejected`, hash blocklisted, uploader notified.
import type { Ctx } from '../context';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import { track } from '../lib/analytics';

interface BlobRow {
  id: string;
  pool_id: string;
  r2_key: string;
  size: number;
  uploader_id: string;
  refcount: number;
  scan_status: string;
  scan_attempts: number;
}

export class RetryableScanError extends Error {}

export async function processScan(
  ctx: Ctx,
  blobId: string,
): Promise<'clean' | 'skipped' | 'infected' | 'error' | 'noop'> {
  const DB = ctx.env.DB;
  const blob = await DB.prepare('SELECT * FROM blobs WHERE id = ?1').bind(blobId).first<BlobRow>();
  if (!blob || (blob.scan_status !== 'pending' && blob.scan_status !== 'error')) return 'noop';
  if (blob.refcount === 0) return 'noop'; // deleted while queued; cleanup handles the object
  const cfg = await ctx.config();
  const result = await ctx.adapters.scanner.scan({
    key: blob.r2_key,
    size: blob.size,
    maxScanBytes: cfg.scan_max_bytes,
  });
  const now = ctx.now();

  if (result.status === 'error') {
    const attempts = blob.scan_attempts + 1;
    await DB.prepare(
      `UPDATE blobs SET scan_attempts = ?2, scan_detail = ?3, scan_status = ?4 WHERE id = ?1`,
    )
      .bind(
        blobId,
        attempts,
        result.detail,
        attempts >= cfg.scan_max_attempts ? 'error' : 'pending',
      )
      .run();
    if (attempts >= cfg.scan_max_attempts) {
      await ctx.env.NOTIFY_QUEUE.send({
        type: 'admin_alert',
        text: `Scan gagal ${attempts}× untuk blob ${blobId}: ${result.detail}`,
      });
      return 'error';
    }
    throw new RetryableScanError(result.detail ?? 'scan error');
  }

  let status = result.status;
  let detail = result.detail;
  if (result.sha256) {
    const blocked = await DB.prepare('SELECT reason FROM blocked_hashes WHERE sha256 = ?1')
      .bind(result.sha256)
      .first<{ reason: string }>();
    if (blocked) {
      status = 'infected';
      detail = `blocked hash: ${blocked.reason}`;
    }
  }

  const scanningSum = `(SELECT COALESCE(SUM(size), 0) FROM nodes WHERE blob_id = ?1 AND status = 'scanning')`;
  if (status === 'clean' || status === 'skipped') {
    await DB.batch([
      DB.prepare(
        `UPDATE storage_pools SET reserved_bytes = MAX(0, reserved_bytes - ${scanningSum}),
           used_bytes = used_bytes + ${scanningSum}, updated_at = ?3 WHERE id = ?2`,
      ).bind(blobId, blob.pool_id, now),
      DB.prepare(
        `UPDATE nodes SET status = 'ready', updated_at = ?2 WHERE blob_id = ?1 AND status = 'scanning'`,
      ).bind(blobId, now),
      DB.prepare(
        `UPDATE blobs SET scan_status = ?2, sha256 = ?3, crc32 = ?4, sniffed_mime = ?5, scan_detail = ?6,
           scanned_at = ?7, scan_attempts = scan_attempts + 1 WHERE id = ?1`,
      ).bind(blobId, status, result.sha256, result.crc32, result.sniffedMime, detail, now),
    ]);
  } else {
    const { results: affected } = await DB.prepare(
      `SELECT id, name, created_by FROM nodes WHERE blob_id = ?1 AND status IN ('scanning', 'ready')`,
    )
      .bind(blobId)
      .all<{ id: string; name: string; created_by: string }>();
    const stmts: D1PreparedStatement[] = [
      DB.prepare(
        `UPDATE storage_pools SET reserved_bytes = MAX(0, reserved_bytes - ${scanningSum}), updated_at = ?3 WHERE id = ?2`,
      ).bind(blobId, blob.pool_id, now),
      DB.prepare(
        `UPDATE nodes SET status = 'rejected', updated_at = ?2 WHERE blob_id = ?1 AND status = 'scanning'`,
      ).bind(blobId, now),
      DB.prepare(
        `UPDATE blobs SET scan_status = 'infected', sha256 = ?2, crc32 = ?3, sniffed_mime = ?4, scan_detail = ?5,
           scanned_at = ?6, scan_attempts = scan_attempts + 1 WHERE id = ?1`,
      ).bind(blobId, result.sha256, result.crc32, result.sniffedMime, detail, now),
    ];
    if (result.sha256) {
      stmts.push(
        DB.prepare(
          `INSERT INTO blocked_hashes (sha256, reason, created_by, created_at) VALUES (?1, ?2, 'scanner', ?3)
           ON CONFLICT (sha256) DO NOTHING`,
        ).bind(result.sha256, detail ?? 'malware', now),
      );
    }
    for (const n of affected) {
      stmts.push(
        DB.prepare(
          `INSERT INTO notifications (id, user_id, type, payload_json, created_at) VALUES (?1, ?2, 'file_rejected', ?3, ?4)`,
        ).bind(
          ulid(now),
          n.created_by,
          JSON.stringify({ nodeId: n.id, name: n.name, reason: detail }),
          now,
        ),
      );
    }
    await DB.batch(stmts);
    const held = await DB.prepare('SELECT 1 AS h FROM legal_holds WHERE blob_id = ?1')
      .bind(blobId)
      .first<{ h: number }>();
    if (!held) await ctx.env.BUCKET.delete(blob.r2_key);
    log.warn('scan_infected', { blobId, detail });
  }
  track(ctx.env.ANALYTICS, 'scan_result', { blobs: [status], doubles: [blob.size] });
  return status;
}

/** Cleanup queue: delete an R2 object once no node references its blob (SPEC §4). */
export async function deleteOrphanBlob(ctx: Ctx, blobId: string): Promise<boolean> {
  const DB = ctx.env.DB;
  const blob = await DB.prepare(
    `SELECT b.r2_key, b.thumb_key FROM blobs b WHERE b.id = ?1 AND b.refcount = 0
       AND NOT EXISTS (SELECT 1 FROM nodes WHERE blob_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM legal_holds WHERE blob_id = b.id)`,
  )
    .bind(blobId)
    .first<{ r2_key: string; thumb_key: string | null }>();
  if (!blob) return false;
  await ctx.env.BUCKET.delete(blob.thumb_key ? [blob.r2_key, blob.thumb_key] : [blob.r2_key]);
  await DB.prepare('DELETE FROM blobs WHERE id = ?1 AND refcount = 0').bind(blobId).run();
  return true;
}

// Security scan pipeline (SPEC §3 "Jalankan pengecekan keamanan", §14.2). Runs from Queue `scan`.
// Our scanner, then the hash blocklist, then VirusTotal for risky types (ADR-046), which may send
// the scan again later (`vt` carries what was found). clean/skipped → reservation becomes usage,
// nodes `ready`; infected → object deleted, reservation released, nodes `rejected`, hash
// blocklisted, uploader notified.
import type { ScanResult } from '../adapters/scanner';
import { markBlobOwnersDirty } from './drive-index-sync';
import type { Ctx } from '../context';
import { log } from '../lib/log';
import type { ScanCarry } from '../queues/messages';
import { checkQuotaThresholds, notify } from './notify';
import { track } from '../lib/analytics';
import { virusTotalStep, type VtInput } from './virustotal';

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

/**
 * VirusTotal's say on a file our scanner passed. `wait`: the scan was sent again for later and
 * nothing is decided yet.
 */
export async function afterVirusTotal(
  ctx: Ctx,
  input: VtInput,
  result: ScanResult & { status: 'clean' | 'skipped'; sha256: string },
  carry: ScanCarry | undefined,
  again: (vt: ScanCarry, delaySeconds: number) => Promise<unknown>,
): Promise<{ status: 'clean' | 'skipped' | 'infected'; detail: string | null } | 'wait'> {
  const step = await virusTotalStep(ctx, input, carry ?? null);
  if (step.kind === 'wait') {
    const { status, sha256, crc32, sniffedMime, detail } = result;
    await again(
      { ...step.resume, base: { status, sha256, crc32, sniffedMime, detail } },
      step.delaySeconds,
    );
    return 'wait';
  }
  if (step.malicious) return { status: 'infected', detail: step.detail };
  return { status: result.status, detail: result.detail ?? step.detail };
}

export async function processScan(
  ctx: Ctx,
  blobId: string,
  carry?: ScanCarry,
): Promise<'clean' | 'skipped' | 'infected' | 'error' | 'noop' | 'pending'> {
  const DB = ctx.env.DB;
  const blob = await DB.prepare('SELECT * FROM blobs WHERE id = ?1').bind(blobId).first<BlobRow>();
  if (!blob || (blob.scan_status !== 'pending' && blob.scan_status !== 'error')) return 'noop';
  if (blob.refcount === 0) return 'noop'; // deleted while queued; cleanup handles the object
  const cfg = await ctx.config();
  const result: ScanResult = carry
    ? carry.base
    : await ctx.adapters.scanner.scan({
        key: blob.r2_key,
        size: blob.size,
        maxScanBytes: cfg.scan_max_bytes,
      });

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
  if ((status === 'clean' || status === 'skipped') && result.sha256) {
    const named = await DB.prepare(
      `SELECT name FROM nodes WHERE blob_id = ?1 ORDER BY created_at LIMIT 1`,
    )
      .bind(blobId)
      .first<{ name: string }>();
    const vt = await afterVirusTotal(
      ctx,
      {
        userId: blob.uploader_id,
        sha256: result.sha256,
        size: blob.size,
        name: named?.name ?? '',
        sniffedMime: result.sniffedMime,
        r2Key: blob.r2_key,
      },
      { ...result, status, sha256: result.sha256 },
      carry,
      (vt, delaySeconds) => ctx.env.SCAN_QUEUE.send({ type: 'scan', blobId, vt }, { delaySeconds }),
    );
    if (vt === 'wait') return 'pending';
    ({ status, detail } = vt);
  }

  const now = ctx.now();
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
    await markBlobOwnersDirty(ctx, [blobId]);
    await checkQuotaThresholds(ctx, blob.pool_id);
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
    await DB.batch(stmts);
    await markBlobOwnersDirty(ctx, [blobId]);
    for (const n of affected)
      await notify(ctx, n.created_by, 'file_rejected', {
        nodeId: n.id,
        name: n.name,
        reason: detail,
      });
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

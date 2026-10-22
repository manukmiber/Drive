// Media compression (SPEC §11, ADR-031). Jobs run on Queue `compress`. Credits are taken when a job
// is created and given back when it fails or the result is not smaller than the original.
// Engines: Images binding (images ≤ images_binding_max_input_bytes), Media Transformations (videos
// ≤ media_binding_max_seconds and ≤ media_binding_max_input_bytes) and Container `media` (rest).
import type { Ctx } from '../context';
import type { ImageFormat, MediaOutput, Quality, VideoPreset } from '../adapters/media';
import { DAY_MS } from '../../shared/constants';
import { AppError } from '../lib/errors';
import { Crc32 } from '../lib/crc32';
import { ulid } from '../lib/ids';
import { mp4Duration } from '../lib/mp4';
import { log } from '../lib/log';
import { nameKey, sanitizeName, splitExt } from '../lib/names';
import { Sha256 } from '../lib/sha256';
import { withKnownLength } from '../lib/zip';
import { requireNode, type NodeRecord } from './access';
import { consumeCredits, creditBalance, refundCredits } from './credits';
import { markManifestDirty, requireWritableFolder, uniqueName } from './nodes';
import { notificationStmt } from './notify';
import { addUsedIfFits } from './quota';

export interface CompressOptions {
  image: { format: ImageFormat; quality: Quality; maxWidth?: number | undefined };
  video: { preset: VideoPreset; quality: Quality };
  save: 'copy' | 'replace';
}

type Kind = 'image' | 'video';
type Engine = 'images' | 'media' | 'ffmpeg';

interface JobRow {
  id: string;
  user_id: string;
  batch_id: string | null;
  source_node_id: string | null;
  source_key: string | null;
  kind: Kind;
  engine: Engine;
  options_json: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  out_node_id: string | null;
  out_key: string | null;
  credits_used: number;
  saved_bytes: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface StoredOptions extends CompressOptions {
  name: string;
  size: number;
  /** Standalone: R2 multipart upload id while the source is being uploaded. */
  uploadId?: string;
  parts?: number;
}

const EXT: Record<ImageFormat, string> = { avif: '.avif', webp: '.webp', jpeg: '.jpg' };
const STALE_RUNNING_MS = 15 * 60_000;

export function kindOf(mime: string | null, name: string): Kind | null {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/') && !m.includes('svg') && !m.includes('gif')) return 'image';
  if (m.startsWith('video/')) return 'video';
  const ext = splitExt(name).ext.toLowerCase();
  if (
    ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.bmp', '.tif', '.tiff'].includes(
      ext,
    )
  )
    return 'image';
  if (['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.3gp'].includes(ext)) return 'video';
  return null;
}

function isMp4Family(mime: string | null, name: string): boolean {
  const ext = splitExt(name).ext.toLowerCase();
  return (
    /^video\/(mp4|quicktime|x-m4v)$/.test(mime ?? '') || ['.mp4', '.mov', '.m4v'].includes(ext)
  );
}

/** Engine and credit cost for one source (SPEC §11, §16 #4). */
async function plan(
  ctx: Ctx,
  kind: Kind,
  src: { key: string; size: number; mime: string | null; name: string },
): Promise<{ engine: Engine; credits: number }> {
  const cfg = await ctx.config();
  if (kind === 'image') {
    return {
      engine: src.size <= cfg.images_binding_max_input_bytes ? 'images' : 'ffmpeg',
      credits: 1,
    };
  }
  const seconds = isMp4Family(src.mime, src.name)
    ? await mp4Duration(ctx.env.BUCKET, src.key, src.size)
    : null;
  const short = seconds !== null && seconds <= cfg.media_binding_max_seconds;
  const credits =
    seconds === null || short ? 1 : Math.ceil(seconds / 60) * cfg.long_video_credits_per_minute;
  return {
    engine: short && src.size <= cfg.media_binding_max_input_bytes ? 'media' : 'ffmpeg',
    credits,
  };
}

function outName(source: string, kind: Kind, o: CompressOptions, copy: boolean): string {
  const { base } = splitExt(source);
  const ext = kind === 'image' ? EXT[o.image.format] : '.mp4';
  return sanitizeName(`${base}${copy ? ' (kompres)' : ''}${ext}`);
}

// ───────────────────────────── create ─────────────────────────────

export interface BatchResult {
  batchId: string;
  queued: number;
  failed: Array<{ nodeId: string; reason: string }>;
}

export async function createCompressBatch(
  ctx: Ctx,
  userId: string,
  nodeIds: string[],
  o: CompressOptions,
): Promise<BatchResult> {
  const batchId = ulid(ctx.now());
  const failed: BatchResult['failed'] = [];
  let queued = 0;
  for (const nodeId of [...new Set(nodeIds)]) {
    const reason = await createNodeJob(ctx, userId, nodeId, batchId, o).catch((e: unknown) =>
      e instanceof AppError ? e.code : 'ERROR',
    );
    if (reason === null) queued++;
    else failed.push({ nodeId, reason });
  }
  if (!queued && failed.length) {
    const first = failed[0]!.reason;
    if (failed.every((f) => f.reason === first))
      throw new AppError(first === 'NO_CREDITS' ? 'NO_CREDITS' : 'BAD_REQUEST', first);
  }
  return { batchId, queued, failed };
}

/** Returns null when queued, or a reason code. */
async function createNodeJob(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  batchId: string,
  o: CompressOptions,
): Promise<string | null> {
  const { node, access } = await requireNode(ctx, userId, nodeId, 'view');
  if (node.kind !== 'file') return 'NOT_MEDIA';
  const kind = kindOf(node.mime, node.name);
  if (!kind) return 'NOT_MEDIA';
  if (node.status !== 'ready' || !node.blob_id) return 'NOT_READY';
  if (o.save === 'replace' && !access.edit) return 'FORBIDDEN';
  if (o.save === 'copy') await requireWritableFolder(ctx, userId, node.parent_id!);
  const blob = await ctx.env.DB.prepare('SELECT r2_key, scan_status FROM blobs WHERE id = ?1')
    .bind(node.blob_id)
    .first<{ r2_key: string; scan_status: string }>();
  if (!blob || !['clean', 'skipped'].includes(blob.scan_status)) return 'NOT_READY';
  const p = await plan(ctx, kind, {
    key: blob.r2_key,
    size: node.size,
    mime: node.mime,
    name: node.name,
  });
  if (p.engine === 'ffmpeg' && !ctx.adapters.media.hasContainer) return 'TOO_LARGE';
  const jobId = ulid(ctx.now());
  if (!(await consumeCredits(ctx, userId, p.credits, jobId))) return 'NO_CREDITS';
  await insertJob(ctx, {
    id: jobId,
    userId,
    batchId,
    sourceNodeId: node.id,
    sourceKey: null,
    kind,
    engine: p.engine,
    options: { ...o, name: node.name, size: node.size },
    credits: p.credits,
  });
  await ctx.env.COMPRESS_QUEUE.send({ type: 'compress', jobId });
  return null;
}

async function insertJob(
  ctx: Ctx,
  j: {
    id: string;
    userId: string;
    batchId: string | null;
    sourceNodeId: string | null;
    sourceKey: string | null;
    kind: Kind;
    engine: Engine;
    options: StoredOptions;
    credits: number;
    status?: JobRow['status'];
  },
): Promise<void> {
  const now = ctx.now();
  await ctx.env.DB.prepare(
    `INSERT INTO compress_jobs (id, user_id, batch_id, source_node_id, source_key, kind, engine, options_json, status,
       credits_used, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
  )
    .bind(
      j.id,
      j.userId,
      j.batchId,
      j.sourceNodeId,
      j.sourceKey,
      j.kind,
      j.engine,
      JSON.stringify(j.options),
      j.status ?? 'queued',
      j.credits,
      now,
    )
    .run();
}

// ───────────────────────────── standalone (tmp/compress) ─────────────────────────────

export const STANDALONE_PART_BYTES = 50 * 1024 * 1024;

/** "Kompres tanpa simpan": upload to tmp/compress/{userId}/, download the result, gone after 24 h. */
export async function startStandalone(
  ctx: Ctx,
  userId: string,
  p: { name: string; size: number; mime: string | null; options: Omit<CompressOptions, 'save'> },
): Promise<{ jobId: string; partSize: number; parts: number }> {
  const cfg = await ctx.config();
  if (p.size <= 0) throw new AppError('VALIDATION', 'empty file');
  if (p.size > cfg.standalone_compress_max_bytes)
    throw new AppError('FILE_TOO_LARGE', 'standalone limit', {
      max: cfg.standalone_compress_max_bytes,
    });
  const name = sanitizeName(p.name);
  const kind = kindOf(p.mime, name);
  if (!kind) throw new AppError('BAD_REQUEST', 'NOT_MEDIA');
  const jobId = ulid(ctx.now());
  const key = `tmp/compress/${userId}/${jobId}-in`;
  const mpu = await ctx.env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: p.mime ?? 'application/octet-stream' },
  });
  const parts = Math.max(1, Math.ceil(p.size / STANDALONE_PART_BYTES));
  await insertJob(ctx, {
    id: jobId,
    userId,
    batchId: null,
    sourceNodeId: null,
    sourceKey: key,
    kind,
    engine: 'images', // decided after the upload, once the duration can be read
    options: { ...p.options, save: 'copy', name, size: p.size, uploadId: mpu.uploadId, parts },
    credits: 0,
    status: 'running', // "uploading"; not picked up by the queue until completed
  });
  return { jobId, partSize: STANDALONE_PART_BYTES, parts };
}

async function requireJob(ctx: Ctx, userId: string, jobId: string): Promise<JobRow> {
  const job = await ctx.env.DB.prepare('SELECT * FROM compress_jobs WHERE id = ?1 AND user_id = ?2')
    .bind(jobId, userId)
    .first<JobRow>();
  if (!job) throw new AppError('NOT_FOUND', 'job not found');
  return job;
}

function opts(job: JobRow): StoredOptions {
  return JSON.parse(job.options_json) as StoredOptions;
}

export async function uploadStandalonePart(
  ctx: Ctx,
  userId: string,
  jobId: string,
  partNumber: number,
  contentLength: number | null,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ partNumber: number; etag: string }> {
  const job = await requireJob(ctx, userId, jobId);
  const o = opts(job);
  if (!o.uploadId || !job.source_key)
    throw new AppError('UPLOAD_STATE', 'upload already completed');
  const parts = o.parts ?? 1;
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > parts)
    throw new AppError('VALIDATION', 'invalid part number');
  const expected =
    partNumber < parts ? STANDALONE_PART_BYTES : o.size - STANDALONE_PART_BYTES * (parts - 1);
  if (contentLength !== expected || !body)
    throw new AppError('VALIDATION', 'part has the wrong size', { expected, got: contentLength });
  const part = await ctx.env.BUCKET.resumeMultipartUpload(job.source_key, o.uploadId).uploadPart(
    partNumber,
    body,
  );
  return { partNumber, etag: part.etag };
}

export async function completeStandalone(
  ctx: Ctx,
  userId: string,
  jobId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<JobDto> {
  const job = await requireJob(ctx, userId, jobId);
  const o = opts(job);
  if (!o.uploadId || !job.source_key)
    throw new AppError('UPLOAD_STATE', 'upload already completed');
  await ctx.env.BUCKET.resumeMultipartUpload(job.source_key, o.uploadId).complete(
    parts.sort((a, b) => a.partNumber - b.partNumber),
  );
  const head = await ctx.env.BUCKET.head(job.source_key);
  if (!head || head.size !== o.size) {
    await ctx.env.BUCKET.delete(job.source_key);
    throw new AppError('VALIDATION', 'uploaded size mismatch');
  }
  const p = await plan(ctx, job.kind, {
    key: job.source_key,
    size: o.size,
    mime: head.httpMetadata?.contentType ?? null,
    name: o.name,
  });
  const clean: StoredOptions = {
    image: o.image,
    video: o.video,
    save: 'copy',
    name: o.name,
    size: o.size,
  };
  const fail = async (error: string) => {
    await ctx.env.BUCKET.delete(job.source_key!);
    await ctx.env.DB.prepare(
      `UPDATE compress_jobs SET status = 'failed', error = ?2, source_key = NULL, options_json = ?3, updated_at = ?4 WHERE id = ?1`,
    )
      .bind(jobId, error, JSON.stringify(clean), ctx.now())
      .run();
  };
  if (p.engine === 'ffmpeg' && !ctx.adapters.media.hasContainer) {
    await fail('TOO_LARGE');
    throw new AppError('BAD_REQUEST', 'TOO_LARGE');
  }
  if (!(await consumeCredits(ctx, userId, p.credits, jobId))) {
    await fail('NO_CREDITS');
    throw new AppError('NO_CREDITS', 'not enough compress credits');
  }
  await ctx.env.DB.prepare(
    `UPDATE compress_jobs SET status = 'queued', engine = ?2, credits_used = ?3, options_json = ?4, updated_at = ?5 WHERE id = ?1`,
  )
    .bind(jobId, p.engine, p.credits, JSON.stringify(clean), ctx.now())
    .run();
  await ctx.env.COMPRESS_QUEUE.send({ type: 'compress', jobId });
  return toDto({
    ...job,
    status: 'queued',
    engine: p.engine,
    credits_used: p.credits,
    options_json: JSON.stringify(clean),
  });
}

export async function standaloneResult(ctx: Ctx, userId: string, jobId: string): Promise<Response> {
  const job = await requireJob(ctx, userId, jobId);
  if (job.status !== 'done' || !job.out_key || job.source_node_id)
    throw new AppError('NOT_FOUND', 'no result');
  const obj = await ctx.env.BUCKET.get(job.out_key);
  if (!obj) throw new AppError('GONE', 'result expired');
  const o = opts(job);
  const name = outName(o.name, job.kind, o, true);
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(obj.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// ───────────────────────────── process (queue) ─────────────────────────────

async function finish(
  ctx: Ctx,
  job: JobRow,
  status: 'done' | 'failed' | 'skipped',
  fields: { error?: string; outNodeId?: string; outKey?: string; savedBytes?: number } = {},
): Promise<void> {
  if (status !== 'done') await refundCredits(ctx, job.user_id, job.id);
  await ctx.env.DB.prepare(
    `UPDATE compress_jobs SET status = ?2, error = ?3, out_node_id = ?4, out_key = ?5, saved_bytes = ?6, updated_at = ?7 WHERE id = ?1`,
  )
    .bind(
      job.id,
      status,
      fields.error ?? null,
      fields.outNodeId ?? null,
      fields.outKey ?? null,
      fields.savedBytes ?? null,
      ctx.now(),
    )
    .run();
  await maybeNotifyBatch(ctx, job);
}

/** One notification per batch (or per standalone job) once nothing is left queued/running. */
async function maybeNotifyBatch(ctx: Ctx, job: JobRow): Promise<void> {
  const DB = ctx.env.DB;
  const scope = job.batch_id ? 'batch_id = ?1' : 'id = ?1';
  const s = await DB.prepare(
    `SELECT SUM(status IN ('queued', 'running')) AS pending, SUM(status = 'done') AS done, SUM(status = 'skipped') AS skipped,
       SUM(status = 'failed') AS failed, COALESCE(SUM(saved_bytes), 0) AS saved
     FROM compress_jobs WHERE ${scope}`,
  )
    .bind(job.batch_id ?? job.id)
    .first<{ pending: number; done: number; skipped: number; failed: number; saved: number }>();
  if (!s || s.pending > 0) return;
  // KV guard: two consumers finishing the last two jobs at once must not notify twice.
  const marker = `cn:${job.batch_id ?? job.id}`;
  if (await ctx.env.CONFIG_KV.get(marker)) return;
  await ctx.env.CONFIG_KV.put(marker, '1', { expirationTtl: 7 * 86_400 });
  const n = notificationStmt(ctx, job.user_id, 'compress_done', {
    done: s.done,
    skipped: s.skipped,
    failed: s.failed,
    savedBytes: s.saved,
  });
  await n.stmt.run();
  await ctx.env.NOTIFY_QUEUE.send({ type: 'notification', notificationId: n.id });
}

function hashBytes(bytes: Uint8Array): { sha256: string; crc32: number } {
  return { sha256: new Sha256().update(bytes).hex(), crc32: new Crc32().update(bytes).digest() };
}

async function putOutput(
  ctx: Ctx,
  key: string,
  out: MediaOutput,
): Promise<{ sha256: string | null; crc32: number | null }> {
  const meta = { httpMetadata: { contentType: out.contentType } };
  if (out.bytes) {
    await ctx.env.BUCKET.put(key, out.bytes, meta);
    return hashBytes(out.bytes);
  }
  await ctx.env.BUCKET.put(key, withKnownLength(out.stream!, out.size), meta);
  return { sha256: out.sha256 ?? null, crc32: Number.isFinite(out.crc32) ? out.crc32! : null };
}

export async function processCompressJob(
  ctx: Ctx,
  jobId: string,
): Promise<JobRow['status'] | 'noop'> {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const claim = await DB.prepare(
    `UPDATE compress_jobs SET status = 'running', updated_at = ?2
     WHERE id = ?1 AND (status = 'queued' OR (status = 'running' AND updated_at < ?3 AND source_key IS NULL AND source_node_id IS NOT NULL))`,
  )
    .bind(jobId, now, now - STALE_RUNNING_MS)
    .run();
  // Standalone jobs that are still uploading are 'running' with an uploadId; they're never claimed here.
  const job = await DB.prepare('SELECT * FROM compress_jobs WHERE id = ?1')
    .bind(jobId)
    .first<JobRow>();
  if (!job || claim.meta.changes !== 1) return 'noop';
  const o = opts(job);

  let source: { key: string; size: number; node: NodeRecord | null };
  if (job.source_node_id) {
    const node = await DB.prepare(
      `SELECT * FROM nodes WHERE id = ?1 AND trashed_at IS NULL AND status = 'ready'`,
    )
      .bind(job.source_node_id)
      .first<NodeRecord>();
    const blob = node?.blob_id
      ? await DB.prepare('SELECT r2_key, scan_status FROM blobs WHERE id = ?1')
          .bind(node.blob_id)
          .first<{ r2_key: string; scan_status: string }>()
      : null;
    if (!node || !blob || !['clean', 'skipped'].includes(blob.scan_status)) {
      await finish(ctx, job, 'failed', { error: 'SOURCE_GONE' });
      return 'failed';
    }
    source = { key: blob.r2_key, size: node.size, node };
  } else {
    if (!job.source_key) {
      await finish(ctx, job, 'failed', { error: 'SOURCE_GONE' });
      return 'failed';
    }
    source = { key: job.source_key, size: o.size, node: null };
  }

  const obj = await ctx.env.BUCKET.get(source.key);
  if (!obj) {
    await finish(ctx, job, 'failed', { error: 'SOURCE_GONE' });
    return 'failed';
  }
  let out: MediaOutput;
  try {
    const viaContainer = job.engine === 'ffmpeg';
    out =
      job.kind === 'image'
        ? await ctx.adapters.media.image(obj.body, { ...o.image, viaContainer })
        : await ctx.adapters.media.video(obj.body, { ...o.video, viaContainer });
  } catch (e) {
    log.warn('compress_failed', { jobId, engine: job.engine, error: String(e) });
    await finish(ctx, job, 'failed', { error: 'ENGINE_ERROR' });
    return 'failed';
  }

  if (out.size >= source.size) {
    await out.stream?.cancel();
    await finish(ctx, job, 'skipped', { error: 'NOT_SMALLER', savedBytes: 0 });
    return 'skipped';
  }
  const saved = source.size - out.size;

  if (!source.node) {
    const outKey = `tmp/compress/${job.user_id}/${job.id}-out`;
    await putOutput(ctx, outKey, out);
    await ctx.env.BUCKET.delete(source.key);
    await DB.prepare('UPDATE compress_jobs SET source_key = NULL WHERE id = ?1').bind(job.id).run();
    await finish(ctx, job, 'done', { outKey, savedBytes: saved });
    return 'done';
  }

  const node = source.node;
  const blobId = ulid(now);
  const key = `u/${job.user_id}/${blobId}`;
  const hashes = await putOutput(ctx, key, out);
  // Derived from a scanned file by our own transcoder → inherits the clean verdict (ADR-031).
  const blobInsert = DB.prepare(
    `INSERT INTO blobs (id, pool_id, r2_key, size, sha256, crc32, sniffed_mime, uploader_id, refcount, scan_status, scan_detail, scanned_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, 'clean', 'derived:compress', ?9, ?9)`,
  ).bind(
    blobId,
    node.pool_id,
    key,
    out.size,
    hashes.sha256,
    hashes.crc32,
    out.contentType,
    job.user_id,
    now,
  );

  try {
    if (o.save === 'copy') {
      const parent = await DB.prepare('SELECT * FROM nodes WHERE id = ?1 AND trashed_at IS NULL')
        .bind(node.parent_id)
        .first<NodeRecord>();
      if (!parent) throw new AppError('NOT_FOUND', 'SOURCE_GONE');
      if (!(await addUsedIfFits(ctx, node.pool_id, out.size)))
        throw new AppError('QUOTA_FULL', 'QUOTA_FULL');
      const name = await uniqueName(ctx, parent.id, outName(node.name, job.kind, o, true));
      const outNodeId = ulid(now);
      try {
        await DB.batch([
          blobInsert,
          DB.prepare(
            `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key,
               blob_id, size, mime, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 'file', ?7, ?8, ?9, ?10, ?11, 'ready', ?12, ?12)`,
          ).bind(
            outNodeId,
            parent.pool_id,
            parent.space,
            parent.family_id,
            job.user_id,
            parent.id,
            name,
            nameKey(name),
            blobId,
            out.size,
            out.contentType,
            now,
          ),
        ]);
      } catch (e) {
        await DB.prepare(
          'UPDATE storage_pools SET used_bytes = MAX(0, used_bytes - ?2) WHERE id = ?1',
        )
          .bind(node.pool_id, out.size)
          .run();
        throw e;
      }
      await markManifestDirty(ctx, job.user_id);
      await finish(ctx, job, 'done', { outNodeId, savedBytes: saved });
      return 'done';
    }

    // Replace: swap the node's blob; usage shrinks by the saving; old blob loses one reference.
    const name = await uniqueName(
      ctx,
      node.parent_id!,
      outName(node.name, job.kind, o, false),
      node.id,
    );
    const res = await DB.batch([
      blobInsert,
      DB.prepare(
        `UPDATE nodes SET blob_id = ?2, size = ?3, mime = ?4, name = ?5, name_key = ?6, updated_at = ?7
         WHERE id = ?1 AND blob_id = ?8 AND status = 'ready'`,
      ).bind(node.id, blobId, out.size, out.contentType, name, nameKey(name), now, node.blob_id),
      // Both guarded on "the swap above happened" so a lost race changes nothing.
      DB.prepare(
        `UPDATE storage_pools SET used_bytes = MAX(0, used_bytes - ?2), updated_at = ?3
         WHERE id = ?1 AND (SELECT blob_id FROM nodes WHERE id = ?4) = ?5`,
      ).bind(node.pool_id, saved, now, node.id, blobId),
      DB.prepare(
        `UPDATE blobs SET refcount = MAX(0, refcount - 1) WHERE id = ?1 AND (SELECT blob_id FROM nodes WHERE id = ?2) = ?3`,
      ).bind(node.blob_id, node.id, blobId),
    ]);
    if (res[1]?.meta.changes !== 1) {
      // The file changed while we worked: drop our output, keep theirs.
      await DB.prepare('DELETE FROM blobs WHERE id = ?1').bind(blobId).run();
      await ctx.env.BUCKET.delete(key);
      await finish(ctx, job, 'failed', { error: 'SOURCE_CHANGED' });
      return 'failed';
    }
    const old = await DB.prepare('SELECT refcount FROM blobs WHERE id = ?1')
      .bind(node.blob_id)
      .first<{ refcount: number }>();
    if (old && old.refcount === 0)
      await ctx.env.CLEANUP_QUEUE.send({ type: 'delete_blob', blobId: node.blob_id! });
    await markManifestDirty(ctx, node.owner_id);
    await finish(ctx, job, 'done', { outNodeId: node.id, savedBytes: saved });
    return 'done';
  } catch (e) {
    await ctx.env.BUCKET.delete(key);
    await finish(ctx, job, 'failed', { error: e instanceof AppError ? e.message : 'ERROR' });
    if (!(e instanceof AppError)) log.error('compress_commit_failed', { jobId, error: String(e) });
    return 'failed';
  }
}

// ───────────────────────────── reads & cleanup ─────────────────────────────

export interface JobDto {
  id: string;
  batchId: string | null;
  kind: Kind;
  engine: Engine;
  name: string;
  size: number;
  status: JobRow['status'] | 'uploading';
  save: 'copy' | 'replace';
  standalone: boolean;
  creditsUsed: number;
  savedBytes: number | null;
  outNodeId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function toDto(j: JobRow): JobDto {
  const o = opts(j);
  return {
    id: j.id,
    batchId: j.batch_id,
    kind: j.kind,
    engine: j.engine,
    name: o.name,
    size: o.size,
    status: o.uploadId ? 'uploading' : j.status,
    save: o.save,
    standalone: !j.source_node_id,
    creditsUsed: j.credits_used,
    savedBytes: j.saved_bytes,
    outNodeId: j.out_node_id,
    error: j.error,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  };
}

export async function listJobs(
  ctx: Ctx,
  userId: string,
  limit = 100,
): Promise<{ credits: number; jobs: JobDto[] }> {
  const [{ results }, credits] = await Promise.all([
    ctx.env.DB.prepare(
      'SELECT * FROM compress_jobs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2',
    )
      .bind(userId, limit)
      .all<JobRow>(),
    creditBalance(ctx, userId),
  ]);
  return { credits, jobs: results.map(toDto) };
}

/** Hourly: standalone files are kept 24 h; abandoned uploads are aborted. */
export async function purgeStandalone(ctx: Ctx, limit = 200): Promise<number> {
  const DB = ctx.env.DB;
  const cutoff = ctx.now() - DAY_MS;
  const { results } = await DB.prepare(
    `SELECT * FROM compress_jobs WHERE source_node_id IS NULL AND created_at < ?1 AND (source_key IS NOT NULL OR out_key IS NOT NULL) LIMIT ?2`,
  )
    .bind(cutoff, limit)
    .all<JobRow>();
  for (const j of results) {
    const o = opts(j);
    if (o.uploadId && j.source_key) {
      try {
        await ctx.env.BUCKET.resumeMultipartUpload(j.source_key, o.uploadId).abort();
      } catch {
        // Completed or already gone.
      }
    }
    const keys = [j.source_key, j.out_key].filter((k): k is string => Boolean(k));
    if (keys.length) await ctx.env.BUCKET.delete(keys);
    const clean: StoredOptions = {
      image: o.image,
      video: o.video,
      save: o.save,
      name: o.name,
      size: o.size,
    };
    await DB.prepare(
      `UPDATE compress_jobs SET source_key = NULL, out_key = NULL, options_json = ?2,
         status = CASE WHEN status IN ('queued', 'running') THEN 'failed' ELSE status END,
         error = CASE WHEN status IN ('queued', 'running') THEN 'EXPIRED' ELSE error END, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(j.id, JSON.stringify(clean), ctx.now())
      .run();
    if (j.status === 'queued' || j.status === 'running') await refundCredits(ctx, j.user_id, j.id);
  }
  return results.length;
}

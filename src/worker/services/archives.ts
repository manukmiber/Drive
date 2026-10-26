// "Unduh sebagai arsip" for several files/folders (SPEC §7.2). ZIP store and ZIP deflate (≤
// zip_deflate_stream_max_bytes) stream on the fly from R2 behind a signed, cookie-less /z/ URL.
// TAR.ZST and larger deflate ZIPs are async jobs (Queue `archive` → Container `archiver`) whose
// result lands in tmp/archives/ for archive_link_ttl_hours.
import type { Ctx } from '../context';
import type { AsyncFormat } from '../adapters/archiver';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isUlid, ulid } from '../lib/ids';
import { log } from '../lib/log';
import { putKnownLength } from '../lib/r2-put';
import { tarSize, tarStream } from '../lib/tar';
import { collectEntries, type ArchiveContent } from './archive';
import { requireNode } from './access';
import { notify } from './notify';

export type StreamFormat = 'zip_store' | 'zip_deflate';
export type ArchiveFormat = StreamFormat | 'tar_zst';
export type ZstdLevel = 'fast' | 'normal' | 'max';

const sign = (secret: string, id: string, exp: number) => hmacBase62(secret, `z|${id}|${exp}`, 32);

export interface ArchiveCreated {
  id: string;
  /** Present for streamed formats; async jobs get theirs once done (see listArchives). */
  url: string | null;
  async: boolean;
  status: 'done' | 'queued';
  totalBytes: number;
  fileCount: number;
  expiresAt: number | null;
}

export async function createArchive(
  ctx: Ctx,
  userId: string,
  input: { nodeIds: string[]; format: ArchiveFormat; level?: ZstdLevel | undefined },
): Promise<ArchiveCreated> {
  const ids = [...new Set(input.nodeIds)];
  if (!ids.length || ids.length > 1000)
    throw new AppError('VALIDATION', 'between 1 and 1000 items');
  for (const id of ids) await requireNode(ctx, userId, id, 'view');
  const cfg = await ctx.config();
  const content = await collectEntries(ctx, ids, { maxItems: cfg.archive_max_items });
  if (!content.fileCount) throw new AppError('CONFLICT', 'nothing downloadable in the selection');
  const now = ctx.now();
  const id = ulid(now);
  const isAsync =
    input.format === 'tar_zst' ||
    (input.format === 'zip_deflate' && content.totalBytes > cfg.zip_deflate_stream_max_bytes);

  if (isAsync) {
    if (ctx.adapters.archiver.name === 'none')
      throw new AppError('BAD_REQUEST', 'ARCHIVER_UNAVAILABLE');
    if (content.totalBytes > cfg.archive_async_max_bytes)
      throw new AppError('PAYLOAD_TOO_LARGE', 'ARCHIVE_TOO_LARGE', {
        max: cfg.archive_async_max_bytes,
      });
    const running = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM archive_jobs WHERE user_id = ?1 AND status IN ('queued', 'running')`,
    )
      .bind(userId)
      .first<{ n: number }>();
    if ((running?.n ?? 0) >= cfg.archive_max_running_jobs_per_user)
      throw new AppError('CONFLICT', 'ARCHIVE_JOB_RUNNING');
    const level = input.format === 'tar_zst' ? cfg.zstd_levels[input.level ?? 'normal'] : 6;
    await ctx.env.DB.prepare(
      `INSERT INTO archive_jobs (id, user_id, node_ids_json, format, level, name, status, progress, total_bytes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, ?7, ?8, ?8)`,
    )
      .bind(
        id,
        userId,
        JSON.stringify(ids),
        input.format,
        level,
        archiveName(ctx, content, input.format),
        content.totalBytes,
        now,
      )
      .run();
    await ctx.env.ARCHIVE_QUEUE.send({ type: 'archive', jobId: id });
    return {
      id,
      url: null,
      async: true,
      status: 'queued',
      totalBytes: content.totalBytes,
      fileCount: content.fileCount,
      expiresAt: null,
    };
  }

  const expiresAt = now + cfg.archive_link_ttl_hours * 3600_000;
  await ctx.env.DB.prepare(
    `INSERT INTO archive_jobs (id, user_id, node_ids_json, format, status, progress, total_bytes, expires_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'done', 100, ?5, ?6, ?7, ?7)`,
  )
    .bind(id, userId, JSON.stringify(ids), input.format, content.totalBytes, expiresAt, now)
    .run();
  return {
    id,
    url: await signedUrl(ctx, id, expiresAt, archiveName(ctx, content, input.format)),
    async: false,
    status: 'done',
    totalBytes: content.totalBytes,
    fileCount: content.fileCount,
    expiresAt,
  };
}

/** Size/count preview for the download dialog (SPEC §7.1). */
export async function estimateArchive(
  ctx: Ctx,
  userId: string,
  nodeIds: string[],
): Promise<{ totalBytes: number; fileCount: number; streamDeflateMax: number; asyncMax: number }> {
  const ids = [...new Set(nodeIds)].slice(0, 1000);
  for (const id of ids) await requireNode(ctx, userId, id, 'view');
  const cfg = await ctx.config();
  const c = await collectEntries(ctx, ids, { maxItems: cfg.archive_max_items });
  return {
    totalBytes: c.totalBytes,
    fileCount: c.fileCount,
    streamDeflateMax: cfg.zip_deflate_stream_max_bytes,
    asyncMax: cfg.archive_async_max_bytes,
  };
}

async function signedUrl(ctx: Ctx, id: string, expiresAt: number, name: string): Promise<string> {
  const exp = Math.floor(expiresAt / 1000);
  const token = `${id}.${exp}.${await sign(ctx.env.DOWNLOAD_SECRET, id, exp)}`;
  return `/z/${token}/${encodeURIComponent(name)}`;
}

const EXT: Record<ArchiveFormat, string> = {
  zip_store: '.zip',
  zip_deflate: '.zip',
  tar_zst: '.tar.zst',
};

function archiveName(ctx: Ctx, content: ArchiveContent, format: ArchiveFormat): string {
  const roots = new Set(content.entries.map((e) => e.path.split('/')[0]));
  const d = new Date(ctx.now() + 7 * 3600_000).toISOString().slice(0, 10);
  return `${roots.size === 1 ? [...roots][0] : `Zeiko-${d}`}${EXT[format]}`;
}

export async function verifyArchiveToken(ctx: Ctx, token: string): Promise<string | null> {
  const [id, expStr, sig] = token.split('.');
  if (!id || !expStr || !sig || !isUlid(id) || !/^\d{1,12}$/.test(expStr)) return null;
  const exp = Number(expStr);
  if (exp * 1000 < ctx.now()) return null;
  return timingSafeEqual(sig, await sign(ctx.env.DOWNLOAD_SECRET, id, exp)) ? id : null;
}

export type LoadedArchive =
  | { kind: 'stream'; format: StreamFormat; content: ArchiveContent }
  | { kind: 'stored'; format: ArchiveFormat; key: string; size: number };

/**
 * Streamed formats re-check access at download time (removed members or trashed items drop out).
 * Stored (async) archives were built with the access the user had when the job ran.
 */
export async function loadArchive(ctx: Ctx, id: string): Promise<LoadedArchive | null> {
  const job = await ctx.env.DB.prepare('SELECT * FROM archive_jobs WHERE id = ?1')
    .bind(id)
    .first<JobRow>();
  if (!job || job.status !== 'done' || (job.expires_at !== null && job.expires_at < ctx.now()))
    return null;
  if (job.out_key)
    return { kind: 'stored', format: job.format, key: job.out_key, size: job.out_bytes ?? 0 };
  if (job.format !== 'zip_store' && job.format !== 'zip_deflate') return null;
  return { kind: 'stream', format: job.format, content: await accessibleContent(ctx, job) };
}

interface JobRow {
  id: string;
  user_id: string;
  node_ids_json: string;
  format: ArchiveFormat;
  level: number | null;
  name: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  progress: number;
  total_bytes: number;
  out_key: string | null;
  out_bytes: number | null;
  expires_at: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

async function accessibleContent(ctx: Ctx, job: JobRow): Promise<ArchiveContent> {
  const ids: string[] = [];
  for (const nodeId of JSON.parse(job.node_ids_json) as string[]) {
    try {
      await requireNode(ctx, job.user_id, nodeId, 'view');
      ids.push(nodeId);
    } catch {
      // gone or no longer accessible — skip
    }
  }
  return collectEntries(ctx, ids);
}

const STALE_RUNNING_MS = 20 * 60_000;

/** Queue `archive`: tar of the selection → archiver → tmp/archives/{id}{ext}. */
export async function processArchiveJob(
  ctx: Ctx,
  jobId: string,
): Promise<'done' | 'failed' | 'noop'> {
  const DB = ctx.env.DB;
  const now = ctx.now();
  const claim = await DB.prepare(
    `UPDATE archive_jobs SET status = 'running', progress = 0, updated_at = ?2
     WHERE id = ?1 AND (status = 'queued' OR (status = 'running' AND updated_at < ?3))`,
  )
    .bind(jobId, now, now - STALE_RUNNING_MS)
    .run();
  if (claim.meta.changes !== 1) return 'noop';
  const job = (await DB.prepare('SELECT * FROM archive_jobs WHERE id = ?1')
    .bind(jobId)
    .first<JobRow>())!;
  const fail = async (error: string) => {
    await DB.prepare(
      `UPDATE archive_jobs SET status = 'failed', error = ?2, updated_at = ?3 WHERE id = ?1`,
    )
      .bind(jobId, error, ctx.now())
      .run();
    return 'failed' as const;
  };
  const content = await accessibleContent(ctx, job);
  if (!content.fileCount) return fail('EMPTY');
  const cfg = await ctx.config();
  const size = tarSize(content.entries);

  // Progress = share of the tar handed to the archiver (written at most every 5 %).
  let sent = 0;
  let reported = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      sent += chunk.length;
      const pct = Math.min(95, Math.floor((sent / size) * 95));
      if (pct >= reported + 5) {
        reported = pct;
        await DB.prepare('UPDATE archive_jobs SET progress = ?2, updated_at = ?3 WHERE id = ?1')
          .bind(jobId, pct, ctx.now())
          .run();
      }
      controller.enqueue(chunk);
    },
  });
  const key = `tmp/archives/${jobId}${EXT[job.format]}`;
  try {
    const out = await ctx.adapters.archiver.build({
      jobId,
      format: job.format as AsyncFormat,
      level: job.level ?? 3,
      tar: tarStream(ctx.env.BUCKET, content.entries).pipeThrough(counter),
      tarSize: size,
      entries: content.entries,
    });
    await putKnownLength(ctx.env.BUCKET, key, out.stream, out.size, {
      httpMetadata: { contentType: out.contentType },
    });
    const expiresAt = ctx.now() + cfg.archive_link_ttl_hours * 3600_000;
    const name = job.name ?? archiveName(ctx, content, job.format);
    await DB.prepare(
      `UPDATE archive_jobs SET status = 'done', progress = 100, out_key = ?2, out_bytes = ?3, expires_at = ?4, error = NULL, updated_at = ?5 WHERE id = ?1`,
    )
      .bind(jobId, key, out.size, expiresAt, ctx.now())
      .run();
    await notify(ctx, job.user_id, 'archive_ready', { jobId, name, bytes: out.size });
    return 'done';
  } catch (e) {
    log.warn('archive_failed', { jobId, error: String(e) });
    await ctx.env.BUCKET.delete(key).catch(() => undefined);
    return fail('BUILD_FAILED');
  }
}

export interface ArchiveJobDto {
  id: string;
  name: string | null;
  format: ArchiveFormat;
  status: JobRow['status'];
  progress: number;
  totalBytes: number;
  outBytes: number | null;
  url: string | null;
  error: string | null;
  createdAt: number;
  expiresAt: number | null;
}

/** The user's async jobs (newest first); done ones carry a fresh signed link. */
export async function listArchives(ctx: Ctx, userId: string): Promise<ArchiveJobDto[]> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM archive_jobs WHERE user_id = ?1 AND (out_key IS NOT NULL OR status IN ('queued', 'running', 'failed', 'expired'))
     AND created_at > ?2 ORDER BY created_at DESC LIMIT 30`,
  )
    .bind(userId, ctx.now() - 7 * 86_400_000)
    .all<JobRow>();
  return Promise.all(
    results.map(async (j) => ({
      id: j.id,
      name: j.name,
      format: j.format,
      status: j.status,
      progress: j.progress,
      totalBytes: j.total_bytes,
      outBytes: j.out_bytes,
      url:
        j.status === 'done' && j.out_key && j.expires_at && j.expires_at > ctx.now()
          ? await signedUrl(
              ctx,
              j.id,
              j.expires_at,
              j.name ?? `Zeiko-${j.id.slice(-6)}${EXT[j.format]}`,
            )
          : null,
      error: j.error,
      createdAt: j.created_at,
      expiresAt: j.expires_at,
    })),
  );
}

/** Hourly: built archives are deleted after archive_link_ttl_hours (R2 lifecycle on tmp/ backs this up). */
export async function expireArchives(ctx: Ctx, limit = 200): Promise<number> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, out_key FROM archive_jobs WHERE out_key IS NOT NULL AND expires_at < ?1 LIMIT ?2`,
  )
    .bind(ctx.now(), limit)
    .all<{ id: string; out_key: string }>();
  if (!results.length) return 0;
  await ctx.env.BUCKET.delete(results.map((r) => r.out_key));
  await ctx.env.DB.batch(
    results.map((r) =>
      ctx.env.DB.prepare(
        `UPDATE archive_jobs SET status = 'expired', out_key = NULL, updated_at = ?2 WHERE id = ?1`,
      ).bind(r.id, ctx.now()),
    ),
  );
  return results.length;
}

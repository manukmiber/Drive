// Chunked, resumable, parallel uploads (SPEC §5.2). The client never sees R2 credentials or
// presigned URLs: every byte passes through the Worker via the R2 binding.
import {
  HOUR_MS,
  MIB,
  R2_MAX_PARTS,
  SIMPLE_UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_PART_MAX_BYTES,
  UPLOAD_PART_MIN_BYTES,
} from '../../shared/constants';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { log } from '../lib/log';
import { nameKey, sanitizeName } from '../lib/names';
import { requireNode, type NodeRecord } from './access';
import {
  getNodeDto,
  markManifestDirty,
  siblingByName,
  trashNodes,
  uniqueName,
  type NodeDto,
} from './nodes';
import { quotaFullError, releaseQuotaStmt, reserveQuota } from './quota';
import { getActiveSubscription } from './storage';

/** partSize = clamp(ceilToMiB(size / 10 000), 16 MiB, 64 MiB) — SPEC §5.2. */
export function partSizeFor(size: number): number {
  const raw = Math.ceil(size / R2_MAX_PARTS / MIB) * MIB;
  return Math.min(Math.max(raw, UPLOAD_PART_MIN_BYTES), UPLOAD_PART_MAX_BYTES);
}

export function totalPartsFor(size: number, partSize: number): number {
  return Math.max(1, Math.ceil(size / partSize));
}

export function expectedPartSize(
  size: number,
  partSize: number,
  totalParts: number,
  n: number,
): number {
  return n < totalParts ? partSize : size - partSize * (totalParts - 1);
}

/** Placeholder key so in-flight uploads don't hold the sibling name (ADR-021). */
const pendingKey = (nodeId: string) => `\u0001up:${nodeId}`;

export type OnConflict = 'error' | 'rename' | 'replace';

export interface InitInput {
  parentId: string;
  name: string;
  size: number;
  mime?: string | null | undefined;
  lastModified?: number | null | undefined;
  onConflict?: OnConflict | undefined;
}

interface UploadRow {
  id: string;
  user_id: string;
  pool_id: string;
  node_id: string;
  blob_id: string;
  r2_key: string;
  r2_upload_id: string | null;
  size: number;
  part_size: number;
  total_parts: number;
  reserved_bytes: number;
  on_conflict: 'rename' | 'replace';
  status: 'active' | 'completed' | 'aborted' | 'expired';
  expires_at: number;
}

function cleanMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const m = mime.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(m) && m.length <= 127 ? m : null;
}

/** Shared checks for multipart init and simple upload. */
async function prepare(ctx: Ctx, userId: string, input: InitInput) {
  const name = sanitizeName(input.name);
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new AppError('VALIDATION', 'invalid size');
  const { node: parent } = await requireNode(ctx, userId, input.parentId, 'edit');
  if (parent.kind !== 'folder') throw new AppError('BAD_REQUEST', 'parent is not a folder');
  if (parent.trashed_at !== null) throw new AppError('CONFLICT', 'parent folder is in the trash');

  const sub = await getActiveSubscription(ctx, parent.pool_id);
  if (sub && (sub.status === 'readonly' || sub.status === 'suspended')) {
    throw new AppError('READ_ONLY', 'account is read-only', { subscriptionStatus: sub.status });
  }
  if (!sub) throw await quotaFullError(ctx, parent.pool_id, input.size);
  const maxFile = Math.min(sub.maxFileBytes, UPLOAD_MAX_FILE_BYTES);
  if (input.size > maxFile)
    throw new AppError('FILE_TOO_LARGE', 'file too large', { maxFileBytes: maxFile });

  const onConflict = input.onConflict ?? 'error';
  const existing = await siblingByName(ctx, parent.id, name);
  if (existing && onConflict === 'error') {
    throw new AppError('NAME_CONFLICT', 'name already used', {
      existingId: existing.id,
      kind: existing.kind,
    });
  }
  return {
    name,
    parent,
    onConflict: onConflict === 'replace' ? ('replace' as const) : ('rename' as const),
  };
}

function insertRows(
  ctx: Ctx,
  p: {
    userId: string;
    parent: NodeRecord;
    nodeId: string;
    blobId: string;
    uploadId: string;
    key: string;
    r2UploadId: string | null;
    name: string;
    size: number;
    mime: string | null;
    lastModified: number | null;
    partSize: number;
    totalParts: number;
    onConflict: 'rename' | 'replace';
    status: 'uploading' | 'scanning';
    uploadStatus: 'active' | 'completed';
    expiresAt: number;
  },
): D1PreparedStatement[] {
  const DB = ctx.env.DB;
  const now = ctx.now();
  return [
    DB.prepare(
      `INSERT INTO blobs (id, pool_id, r2_key, size, uploader_id, refcount, scan_status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 1, 'pending', ?6)`,
    ).bind(p.blobId, p.parent.pool_id, p.key, p.size, p.userId, now),
    DB.prepare(
      `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key,
         blob_id, size, mime, status, client_modified_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 'file', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
    ).bind(
      p.nodeId,
      p.parent.pool_id,
      p.parent.space,
      p.parent.family_id,
      p.userId,
      p.parent.id,
      p.name,
      pendingKey(p.nodeId),
      p.blobId,
      p.size,
      p.mime,
      p.status,
      p.lastModified,
      now,
    ),
    DB.prepare(
      `INSERT INTO uploads (id, user_id, pool_id, node_id, blob_id, r2_key, r2_upload_id, size, part_size,
         total_parts, reserved_bytes, on_conflict, status, expires_at, created_at, completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?8, ?11, ?12, ?13, ?14, ?15)`,
    ).bind(
      p.uploadId,
      p.userId,
      p.parent.pool_id,
      p.nodeId,
      p.blobId,
      p.key,
      p.r2UploadId,
      p.size,
      p.partSize,
      p.totalParts,
      p.onConflict,
      p.uploadStatus,
      p.expiresAt,
      now,
      p.uploadStatus === 'completed' ? now : null,
    ),
  ];
}

export interface InitResult {
  uploadId: string;
  nodeId: string;
  partSize: number;
  totalParts: number;
}

export async function initUpload(ctx: Ctx, userId: string, input: InitInput): Promise<InitResult> {
  const { name, parent, onConflict } = await prepare(ctx, userId, input);
  const partSize = partSizeFor(input.size);
  const totalParts = totalPartsFor(input.size, partSize);
  if (!(await reserveQuota(ctx, parent.pool_id, input.size))) {
    throw await quotaFullError(ctx, parent.pool_id, input.size);
  }
  const now = ctx.now();
  const cfg = await ctx.config();
  const blobId = ulid(now);
  const nodeId = ulid(now);
  const uploadId = ulid(now);
  const key = `u/${userId}/${blobId}`;
  let mpu: R2MultipartUpload | null = null;
  try {
    mpu = await ctx.env.BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    await ctx.env.DB.batch(
      insertRows(ctx, {
        userId,
        parent,
        nodeId,
        blobId,
        uploadId,
        key,
        r2UploadId: mpu.uploadId,
        name,
        size: input.size,
        mime: cleanMime(input.mime),
        lastModified: input.lastModified ?? null,
        partSize,
        totalParts,
        onConflict,
        status: 'uploading',
        uploadStatus: 'active',
        expiresAt: now + cfg.upload_expiry_hours * HOUR_MS,
      }),
    );
  } catch (e) {
    await releaseQuotaStmt(ctx, parent.pool_id, input.size).run();
    if (mpu) await mpu.abort().catch(() => undefined);
    throw e;
  }
  return { uploadId, nodeId, partSize, totalParts };
}

async function requireUpload(ctx: Ctx, userId: string, uploadId: string): Promise<UploadRow> {
  const row = await ctx.env.DB.prepare('SELECT * FROM uploads WHERE id = ?1')
    .bind(uploadId)
    .first<UploadRow>();
  if (!row || row.user_id !== userId) throw new AppError('NOT_FOUND', 'upload not found');
  return row;
}

function requireActive(up: UploadRow, now: number): void {
  if (up.status !== 'active')
    throw new AppError('UPLOAD_STATE', `upload is ${up.status}`, { status: up.status });
  if (up.expires_at <= now)
    throw new AppError('UPLOAD_STATE', 'upload expired', { status: 'expired' });
}

export async function uploadPart(
  ctx: Ctx,
  userId: string,
  uploadId: string,
  partNumber: number,
  contentLength: number | null,
  body: ReadableStream | null,
): Promise<{ partNumber: number; size: number }> {
  const up = await requireUpload(ctx, userId, uploadId);
  requireActive(up, ctx.now());
  if (!up.r2_upload_id) throw new AppError('UPLOAD_STATE', 'not a multipart upload');
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > up.total_parts) {
    throw new AppError('VALIDATION', 'invalid part number');
  }
  const expected = expectedPartSize(up.size, up.part_size, up.total_parts, partNumber);
  if (contentLength === null) throw new AppError('VALIDATION', 'Content-Length is required');
  if (contentLength !== expected) {
    throw new AppError('VALIDATION', 'part has the wrong size', { expected, got: contentLength });
  }
  if (!body && expected > 0) throw new AppError('VALIDATION', 'empty body');
  // Stream straight to R2 — the chunk is never buffered in the Worker.
  const part = await ctx.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id).uploadPart(
    partNumber,
    body ?? new Uint8Array(0),
  );
  await ctx.env.DB.prepare(
    `INSERT INTO upload_parts (upload_id, part_number, etag, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = excluded.etag, size = excluded.size,
       created_at = excluded.created_at`,
  )
    .bind(uploadId, partNumber, part.etag, expected, ctx.now())
    .run();
  return { partNumber, size: expected };
}

export async function uploadStatus(ctx: Ctx, userId: string, uploadId: string) {
  const up = await requireUpload(ctx, userId, uploadId);
  const { results } = await ctx.env.DB.prepare(
    'SELECT part_number FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number',
  )
    .bind(uploadId)
    .all<{ part_number: number }>();
  const expired = up.status === 'active' && up.expires_at <= ctx.now();
  return {
    uploadId: up.id,
    nodeId: up.node_id,
    status: expired ? 'expired' : up.status,
    size: up.size,
    partSize: up.part_size,
    totalParts: up.total_parts,
    uploadedParts: results.map((r) => r.part_number),
  };
}

/** Sets the final visible name (ADR-021) and flips the node to `scanning`. */
async function finalizeNode(
  ctx: Ctx,
  userId: string,
  up: Pick<UploadRow, 'node_id' | 'on_conflict'>,
): Promise<void> {
  const node = await ctx.env.DB.prepare('SELECT * FROM nodes WHERE id = ?1')
    .bind(up.node_id)
    .first<NodeRecord>();
  if (!node) throw new AppError('NOT_FOUND', 'node disappeared');
  for (let attempt = 0; attempt < 3; attempt++) {
    let name = node.name;
    const clash = node.parent_id ? await siblingByName(ctx, node.parent_id, name) : null;
    if (clash && clash.id !== node.id) {
      let replaced = false;
      if (up.on_conflict === 'replace' && clash.kind === 'file') {
        try {
          await trashNodes(ctx, userId, [clash.id]);
          replaced = true;
        } catch (e) {
          if (!(e instanceof AppError)) throw e; // no permission → keep both
        }
      }
      if (!replaced) name = await uniqueName(ctx, node.parent_id!, name, node.id);
    }
    try {
      await ctx.env.DB.prepare(
        `UPDATE nodes SET status = 'scanning', name = ?2, name_key = ?3, updated_at = ?4
         WHERE id = ?1 AND status = 'uploading'`,
      )
        .bind(node.id, name, nameKey(name), ctx.now())
        .run();
      return;
    } catch (e) {
      if (!(e instanceof Error && /UNIQUE/.test(e.message)) || attempt === 2) throw e;
    }
  }
}

async function enqueueScan(ctx: Ctx, blobId: string): Promise<void> {
  await ctx.env.SCAN_QUEUE.send({ type: 'scan', blobId });
}

export async function completeUpload(ctx: Ctx, userId: string, uploadId: string): Promise<NodeDto> {
  const up = await requireUpload(ctx, userId, uploadId);
  if (up.status === 'completed') return getNodeDto(ctx, userId, up.node_id); // idempotent
  requireActive(up, ctx.now());
  if (!up.r2_upload_id) throw new AppError('UPLOAD_STATE', 'not a multipart upload');

  // Assemble from the etags stored in D1, never from the client (SPEC §5.2).
  const { results: parts } = await ctx.env.DB.prepare(
    'SELECT part_number, etag, size FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number',
  )
    .bind(uploadId)
    .all<{ part_number: number; etag: string; size: number }>();
  const missing: number[] = [];
  const have = new Set(parts.map((p) => p.part_number));
  for (let n = 1; n <= up.total_parts; n++) if (!have.has(n)) missing.push(n);
  if (missing.length)
    throw new AppError('UPLOAD_STATE', 'parts missing', { missing: missing.slice(0, 100) });

  const mpu = ctx.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id);
  try {
    await mpu.complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  } catch (e) {
    log.error('upload_complete_failed', {
      uploadId,
      message: e instanceof Error ? e.message : String(e),
    });
    throw new AppError('UPLOAD_STATE', 'could not assemble upload');
  }
  const head = await ctx.env.BUCKET.head(up.r2_key);
  if (!head || head.size !== up.size) {
    await ctx.env.BUCKET.delete(up.r2_key);
    await discardUpload(ctx, up, 'aborted');
    throw new AppError('UPLOAD_STATE', 'uploaded size does not match', {
      expected: up.size,
      got: head?.size ?? null,
    });
  }
  const now = ctx.now();
  await ctx.env.DB.prepare(
    `UPDATE uploads SET status = 'completed', completed_at = ?2 WHERE id = ?1`,
  )
    .bind(uploadId, now)
    .run();
  await finalizeNode(ctx, userId, up);
  await enqueueScan(ctx, up.blob_id);
  await markManifestDirty(ctx, userId);
  return getNodeDto(ctx, userId, up.node_id);
}

/**
 * Releases the reservation and removes the hidden node + blob of an unfinished upload.
 * The pool update is conditional on the upload still being `active`, so abort, expiry and a
 * concurrent delete can't release twice.
 */
async function discardUpload(
  ctx: Ctx,
  up: UploadRow,
  status: 'aborted' | 'expired',
): Promise<void> {
  const DB = ctx.env.DB;
  const now = ctx.now();
  await DB.batch([
    DB.prepare(
      `UPDATE storage_pools SET reserved_bytes = MAX(0, reserved_bytes - ?2), updated_at = ?4
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM uploads WHERE id = ?3 AND status = 'active')`,
    ).bind(up.pool_id, up.reserved_bytes, up.id, now),
    DB.prepare(
      `UPDATE uploads SET status = ?2, completed_at = ?3 WHERE id = ?1 AND status = 'active'`,
    ).bind(up.id, status, now),
    DB.prepare(`DELETE FROM nodes WHERE id = ?1 AND status = 'uploading'`).bind(up.node_id),
    DB.prepare(
      `DELETE FROM blobs WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM nodes WHERE blob_id = ?1)`,
    ).bind(up.blob_id),
  ]);
}

export async function abortUpload(ctx: Ctx, userId: string, uploadId: string): Promise<void> {
  const up = await requireUpload(ctx, userId, uploadId);
  if (up.status !== 'active') return;
  if (up.r2_upload_id) {
    await ctx.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id)
      .abort()
      .catch(() => undefined);
  }
  await discardUpload(ctx, up, 'aborted');
}

/** Hourly cron: abort uploads past expires_at (before R2's 7-day auto-abort). */
export async function expireUploads(ctx: Ctx, limit = 100): Promise<number> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM uploads WHERE status = 'active' AND expires_at <= ?1 ORDER BY expires_at LIMIT ?2`,
  )
    .bind(ctx.now(), limit)
    .all<UploadRow>();
  for (const up of results) {
    if (up.r2_upload_id) {
      await ctx.env.BUCKET.resumeMultipartUpload(up.r2_key, up.r2_upload_id)
        .abort()
        .catch(() => undefined);
    }
    await discardUpload(ctx, up, 'expired');
  }
  return results.length;
}

/** Single-request upload for files ≤ 16 MiB (still reserves quota first). */
export async function simpleUpload(
  ctx: Ctx,
  userId: string,
  input: InitInput,
  contentLength: number | null,
  body: ReadableStream | null,
): Promise<NodeDto> {
  if (input.size > SIMPLE_UPLOAD_MAX_BYTES)
    throw new AppError('PAYLOAD_TOO_LARGE', 'use multipart upload');
  if (contentLength !== input.size) {
    throw new AppError('VALIDATION', 'Content-Length must equal size', {
      expected: input.size,
      got: contentLength,
    });
  }
  const { name, parent, onConflict } = await prepare(ctx, userId, input);
  if (!(await reserveQuota(ctx, parent.pool_id, input.size))) {
    throw await quotaFullError(ctx, parent.pool_id, input.size);
  }
  const now = ctx.now();
  const blobId = ulid(now);
  const nodeId = ulid(now);
  const key = `u/${userId}/${blobId}`;
  try {
    const obj = await ctx.env.BUCKET.put(key, body ?? new Uint8Array(0), {
      httpMetadata: { contentType: 'application/octet-stream' },
    });
    if (!obj || obj.size !== input.size) {
      await ctx.env.BUCKET.delete(key);
      throw new AppError('UPLOAD_STATE', 'uploaded size does not match');
    }
    await ctx.env.DB.batch(
      insertRows(ctx, {
        userId,
        parent,
        nodeId,
        blobId,
        uploadId: ulid(now),
        key,
        r2UploadId: null,
        name,
        size: input.size,
        mime: cleanMime(input.mime),
        lastModified: input.lastModified ?? null,
        partSize: input.size,
        totalParts: 1,
        onConflict,
        status: 'uploading',
        uploadStatus: 'completed',
        expiresAt: now,
      }),
    );
  } catch (e) {
    await releaseQuotaStmt(ctx, parent.pool_id, input.size).run();
    await ctx.env.BUCKET.delete(key).catch(() => undefined);
    throw e;
  }
  await finalizeNode(ctx, userId, { node_id: nodeId, on_conflict: onConflict });
  await enqueueScan(ctx, blobId);
  await markManifestDirty(ctx, userId);
  return getNodeDto(ctx, userId, nodeId);
}

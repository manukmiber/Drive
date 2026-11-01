// D3 (ADR-086): file request links. The folder's owner makes a link through which anyone, without an
// account, may only upload into that folder: each uploader's files land in a subfolder of their own,
// on the owner's quota, through the same multipart protocol as the app (services/uploads.ts) with
// the owner as the acting user. The uploader never sees the folder: the link answers only with its
// title and message, and each upload is reached with a token for that upload alone.
//
// Links are rows of the access database (`file_requests`, migrations-access/0004), signed like share
// links: /minta/{r64}/{s32}. The owner hears about new files once an hour, not per file.
import { SHARE_ID_LENGTH, SHARE_SIG_LENGTH } from '../../shared/constants';
import type { Ctx } from '../context';
import { idSlices } from '../lib/access-db';
import { hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isBase62, randomBase62 } from '../lib/ids';
import { sanitizeName } from '../lib/names';
import { appUrl } from '../lib/paths';
import { loadNode, requireNode } from './access';
import { grantsDb } from './grant-lookup';
import { createFolder, type NodeDto } from './nodes';
import { notify } from './notify';
import { hashPassword, verifyPassword } from './shares';
import { getActiveSubscription } from './storage';
import { abortUpload, completeUpload, initUpload, uploadPart, type InitResult } from './uploads';

export interface RequestRow {
  id: string;
  created_by: string;
  folder_id: string;
  title: string;
  message: string | null;
  deadline_at: number | null;
  max_files: number | null;
  max_file_bytes: number | null;
  require_name: number;
  password_hash: string | null;
  file_count: number;
  pending_notice: number;
  revoked_at: number | null;
  created_at: number;
}

interface DropRow {
  upload_id: string;
  request_id: string;
  node_id: string | null;
  uploader_name: string | null;
  ip_hash: string;
  size: number;
  status: 'active' | 'done' | 'aborted';
  created_at: number;
}

export type RequestState = 'open' | 'revoked' | 'expired' | 'full' | 'unavailable';

export interface RequestDto {
  id: string;
  url: string;
  folderId: string;
  title: string;
  message: string | null;
  deadlineAt: number | null;
  maxFiles: number | null;
  maxFileBytes: number | null;
  requireName: boolean;
  hasPassword: boolean;
  fileCount: number;
  state: RequestState;
  createdAt: number;
}

/** Without the access database there are no request links (ADR-086, like person shares). */
function db(ctx: Ctx): D1Database {
  const A = grantsDb(ctx.env);
  if (!A) throw new AppError('BAD_REQUEST', 'file requests are not available yet');
  return A;
}

const sign = (secret: string, id: string) => hmacBase62(secret, `request|${id}`, SHARE_SIG_LENGTH);

async function signatureOk(ctx: Ctx, id: string, sig: string): Promise<boolean> {
  if (!isBase62(id) || id.length !== SHARE_ID_LENGTH || sig.length !== SHARE_SIG_LENGTH)
    return false;
  for (const s of [ctx.env.SHARE_LINK_SECRET, ctx.env.SHARE_LINK_SECRET_PREV])
    if (s && timingSafeEqual(await sign(s, id), sig)) return true;
  return false;
}

export async function requestUrl(ctx: Ctx, id: string): Promise<string> {
  return appUrl(ctx.env, `/minta/${id}/${await sign(ctx.env.SHARE_LINK_SECRET, id)}`);
}

/** Whether it still takes files: not revoked, before its deadline, room left, folder and pool fine. */
async function stateOf(ctx: Ctx, r: RequestRow): Promise<RequestState> {
  if (r.revoked_at !== null) return 'revoked';
  if (r.deadline_at !== null && r.deadline_at <= ctx.now()) return 'expired';
  if (r.max_files !== null && r.file_count >= r.max_files) return 'full';
  const folder = await loadNode(ctx, r.folder_id);
  if (!folder || folder.trashed_at !== null || folder.kind !== 'folder') return 'unavailable';
  const sub = await getActiveSubscription(ctx, folder.pool_id);
  if (!sub || sub.status === 'readonly' || sub.status === 'suspended') return 'unavailable';
  return 'open';
}

async function toDto(ctx: Ctx, r: RequestRow): Promise<RequestDto> {
  return {
    id: r.id,
    url: await requestUrl(ctx, r.id),
    folderId: r.folder_id,
    title: r.title,
    message: r.message,
    deadlineAt: r.deadline_at,
    maxFiles: r.max_files,
    maxFileBytes: r.max_file_bytes,
    requireName: r.require_name === 1,
    hasPassword: r.password_hash !== null,
    fileCount: r.file_count,
    state: await stateOf(ctx, r),
    createdAt: r.created_at,
  };
}

export interface CreateRequestInput {
  folderId: string;
  title: string;
  message?: string | null | undefined;
  deadlineAt?: number | null | undefined;
  maxFiles?: number | null | undefined;
  maxFileBytes?: number | null | undefined;
  requireName?: boolean | undefined;
  password?: string | null | undefined;
}

/** A new link into a folder the person may add to (not one only shared with them). */
export async function createRequest(
  ctx: Ctx,
  userId: string,
  input: CreateRequestInput,
): Promise<RequestDto> {
  const A = db(ctx);
  const { node, access } = await requireNode(ctx, userId, input.folderId, 'add');
  if (access.shared) throw new AppError('FORBIDDEN', 'only the owner can ask for files here');
  if (node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'not a folder');
  if (node.trashed_at !== null) throw new AppError('CONFLICT', 'folder is in the trash');
  const now = ctx.now();
  if (input.deadlineAt != null && input.deadlineAt <= now)
    throw new AppError('VALIDATION', 'deadline must be in the future');
  const open = await A.prepare(
    'SELECT COUNT(*) AS n FROM file_requests WHERE created_by = ?1 AND revoked_at IS NULL',
  )
    .bind(userId)
    .first<{ n: number }>();
  const cfg = await ctx.config();
  if ((open?.n ?? 0) >= cfg.file_request_max_open)
    throw new AppError('VALIDATION', `at most ${cfg.file_request_max_open} open requests`);
  const id = randomBase62(SHARE_ID_LENGTH);
  await A.prepare(
    `INSERT INTO file_requests (id, created_by, folder_id, title, message, deadline_at, max_files,
       max_file_bytes, require_name, password_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      userId,
      node.id,
      input.title.trim().slice(0, 200) || node.name,
      input.message?.trim().slice(0, 1000) || null,
      input.deadlineAt ?? null,
      input.maxFiles ?? null,
      input.maxFileBytes ?? null,
      input.requireName ? 1 : 0,
      input.password ? await hashPassword(input.password) : null,
      now,
    )
    .run();
  return toDto(ctx, (await rowOf(ctx, id))!);
}

async function rowOf(ctx: Ctx, id: string): Promise<RequestRow | null> {
  return db(ctx).prepare('SELECT * FROM file_requests WHERE id = ?1').bind(id).first<RequestRow>();
}

/** The person's own links, a folder's or all, newest first. */
export async function listRequests(
  ctx: Ctx,
  userId: string,
  folderId?: string,
): Promise<RequestDto[]> {
  if (!grantsDb(ctx.env)) return [];
  const { results } = await db(ctx)
    .prepare(
      `SELECT * FROM file_requests WHERE created_by = ?1 AND (?2 IS NULL OR folder_id = ?2)
       ORDER BY created_at DESC LIMIT 200`,
    )
    .bind(userId, folderId ?? null)
    .all<RequestRow>();
  return Promise.all(results.map((r) => toDto(ctx, r)));
}

export async function revokeRequest(ctx: Ctx, userId: string, id: string): Promise<void> {
  const r = await rowOf(ctx, id);
  if (!r || r.created_by !== userId) throw new AppError('NOT_FOUND', 'not found');
  if (r.revoked_at === null)
    await db(ctx)
      .prepare('UPDATE file_requests SET revoked_at = ?2 WHERE id = ?1')
      .bind(id, ctx.now())
      .run();
}

// ───────────────────────────── the uploader's side ─────────────────────────────

/** The link, if its signature is right; anything else is "not found". */
async function publicRow(ctx: Ctx, id: string, sig: string): Promise<RequestRow> {
  if (!grantsDb(ctx.env) || !(await signatureOk(ctx, id, sig)))
    throw new AppError('NOT_FOUND', 'not found');
  const r = await rowOf(ctx, id);
  if (!r) throw new AppError('NOT_FOUND', 'not found');
  return r;
}

export interface PublicRequest {
  title: string;
  message: string | null;
  ownerName: string | null;
  deadlineAt: number | null;
  maxFileBytes: number | null;
  filesLeft: number | null;
  requireName: boolean;
  hasPassword: boolean;
  state: RequestState;
}

/** What the uploader sees: never the folder, its name or its contents. */
export async function publicRequest(ctx: Ctx, id: string, sig: string): Promise<PublicRequest> {
  const r = await publicRow(ctx, id, sig);
  const owner = await ctx.env.DB.prepare(
    `SELECT name FROM users WHERE id = ?1 AND status != 'deleted'`,
  )
    .bind(r.created_by)
    .first<{ name: string }>();
  return {
    title: r.title,
    message: r.message,
    ownerName: owner?.name || null,
    deadlineAt: r.deadline_at,
    maxFileBytes: r.max_file_bytes,
    filesLeft: r.max_files === null ? null : Math.max(0, r.max_files - r.file_count),
    requireName: r.require_name === 1,
    hasPassword: r.password_hash !== null,
    state: await stateOf(ctx, r),
  };
}

const ipHash = (ctx: Ctx, ip: string) => hmacBase62(ctx.env.SHARE_LINK_SECRET, `ip|${ip}`, 32);
const dropToken = (ctx: Ctx, id: string, uploadId: string) =>
  hmacBase62(ctx.env.SHARE_LINK_SECRET, `drop|${id}|${uploadId}`, 32);

export interface DropInput {
  name: string;
  size: number;
  mime?: string | null | undefined;
  lastModified?: number | null | undefined;
  uploaderName?: string | null | undefined;
  /** From openDrops: the password (and the human check) passed for this link. */
  pass: string;
}

const PASS_MS = 60 * 60 * 1000;
const passMac = (ctx: Ctx, id: string, exp: number) =>
  hmacBase62(ctx.env.SHARE_LINK_SECRET, `pass|${id}|${exp}`, 32);

/**
 * The uploader's first step: the link's password, if it has one (the route checks the human test
 * first). Gives a pass for this link for an hour, so each file needn't ask again.
 */
export async function openDrops(
  ctx: Ctx,
  id: string,
  sig: string,
  password: string | null | undefined,
): Promise<{ pass: string; expiresAt: number }> {
  const r = await publicRow(ctx, id, sig);
  const state = await stateOf(ctx, r);
  if (state !== 'open') throw new AppError('GONE', 'this request does not take files', { state });
  if (r.password_hash && !(password && (await verifyPassword(r.password_hash, password))))
    throw new AppError('FORBIDDEN', 'wrong password', { reason: 'PASSWORD' });
  const exp = ctx.now() + PASS_MS;
  return { pass: `${exp}.${await passMac(ctx, r.id, exp)}`, expiresAt: exp };
}

async function passOk(ctx: Ctx, id: string, pass: string): Promise<boolean> {
  const [exp, mac] = pass.split('.');
  const at = Number(exp);
  if (!Number.isSafeInteger(at) || at <= ctx.now() || !mac) return false;
  return timingSafeEqual(await passMac(ctx, id, at), mac);
}

/** Starts one file: a slot of the link, the uploader's subfolder, a multipart upload. */
export async function startDrop(
  ctx: Ctx,
  id: string,
  sig: string,
  input: DropInput,
  ip: string,
): Promise<InitResult & { token: string }> {
  const r = await publicRow(ctx, id, sig);
  const state = await stateOf(ctx, r);
  if (state !== 'open') throw new AppError('GONE', 'this request does not take files', { state });
  if (!(await passOk(ctx, r.id, input.pass)))
    throw new AppError('FORBIDDEN', 'open the link again', { reason: 'PASS' });
  const who = input.uploaderName?.trim().slice(0, 100) ?? '';
  if (r.require_name === 1 && !who) throw new AppError('VALIDATION', 'your name is required');
  if (!Number.isSafeInteger(input.size) || input.size < 0)
    throw new AppError('VALIDATION', 'invalid size');
  if (r.max_file_bytes !== null && input.size > r.max_file_bytes)
    throw new AppError('FILE_TOO_LARGE', 'file is larger than this request allows', {
      maxBytes: r.max_file_bytes,
    });
  const A = db(ctx);
  // The slot first, so two uploaders can't both take the last one.
  const took = await A.prepare(
    `UPDATE file_requests SET file_count = file_count + 1
     WHERE id = ?1 AND revoked_at IS NULL AND (max_files IS NULL OR file_count < max_files)`,
  )
    .bind(r.id)
    .run();
  if (!took.meta.changes) throw new AppError('GONE', 'this request is full', { state: 'full' });
  const release = () =>
    A.prepare('UPDATE file_requests SET file_count = MAX(0, file_count - 1) WHERE id = ?1')
      .bind(r.id)
      .run();
  let started: InitResult;
  try {
    const folder = await createFolder(
      ctx,
      r.created_by,
      r.folder_id,
      safeFolderName(who, ctx.now()),
      'reuse',
    );
    started = await initUpload(ctx, r.created_by, {
      parentId: folder.id,
      name: input.name,
      size: input.size,
      mime: input.mime,
      lastModified: input.lastModified,
      onConflict: 'rename',
    });
  } catch (e) {
    await release();
    throw e;
  }
  await A.prepare(
    `INSERT INTO file_request_drops (upload_id, request_id, uploader_name, ip_hash, size, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6)`,
  )
    .bind(started.uploadId, r.id, who || null, await ipHash(ctx, ip), input.size, ctx.now())
    .run();
  return { ...started, token: await dropToken(ctx, r.id, started.uploadId) };
}

/** The uploader's own subfolder: their cleaned name, or "Tanpa nama" with the day. */
function safeFolderName(who: string, now: number): string {
  try {
    if (who) return sanitizeName(who).slice(0, 100);
  } catch {
    // Nothing usable left in the name.
  }
  return `Tanpa nama ${new Date(now + 7 * 3600_000).toISOString().slice(0, 10)}`;
}

/** An upload of this link, reached with its token: the uploader can touch nothing else. */
async function requireDrop(
  ctx: Ctx,
  id: string,
  sig: string,
  uploadId: string,
  token: string | undefined,
): Promise<{ r: RequestRow; drop: DropRow }> {
  const r = await publicRow(ctx, id, sig);
  if (!token || !timingSafeEqual(await dropToken(ctx, r.id, uploadId), token))
    throw new AppError('NOT_FOUND', 'upload not found');
  const drop = await db(ctx)
    .prepare('SELECT * FROM file_request_drops WHERE upload_id = ?1 AND request_id = ?2')
    .bind(uploadId, r.id)
    .first<DropRow>();
  if (!drop) throw new AppError('NOT_FOUND', 'upload not found');
  return { r, drop };
}

export async function dropPart(
  ctx: Ctx,
  id: string,
  sig: string,
  uploadId: string,
  token: string | undefined,
  partNumber: number,
  contentLength: number | null,
  body: ReadableStream | null,
) {
  const { r, drop } = await requireDrop(ctx, id, sig, uploadId, token);
  if (drop.status !== 'active') throw new AppError('UPLOAD_STATE', `upload is ${drop.status}`);
  if (r.revoked_at !== null) throw new AppError('GONE', 'this request does not take files');
  return uploadPart(ctx, r.created_by, uploadId, partNumber, contentLength, body);
}

/** Done: the file goes through the usual scan; the uploader learns only its name and size. */
export async function finishDrop(
  ctx: Ctx,
  id: string,
  sig: string,
  uploadId: string,
  token: string | undefined,
): Promise<{ name: string; size: number }> {
  const { r, drop } = await requireDrop(ctx, id, sig, uploadId, token);
  if (drop.status === 'aborted') throw new AppError('UPLOAD_STATE', 'upload is aborted');
  const node: NodeDto = await completeUpload(ctx, r.created_by, uploadId);
  if (drop.status === 'active') {
    const A = db(ctx);
    await A.batch([
      A.prepare(
        `UPDATE file_request_drops SET status = 'done', node_id = ?2 WHERE upload_id = ?1 AND status = 'active'`,
      ).bind(uploadId, node.id),
      A.prepare('UPDATE file_requests SET pending_notice = pending_notice + 1 WHERE id = ?1').bind(
        r.id,
      ),
    ]);
  }
  return { name: node.name, size: node.size };
}

export async function cancelDrop(
  ctx: Ctx,
  id: string,
  sig: string,
  uploadId: string,
  token: string | undefined,
): Promise<void> {
  const { r, drop } = await requireDrop(ctx, id, sig, uploadId, token);
  if (drop.status !== 'active') return;
  await abortUpload(ctx, r.created_by, uploadId);
  const A = db(ctx);
  await A.batch([
    A.prepare(`UPDATE file_request_drops SET status = 'aborted' WHERE upload_id = ?1`).bind(
      uploadId,
    ),
    A.prepare('UPDATE file_requests SET file_count = MAX(0, file_count - 1) WHERE id = ?1').bind(
      r.id,
    ),
  ]);
}

// ───────────────────────────── upkeep ─────────────────────────────

/** Hourly: one notice per link that got files since the last one, not one per file. */
export async function noticeRequestFiles(ctx: Ctx, limit = 100): Promise<number> {
  const A = grantsDb(ctx.env);
  if (!A) return 0;
  const { results } = await A.prepare(
    'SELECT id, created_by, folder_id, title, pending_notice FROM file_requests WHERE pending_notice > 0 LIMIT ?1',
  )
    .bind(limit)
    .all<Pick<RequestRow, 'id' | 'created_by' | 'folder_id' | 'title' | 'pending_notice'>>();
  for (const r of results) {
    await A.prepare(
      'UPDATE file_requests SET pending_notice = MAX(0, pending_notice - ?2) WHERE id = ?1',
    )
      .bind(r.id, r.pending_notice)
      .run();
    await notify(ctx, r.created_by, 'file_request_files', {
      title: r.title,
      count: r.pending_notice,
      folderId: r.folder_id,
    });
  }
  return results.length;
}

/** Folders gone for good close their links. */
export async function closeRequestsOfFolders(ctx: Ctx, nodeIds: readonly string[]): Promise<void> {
  const A = grantsDb(ctx.env);
  if (!A) return;
  for (const ids of idSlices(nodeIds))
    await A.prepare(
      `UPDATE file_requests SET revoked_at = ?2
       WHERE revoked_at IS NULL AND folder_id IN (SELECT value FROM json_each(?1))`,
    )
      .bind(ids, ctx.now())
      .run();
}

/** A deleted account: its links and what came through them. */
export async function deleteRequestsOfUser(ctx: Ctx, userId: string): Promise<void> {
  const A = grantsDb(ctx.env);
  if (!A) return;
  await A.batch([
    A.prepare(
      'DELETE FROM file_request_drops WHERE request_id IN (SELECT id FROM file_requests WHERE created_by = ?1)',
    ).bind(userId),
    A.prepare('DELETE FROM file_requests WHERE created_by = ?1').bind(userId),
  ]);
}

/** Data export: the person's links and how many files each got. */
export async function exportRequests(ctx: Ctx, userId: string) {
  const A = grantsDb(ctx.env);
  if (!A) return [];
  const { results } = await A.prepare(
    `SELECT title, message, deadline_at, max_files, max_file_bytes, file_count, revoked_at, created_at
     FROM file_requests WHERE created_by = ?1 ORDER BY created_at`,
  )
    .bind(userId)
    .all();
  return results;
}

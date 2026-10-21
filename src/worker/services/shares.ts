// Share links https://zeiko.biz.id/{r64}/{s32}/{nama} (SPEC §6.1).
// r64 = 64 base62 chars (CSPRNG, primary key); s32 = base62(HMAC-SHA256(SHARE_LINK_SECRET, r64))[:32],
// verified in constant time BEFORE any D1 query. SHARE_LINK_SECRET_PREV keeps old links alive during
// a secret rotation.
import { SHARE_ID_LENGTH, SHARE_SIG_LENGTH, HOUR_MS } from '../../shared/constants';
import type { Ctx } from '../context';
import { base64UrlDecode, base64UrlEncode, hmacBase62, timingSafeEqual } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isBase62, randomBase62 } from '../lib/ids';
import { requireNode } from './access';
import { getActiveSubscription } from './storage';

export interface ShareRow {
  id: string;
  created_by: string;
  kind: 'file' | 'bundle' | 'folder';
  title: string;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  password_hash: string | null;
  revoked_at: number | null;
  disabled_reason: string | null;
  last_download_at: number | null;
  created_at: number;
}

export async function shareSignature(secret: string, r64: string): Promise<string> {
  return hmacBase62(secret, `share|${r64}`, SHARE_SIG_LENGTH);
}

/** Constant-time check against the current and (during rotation) previous secret. */
export async function verifyShareSignature(
  env: { SHARE_LINK_SECRET: string; SHARE_LINK_SECRET_PREV?: string },
  r64: string,
  s32: string,
): Promise<boolean> {
  if (!isBase62(r64, SHARE_ID_LENGTH) || !isBase62(s32, SHARE_SIG_LENGTH)) return false;
  if (timingSafeEqual(s32, await shareSignature(env.SHARE_LINK_SECRET, r64))) return true;
  return Boolean(
    env.SHARE_LINK_SECRET_PREV &&
    timingSafeEqual(s32, await shareSignature(env.SHARE_LINK_SECRET_PREV, r64)),
  );
}

export async function shareUrl(
  env: { APP_ORIGIN: string; SHARE_LINK_SECRET: string },
  r64: string,
  title: string,
): Promise<string> {
  const s32 = await shareSignature(env.SHARE_LINK_SECRET, r64);
  return `${env.APP_ORIGIN}/${r64}/${s32}/${encodeURIComponent(title)}`;
}

// ── passwords (PBKDF2; Workers cap iterations at 100 000) ──
const PBKDF2_ITER = 100_000;

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [algo, iter, salt, hash] = stored.split('$');
  if (algo !== 'pbkdf2' || !iter || !salt || !hash) return false;
  const got = await pbkdf2(password, base64UrlDecode(salt), Number(iter));
  return timingSafeEqual(base64UrlEncode(got), hash);
}

// ── lifecycle ──
export interface CreateShareInput {
  nodeIds: string[];
  title?: string | undefined;
  expiresInHours?: number | null | undefined;
  maxDownloads?: number | null | undefined;
  password?: string | null | undefined;
}

export interface ShareDto {
  id: string;
  url: string;
  kind: ShareRow['kind'];
  title: string;
  expiresAt: number | null;
  maxDownloads: number | null;
  downloadCount: number;
  hasPassword: boolean;
  revokedAt: number | null;
  disabledReason: string | null;
  lastDownloadAt: number | null;
  createdAt: number;
  nodeIds: string[];
}

export async function toShareDto(ctx: Ctx, s: ShareRow): Promise<ShareDto> {
  const { results } = await ctx.env.DB.prepare(
    'SELECT node_id FROM share_items WHERE share_id = ?1',
  )
    .bind(s.id)
    .all<{ node_id: string }>();
  return {
    id: s.id,
    url: await shareUrl(ctx.env, s.id, s.title),
    kind: s.kind,
    title: s.title,
    expiresAt: s.expires_at,
    maxDownloads: s.max_downloads,
    downloadCount: s.download_count,
    hasPassword: Boolean(s.password_hash),
    revokedAt: s.revoked_at,
    disabledReason: s.disabled_reason,
    lastDownloadAt: s.last_download_at,
    createdAt: s.created_at,
    nodeIds: results.map((r) => r.node_id),
  };
}

async function assertCanShare(ctx: Ctx, poolId: string): Promise<void> {
  const sub = await getActiveSubscription(ctx, poolId);
  if (sub && sub.status !== 'active' && sub.status !== 'grace') {
    throw new AppError('READ_ONLY', 'sharing is disabled while the account is read-only', {
      subscriptionStatus: sub.status,
    });
  }
}

export async function createShare(
  ctx: Ctx,
  userId: string,
  input: CreateShareInput,
): Promise<ShareDto> {
  const ids = [...new Set(input.nodeIds)];
  if (!ids.length || ids.length > 100) throw new AppError('VALIDATION', 'between 1 and 100 items');
  const nodes = [];
  for (const id of ids) {
    const { node } = await requireNode(ctx, userId, id, 'view');
    if (node.trashed_at !== null) throw new AppError('CONFLICT', 'item is in the trash');
    if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot share a root folder');
    if (node.kind === 'file') {
      // Only clean (or "not fully scanned") files can be shared (SPEC §6.1).
      const blob = await ctx.env.DB.prepare('SELECT scan_status FROM blobs WHERE id = ?1')
        .bind(node.blob_id)
        .first<{ scan_status: string }>();
      if (node.status !== 'ready' || !blob || !['clean', 'skipped'].includes(blob.scan_status)) {
        throw new AppError('CONFLICT', 'file is not ready to share', { nodeId: node.id });
      }
    }
    nodes.push(node);
  }
  await assertCanShare(ctx, nodes[0]!.pool_id);
  const cfg = await ctx.config();
  const now = ctx.now();
  const kind: ShareRow['kind'] =
    nodes.length > 1 ? 'bundle' : nodes[0]!.kind === 'folder' ? 'folder' : 'file';
  const title = (
    input.title?.trim() || (nodes.length === 1 ? nodes[0]!.name : `${nodes.length} file`)
  ).slice(0, 200);
  const hours =
    input.expiresInHours === undefined ? cfg.share_default_expiry_days * 24 : input.expiresInHours;
  const expiresAt = hours ? now + hours * HOUR_MS : null;
  const id = randomBase62(SHARE_ID_LENGTH);
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO shares (id, created_by, kind, title, expires_at, max_downloads, password_hash, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(id, userId, kind, title, expiresAt, input.maxDownloads ?? null, passwordHash, now),
    ...nodes.map((n) =>
      ctx.env.DB.prepare('INSERT INTO share_items (share_id, node_id) VALUES (?1, ?2)').bind(
        id,
        n.id,
      ),
    ),
  ]);
  return toShareDto(ctx, (await getShareRow(ctx, id))!);
}

export async function getShareRow(ctx: Ctx, id: string): Promise<ShareRow | null> {
  return ctx.env.DB.prepare('SELECT * FROM shares WHERE id = ?1').bind(id).first<ShareRow>();
}

export async function requireOwnShare(ctx: Ctx, userId: string, id: string): Promise<ShareRow> {
  const s = await getShareRow(ctx, id);
  if (!s || s.created_by !== userId) throw new AppError('NOT_FOUND', 'share not found');
  return s;
}

export async function listMyShares(ctx: Ctx, userId: string, nodeId?: string): Promise<ShareDto[]> {
  const { results } = nodeId
    ? await ctx.env.DB.prepare(
        `SELECT s.* FROM shares s JOIN share_items i ON i.share_id = s.id
         WHERE s.created_by = ?1 AND i.node_id = ?2 ORDER BY s.created_at DESC LIMIT 50`,
      )
        .bind(userId, nodeId)
        .all<ShareRow>()
    : await ctx.env.DB.prepare(
        'SELECT * FROM shares WHERE created_by = ?1 ORDER BY created_at DESC LIMIT 500',
      )
        .bind(userId)
        .all<ShareRow>();
  return Promise.all(results.map((s) => toShareDto(ctx, s)));
}

export async function updateShare(
  ctx: Ctx,
  userId: string,
  id: string,
  patch: {
    expiresInHours?: number | null;
    maxDownloads?: number | null;
    password?: string | null;
    title?: string;
  },
): Promise<ShareDto> {
  const s = await requireOwnShare(ctx, userId, id);
  const sets: string[] = [];
  const binds: unknown[] = [id];
  const set = (col: string, v: unknown) => {
    binds.push(v);
    sets.push(`${col} = ?${binds.length}`);
  };
  if (patch.expiresInHours !== undefined)
    set('expires_at', patch.expiresInHours ? ctx.now() + patch.expiresInHours * HOUR_MS : null);
  if (patch.maxDownloads !== undefined) set('max_downloads', patch.maxDownloads);
  if (patch.password !== undefined)
    set('password_hash', patch.password ? await hashPassword(patch.password) : null);
  if (patch.title !== undefined) set('title', patch.title.trim().slice(0, 200) || s.title);
  if (sets.length)
    await ctx.env.DB.prepare(`UPDATE shares SET ${sets.join(', ')} WHERE id = ?1`)
      .bind(...binds)
      .run();
  return toShareDto(ctx, (await getShareRow(ctx, id))!);
}

export async function revokeShare(ctx: Ctx, userId: string, id: string): Promise<void> {
  await requireOwnShare(ctx, userId, id);
  await ctx.env.DB.prepare('UPDATE shares SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL')
    .bind(id, ctx.now())
    .run();
}

/** "Buat ulang link": new r64 with the same items and settings; the old link dies. */
export async function regenerateShare(ctx: Ctx, userId: string, id: string): Promise<ShareDto> {
  const s = await requireOwnShare(ctx, userId, id);
  const newId = randomBase62(SHARE_ID_LENGTH);
  const now = ctx.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO shares (id, created_by, kind, title, expires_at, max_downloads, password_hash, created_at)
       SELECT ?2, created_by, kind, title, expires_at, max_downloads, password_hash, ?3 FROM shares WHERE id = ?1`,
    ).bind(id, newId, now),
    ctx.env.DB.prepare(
      'INSERT INTO share_items (share_id, node_id) SELECT ?2, node_id FROM share_items WHERE share_id = ?1',
    ).bind(id, newId),
    ctx.env.DB.prepare('UPDATE shares SET revoked_at = ?2 WHERE id = ?1').bind(id, now),
  ]);
  void s;
  return toShareDto(ctx, (await getShareRow(ctx, newId))!);
}

export type DeadReason = 'not_found' | 'revoked' | 'expired' | 'limit' | 'disabled';

/** Why a share can't be used right now (null = usable). */
export async function shareState(ctx: Ctx, s: ShareRow | null): Promise<DeadReason | null> {
  if (!s) return 'not_found';
  if (s.revoked_at !== null) return 'revoked';
  if (s.disabled_reason) return 'disabled';
  if (s.expires_at !== null && s.expires_at <= ctx.now()) return 'expired';
  if (s.max_downloads !== null && s.download_count >= s.max_downloads) return 'limit';
  // Owner in read-only/suspended phase → links off (SPEC §6.1, §12.5).
  const pool = await ctx.env.DB.prepare(
    `SELECT n.pool_id FROM share_items i JOIN nodes n ON n.id = i.node_id WHERE i.share_id = ?1 LIMIT 1`,
  )
    .bind(s.id)
    .first<{ pool_id: string }>();
  if (!pool) return 'not_found';
  const sub = await getActiveSubscription(ctx, pool.pool_id);
  if (!sub || (sub.status !== 'active' && sub.status !== 'grace')) return 'disabled';
  return null;
}

/**
 * Counts a download once per (IP+UA) per window (SPEC §6.1). Returns false when the download limit
 * has been reached.
 */
export async function countDownload(ctx: Ctx, s: ShareRow, fingerprint: string): Promise<boolean> {
  const cfg = await ctx.config();
  const key = `sd:${s.id.slice(0, 24)}:${fingerprint}`;
  if (await ctx.env.CONFIG_KV.get(key)) return true;
  const res = await ctx.env.DB.prepare(
    `UPDATE shares SET download_count = download_count + 1, last_download_at = ?2
     WHERE id = ?1 AND (max_downloads IS NULL OR download_count < max_downloads)`,
  )
    .bind(s.id, ctx.now())
    .run();
  if (res.meta.changes === 0) return false;
  await ctx.env.CONFIG_KV.put(key, '1', {
    expirationTtl: Math.max(60, cfg.share_download_dedupe_minutes * 60),
  });
  return true;
}

/** Disables every link that contains one of these nodes (abuse takedown, SPEC §14.3). */
export async function disableSharesForNode(
  ctx: Ctx,
  nodeId: string,
  reason: string,
): Promise<void> {
  await ctx.env.DB.prepare(
    `UPDATE shares SET disabled_reason = ?2 WHERE id IN (SELECT share_id FROM share_items WHERE node_id = ?1)`,
  )
    .bind(nodeId, reason)
    .run();
}

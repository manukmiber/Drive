// R3 (ADR-074): every change to a personal Drive tree is written to the user's index
// (`u/{userId}/index.txt`, format in shared/drive-index.ts). Until R2 moves reads over, D1 is still
// what the app reads, so the index is written as a projection of the user's tree in D1:
//
// 1. A change marks its user in `manifest_dirty` (dirty_at > 0) once its D1 batch has committed, and
//    asks for a flush after the response (ctx.defer).
// 2. A flush waits a moment for more changes, then claims the mark (dirty_at = -claim time): of the
//    flushes asked for during a burst only one goes ahead, so a wave of uploads, a scan batch, or a
//    bulk move is one index write. A change during a flush marks the user again, and its own flush
//    follows.
// 3. The flush reads the index, reads the tree from D1, and writes the difference with R2's etag
//    condition (changeIndex). The tree is read inside every attempt, after the index, so a write
//    that lost a race never puts back an older tree.
// 4. The hourly cron flushes what a lost request left marked, and claims older than five minutes.
//
// Index entries carry their D1 id (`x`) so the entry numbers stay put from one flush to the next.
// Family trees are R4: their changes don't touch these indexes.
import { entryLine, type IndexEntry } from '../../shared/drive-index';
import type { Ctx } from '../context';
import { log } from '../lib/log';
import { changeIndex, indexKey, type IndexDoc } from './drive-index';

/** A claim older than this belongs to a flush that died; the next one takes it over. */
const STALE_CLAIM_MS = 5 * 60_000;
const DEFAULT_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function flushDelay(ctx: Ctx): number {
  const v = Number(ctx.env.INDEX_FLUSH_DELAY_MS ?? DEFAULT_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DELAY_MS;
}

/** The statement that marks a user's index as behind D1 (for callers that batch it with a change). */
export function markIndexStmt(ctx: Ctx, userId: string): D1PreparedStatement {
  return ctx.env.DB.prepare(
    `INSERT INTO manifest_dirty (user_id, dirty_at) VALUES (?1, ?2)
     ON CONFLICT (user_id) DO UPDATE SET dirty_at = excluded.dirty_at`,
  ).bind(userId, Math.max(1, ctx.now()));
}

/** Marks these users' indexes as behind D1 and asks for a flush once the request is done. */
export async function markIndexDirty(ctx: Ctx, userIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await ctx.env.DB.batch(ids.map((id) => markIndexStmt(ctx, id)));
  for (const id of ids) scheduleIndexFlush(ctx, id);
}

/** Marks the owners of personal files that use these blobs (scan results, thumbnails, takedowns). */
export async function markBlobOwnersDirty(ctx: Ctx, blobIds: string[]): Promise<void> {
  if (!blobIds.length) return;
  const { results } = await ctx.env.DB.prepare(
    `SELECT DISTINCT owner_id FROM nodes
     WHERE space = 'personal' AND blob_id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(blobIds))
    .all<{ owner_id: string }>();
  await markIndexDirty(
    ctx,
    results.map((r) => r.owner_id),
  );
}

// Flushes asked for in this isolate that have not claimed yet, per database (tests run many).
const waiting = new WeakMap<object, Set<string>>();

/** One flush per user per isolate at a time; later changes ride along until it claims. */
export function scheduleIndexFlush(ctx: Ctx, userId: string): void {
  let users = waiting.get(ctx.env.DB);
  if (!users) waiting.set(ctx.env.DB, (users = new Set()));
  if (users.has(userId)) return;
  users.add(userId);
  const pending = users;
  ctx.defer(
    (async () => {
      try {
        await sleep(flushDelay(ctx));
      } finally {
        pending.delete(userId);
      }
      await flushUserIndex(ctx, userId);
    })(),
  );
}

export type FlushResult = 'written' | 'unchanged' | 'skipped';

/**
 * Claims the user's mark and writes their index from D1. 'skipped': nothing was marked, or another
 * flush holds a fresh claim (it will see everything that marked before it read).
 */
export async function flushUserIndex(ctx: Ctx, userId: string): Promise<FlushResult> {
  const DB = ctx.env.DB;
  const now = Math.max(1, ctx.now());
  const claim = -now;
  const claimed = await DB.prepare(
    `UPDATE manifest_dirty SET dirty_at = ?2 WHERE user_id = ?1 AND dirty_at > ?3 RETURNING user_id`,
  )
    .bind(userId, claim, -(now - STALE_CLAIM_MS))
    .first();
  if (!claimed) return 'skipped';
  try {
    const written = await writeUserIndex(ctx, userId);
    // A change during the flush marked again (dirty_at > 0): the row stays for its own flush.
    await DB.prepare('DELETE FROM manifest_dirty WHERE user_id = ?1 AND dirty_at = ?2')
      .bind(userId, claim)
      .run();
    return written ? 'written' : 'unchanged';
  } catch (e) {
    // Hand the mark back to the next flush or the hourly cron.
    await DB.prepare('UPDATE manifest_dirty SET dirty_at = ?3 WHERE user_id = ?1 AND dirty_at = ?2')
      .bind(userId, claim, Math.max(1, ctx.now()))
      .run()
      .catch(() => undefined);
    throw e;
  }
}

/** The hourly backstop: indexes left marked by a request that lost its flush. */
export async function flushDirtyIndexes(
  ctx: Ctx,
): Promise<{ written: number; unchanged: number; failed: number }> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const { results } = await ctx.env.DB.prepare(
    `SELECT user_id FROM manifest_dirty WHERE dirty_at > ?1 ORDER BY abs(dirty_at) LIMIT ?2`,
  )
    .bind(-(now - STALE_CLAIM_MS), cfg.drive_index_flush_per_run)
    .all<{ user_id: string }>();
  const out = { written: 0, unchanged: 0, failed: 0 };
  for (const { user_id } of results) {
    try {
      const r = await flushUserIndex(ctx, user_id);
      if (r === 'written') out.written++;
      else if (r === 'unchanged') out.unchanged++;
    } catch (e) {
      out.failed++;
      log.warn('drive_index_flush_failed', { userId: user_id, message: String(e) });
    }
  }
  return out;
}

/** Account deletion: the index goes with the files. */
export async function deleteUserIndex(ctx: Ctx, userId: string): Promise<void> {
  await ctx.env.BUCKET.delete(indexKey({ user: userId }));
}

interface TreeRow {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  size: number;
  mime: string | null;
  status: string;
  trashed_at: number | null;
  trash_root_id: string | null;
  client_modified_at: number | null;
  created_at: number;
  updated_at: number;
  decor_color: string | null;
  decor_icon: string | null;
  decor_cover_id: string | null;
  r2_key: string | null;
  thumb_key: string | null;
  scan_status: string | null;
  starred: number;
}

async function readTree(ctx: Ctx, userId: string): Promise<{ rows: TreeRow[]; used: number }> {
  const DB = ctx.env.DB;
  const [pool, tree] = await DB.batch([
    DB.prepare(
      `SELECT used_bytes FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?1`,
    ).bind(userId),
    // Uploads still running aren't in the tree yet.
    DB.prepare(
      `SELECT n.id, n.parent_id, n.kind, n.name, n.size, n.mime, n.status, n.trashed_at,
              n.trash_root_id, n.client_modified_at, n.created_at, n.updated_at,
              n.decor_color, n.decor_icon, n.decor_cover_id,
              b.r2_key, b.thumb_key, b.scan_status,
              EXISTS (SELECT 1 FROM node_stars s WHERE s.node_id = n.id AND s.user_id = ?1) AS starred
       FROM nodes n LEFT JOIN blobs b ON b.id = n.blob_id
       WHERE n.owner_id = ?1 AND n.space = 'personal' AND n.status != 'uploading'
       ORDER BY n.rid`,
    ).bind(userId),
  ]);
  return {
    rows: tree!.results as unknown as TreeRow[],
    used: (pool!.results[0] as { used_bytes: number } | undefined)?.used_bytes ?? 0,
  };
}

/** Writes the user's index from D1; true when anything in it changed. */
export async function writeUserIndex(ctx: Ctx, userId: string): Promise<boolean> {
  const user = await ctx.env.DB.prepare('SELECT status FROM users WHERE id = ?1')
    .bind(userId)
    .first<{ status: string }>();
  if (!user || user.status === 'deleted') {
    // A deleted account keeps no index.
    await deleteUserIndex(ctx, userId);
    return false;
  }
  return changeIndex(ctx.env.BUCKET, { user: userId }, async (doc) => {
    const tree = await readTree(ctx, userId);
    project(doc, tree.rows, tree.used);
    return doc.changed;
  });
}

/** Makes `doc` hold exactly the tree in `rows`, keeping the entry number of every node it had. */
export function project(doc: IndexDoc, rows: TreeRow[], used: number): void {
  const root = rows.find((r) => r.parent_id === null);
  doc.setMeta('root', root?.id);
  doc.setMeta('used', used);

  const had = new Map<string, IndexEntry>();
  for (const e of doc.entries()) if (e.legacy) had.set(e.legacy, e);

  const ids = new Map<string, number>();
  for (const r of rows) if (r !== root) ids.set(r.id, had.get(r.id)?.id ?? doc.allocate());
  const entryOf = (id: string | null) => (id ? (ids.get(id) ?? 0) : 0);

  for (const r of rows) {
    if (r === root) continue;
    const parent = r.parent_id === root?.id ? 0 : ids.get(r.parent_id!);
    if (parent === undefined) continue;
    const folder = r.kind === 'folder';
    const blocked =
      r.status === 'rejected' || r.scan_status === 'infected' || r.scan_status === 'quarantined';
    const entry: IndexEntry = {
      id: ids.get(r.id)!,
      parent,
      kind: folder ? 'folder' : 'file',
      name: r.name,
      size: r.size,
      mime: r.mime ?? '',
      blob: folder ? 0 : (r.r2_key ?? 0),
      legacy: r.id,
      status: blocked ? 'blocked' : r.status === 'scanning' ? 'scanning' : 'ready',
      created: r.created_at,
      updated: r.updated_at,
      clientModified: r.client_modified_at,
      thumb: Boolean(r.thumb_key),
      starred: Boolean(r.starred),
      trashedAt: r.trashed_at,
      trashRoot: entryOf(r.trash_root_id),
      decor:
        folder && (r.decor_color || r.decor_icon || r.decor_cover_id)
          ? { color: r.decor_color, icon: r.decor_icon, cover: entryOf(r.decor_cover_id) }
          : null,
      owner: 0,
      canEdit: false,
      trashedBy: 0,
    };
    const before = had.get(r.id);
    if (!before || entryLine(before) !== entryLine(entry)) doc.set(entry);
  }
  for (const [legacy, e] of had) if (!ids.has(legacy)) doc.delete(e.id);
}

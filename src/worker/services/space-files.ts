// W1e (ADR-099): a Space's files. They hang from one folder per Space in the main database, with
// `nodes.space = 'team'` (a new value of an existing column, not a new table: ADR-064), owned by the
// team's owner and counted on the owner's own storage until team plans are sold (T6, owner's
// answer: "kuota pemilik tim dulu"). Which folder belongs to which Space is in the access database
// (`spaces.root_node`), and who may do what follows the person's role in that Space.
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { nameKey } from '../lib/names';
import type { Access, NodeRecord } from './access';
import { USED_SQL } from './versions-sql';

const NONE: Access = { view: false, edit: false, remove: false, add: false, isOwner: false };

/** SQL fragment: `sub(id)` = the node ?{p} and everything under it. */
const subtree = (p: number) =>
  `WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id = ?${p}
     UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)`;

/** The folder at the top of the tree a node is in (itself, for a top folder). */
export async function topOf(ctx: Ctx, node: Pick<NodeRecord, 'id' | 'parent_id'>): Promise<string> {
  if (node.parent_id === null) return node.id;
  const r = await ctx.env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id) AS (
       SELECT id, parent_id FROM nodes WHERE id = ?1
       UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN up ON n.id = up.parent_id)
     SELECT id FROM up WHERE parent_id IS NULL LIMIT 1`,
  )
    .bind(node.parent_id)
    .first<{ id: string }>();
  return r?.id ?? node.id;
}

export interface SpaceAt {
  spaceId: string;
  role: 'admin' | 'member' | 'guest';
  status: 'active' | 'readonly' | 'frozen';
}

type RoleOf = (ctx: Ctx, userId: string, spaceId: string) => Promise<SpaceAt | null>;

const seen = new WeakMap<Ctx, Map<string, Promise<SpaceAt | null>>>();

/** The Space a top folder belongs to and the person's place in it, once per request. */
export function spaceAt(
  ctx: Ctx,
  userId: string,
  rootId: string,
  roleOf: RoleOf,
): Promise<SpaceAt | null> {
  let m = seen.get(ctx);
  if (!m) seen.set(ctx, (m = new Map()));
  const key = `${userId}:${rootId}`;
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const A = ctx.env.ACCESS_DB;
      if (!A) return null;
      const s = await A.prepare('SELECT id FROM spaces WHERE root_node = ?1')
        .bind(rootId)
        .first<{ id: string }>();
      return s ? roleOf(ctx, userId, s.id) : null;
    })();
    m.set(key, p);
  }
  return p;
}

/**
 * What a person may do with an item of a Space. Admins: everything. Members: see, add and change
 * everything (a team works on the same files), and remove what they made. Guests: nothing yet —
 * which folders a guest sees is a later piece. A read-only team is seen, not changed; a frozen one
 * is closed.
 */
export async function teamAccess(
  ctx: Ctx,
  userId: string,
  node: NodeRecord,
  roleOf: RoleOf,
): Promise<Access> {
  const at = await spaceAt(ctx, userId, await topOf(ctx, node), roleOf);
  if (!at || at.role === 'guest' || at.status === 'frozen') return NONE;
  if (at.status === 'readonly')
    return { view: true, edit: false, remove: false, add: false, isOwner: false };
  const top = node.parent_id === null;
  if (at.role === 'admin')
    return { view: true, edit: !top, remove: !top, add: true, isOwner: node.owner_id === userId };
  return {
    view: true,
    edit: !top,
    remove: !top && node.created_by === userId,
    add: true,
    isOwner: false,
  };
}

/** The owner's own storage pool: where a Space's files are counted for now (T6). */
async function personalPool(ctx: Ctx, userId: string): Promise<string> {
  const p = await ctx.env.DB.prepare(
    `SELECT id FROM storage_pools WHERE owner_type = 'user' AND owner_id = ?1`,
  )
    .bind(userId)
    .first<{ id: string }>();
  if (!p)
    throw new AppError('CONFLICT', 'the team owner has no storage yet', { reason: 'no_pool' });
  return p.id;
}

/** The Space's top folder, made the first time its files are opened. */
export async function ensureSpaceRoot(
  ctx: Ctx,
  space: { id: string; name: string; root_node: string | null },
  ownerId: string,
  userId: string,
): Promise<string> {
  const DB = ctx.env.DB;
  const A = ctx.env.ACCESS_DB!;
  if (space.root_node) {
    const n = await DB.prepare(`SELECT id FROM nodes WHERE id = ?1 AND space = 'team'`)
      .bind(space.root_node)
      .first<{ id: string }>();
    if (n) return n.id;
  }
  const now = ctx.now();
  const id = ulid(now);
  await DB.prepare(
    `INSERT INTO nodes (id, pool_id, space, owner_id, created_by, parent_id, kind, name, name_key,
       created_at, updated_at)
     VALUES (?1, ?2, 'team', ?3, ?4, NULL, 'folder', ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      await personalPool(ctx, ownerId),
      ownerId,
      userId,
      space.name,
      nameKey(space.name),
      now,
    )
    .run();
  // Two people opening it at once: the first folder written wins, the other goes.
  const won = await A.prepare(
    `UPDATE spaces SET root_node = ?2 WHERE id = ?1 AND (root_node IS NULL OR root_node = ?3)`,
  )
    .bind(space.id, id, space.root_node ?? '')
    .run();
  if (won.meta.changes) return id;
  await DB.prepare('DELETE FROM nodes WHERE id = ?1').bind(id).run();
  const row = await A.prepare('SELECT root_node FROM spaces WHERE id = ?1')
    .bind(space.id)
    .first<{ root_node: string | null }>();
  if (!row?.root_node) throw new AppError('NOT_FOUND', 'not found');
  return row.root_node;
}

/** The Space's name is its top folder's name too (the path above its files shows it). */
export async function renameSpaceRoot(ctx: Ctx, rootId: string | null, name: string) {
  if (!rootId) return;
  await ctx.env.DB.prepare(
    `UPDATE nodes SET name = ?2, name_key = ?3, updated_at = ?4 WHERE id = ?1 AND space = 'team'`,
  )
    .bind(rootId, name, nameKey(name), ctx.now())
    .run();
}

/**
 * A Space went: its files go to the trash already due, without anyone's name on them (so they show
 * in nobody's Trash), and the hourly purge deletes them and frees the owner's storage.
 */
export async function dropSpaceFiles(ctx: Ctx, rootIds: readonly (string | null)[]) {
  const now = ctx.now();
  for (const id of rootIds) {
    if (!id) continue;
    await ctx.env.DB.prepare(
      `${subtree(1)}
       UPDATE nodes SET trashed_at = ?2, trashed_by = NULL, trash_root_id = ?1, purge_at = ?2, updated_at = ?2
       WHERE id IN (SELECT id FROM sub) AND space = 'team'`,
    )
      .bind(id, now)
      .run();
  }
}

/**
 * The team changed hands: its Spaces' files are now the new owner's, on the new owner's storage.
 * Content shared with an item outside (a copy into someone's own Drive) keeps its old pool label;
 * what counts is each item's own pool. Both pools' totals are counted again.
 */
export async function moveSpaceFiles(
  ctx: Ctx,
  rootIds: readonly (string | null)[],
  from: string,
  to: string,
): Promise<void> {
  const roots = rootIds.filter((r): r is string => Boolean(r));
  if (!roots.length) return;
  const DB = ctx.env.DB;
  const [oldPool, newPool] = await Promise.all([personalPool(ctx, from), personalPool(ctx, to)]);
  const now = ctx.now();
  for (const root of roots)
    await DB.batch([
      DB.prepare(
        `${subtree(1)}
         UPDATE blobs SET pool_id = ?2
         WHERE id IN (SELECT blob_id FROM nodes WHERE id IN (SELECT id FROM sub) AND blob_id IS NOT NULL)
           AND NOT EXISTS (SELECT 1 FROM nodes o WHERE o.blob_id = blobs.id
             AND o.id NOT IN (SELECT id FROM sub))`,
      ).bind(root, newPool),
      DB.prepare(
        `${subtree(1)} UPDATE nodes SET pool_id = ?2, owner_id = ?3, updated_at = ?4
         WHERE id IN (SELECT id FROM sub) AND space = 'team'`,
      ).bind(root, newPool, to, now),
    ]);
  await DB.prepare(
    `UPDATE storage_pools SET
       used_bytes = (SELECT COALESCE(SUM(size), 0) FROM nodes n WHERE n.pool_id = storage_pools.id AND ${USED_SQL}),
       reserved_bytes = (SELECT COALESCE(SUM(size), 0) FROM nodes n WHERE n.pool_id = storage_pools.id
         AND n.kind = 'file' AND n.status IN ('uploading', 'scanning')),
       updated_at = ?3
     WHERE id IN (?1, ?2)`,
  )
    .bind(oldPool, newPool, now)
    .run();
}

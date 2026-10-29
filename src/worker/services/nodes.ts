// File tree operations (SPEC §8.3). Everything is a D1 update — R2 objects are never copied or
// renamed (opaque keys, SPEC §3). Bulk operations work on subtrees via recursive CTEs (ADR-020).
import { DAY_MS } from '../../shared/constants';
import { markIndexDirty } from './drive-index-sync';
import { isFolderColor, isFolderIcon, type FolderDecor } from '../../shared/folder-decor';
import {
  decodeCursor as decodeSharedCursor,
  encodeCursor,
  type DriveCrumb,
  type DriveNode,
} from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { nameKey, nameWithSuffix, sanitizeName } from '../lib/names';
import { loadNode, nodeAccess, requireNode, type NodeRecord } from './access';
import { addUsedIfFits, quotaFullError } from './quota';

/** A file or folder as the app and the API see it (shared with the index reads, ADR-077). */
export type NodeDto = DriveNode;

type Row = NodeRecord & {
  scan_status?: string | null;
  starred?: number | null;
  thumb_key?: string | null;
  cover_id?: string | null;
};

/**
 * A folder's cover, only when whoever may see the folder may see the image too (ADR-058): a ready
 * file in the same space (the same family, or the same owner's personal space), not in the trash,
 * with a thumbnail and not held back by the scanner. Otherwise null, and the folder shows its icon
 * and colour. Access in a space is all or nothing (`access.ts`), so "same space" is "may see".
 */
export const COVER_SQL = `(SELECT c.id FROM nodes c JOIN blobs cb ON cb.id = c.blob_id
  WHERE c.id = n.decor_cover_id AND c.kind = 'file' AND c.status = 'ready' AND c.trashed_at IS NULL
    AND c.space = n.space
    AND ((c.space = 'family' AND c.family_id = n.family_id) OR (c.space = 'personal' AND c.owner_id = n.owner_id))
    AND cb.thumb_key IS NOT NULL AND cb.scan_status NOT IN ('infected', 'quarantined')) AS cover_id`;

function decorOf(r: Row): FolderDecor | null {
  if (r.kind !== 'folder') return null;
  const color = r.decor_color && isFolderColor(r.decor_color) ? r.decor_color : null;
  const icon = r.decor_icon && isFolderIcon(r.decor_icon) ? r.decor_icon : null;
  const coverId = r.cover_id ?? null;
  return color || icon || coverId ? { color, icon, coverId } : null;
}

export function toDto(r: Row): NodeDto {
  return {
    id: r.id,
    parentId: r.parent_id,
    kind: r.kind,
    name: r.name,
    size: r.size,
    mime: r.mime,
    status: r.status,
    scanStatus: r.scan_status ?? null,
    space: r.space,
    ownerId: r.owner_id,
    createdBy: r.created_by,
    familyCanEdit: r.family_can_edit === 1,
    starred: Boolean(r.starred),
    hasThumb: Boolean(r.thumb_key),
    trashedAt: r.trashed_at,
    purgeAt: r.purge_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    clientModifiedAt: r.client_modified_at,
    decor: decorOf(r),
  };
}

const SELECT_DTO = `SELECT n.*, b.scan_status, b.thumb_key, ${COVER_SQL},
  (SELECT 1 FROM node_stars s WHERE s.node_id = n.id AND s.user_id = ?1) AS starred
  FROM nodes n LEFT JOIN blobs b ON b.id = n.blob_id`;

export async function getNodeDto(ctx: Ctx, userId: string, id: string): Promise<NodeDto> {
  const row = await ctx.env.DB.prepare(`${SELECT_DTO} WHERE n.id = ?2`)
    .bind(userId, id)
    .first<Row>();
  if (!row) throw new AppError('NOT_FOUND', 'node not found');
  return toDto(row);
}

/** SQL fragment: `sub(id)` = the node ?{p} and all of its descendants. */
const subtree = (p: number) =>
  `WITH RECURSIVE sub(id) AS (SELECT id FROM nodes WHERE id = ?${p}
     UNION ALL SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id)`;

// ───────────────────────────── names ─────────────────────────────

/** First free name in `parentId` ("nama (1).ext", …), ignoring trashed siblings. */
export async function uniqueName(
  ctx: Ctx,
  parentId: string,
  desired: string,
  excludeId?: string,
): Promise<string> {
  for (let start = 0; start < 1000; start += 50) {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      start + i === 0 ? desired : nameWithSuffix(desired, start + i),
    );
    const placeholders = candidates.map((_, i) => `?${i + 3}`).join(', ');
    const { results } = await ctx.env.DB.prepare(
      `SELECT name_key FROM nodes WHERE parent_id = ?1 AND trashed_at IS NULL AND id != ?2
       AND name_key IN (${placeholders})`,
    )
      .bind(parentId, excludeId ?? '', ...candidates.map(nameKey))
      .all<{ name_key: string }>();
    const taken = new Set(results.map((r) => r.name_key));
    const free = candidates.find((c) => !taken.has(nameKey(c)));
    if (free) return free;
  }
  throw new AppError('NAME_CONFLICT', 'no free name');
}

export async function siblingByName(
  ctx: Ctx,
  parentId: string,
  name: string,
): Promise<NodeRecord | null> {
  return ctx.env.DB.prepare(
    'SELECT * FROM nodes WHERE parent_id = ?1 AND name_key = ?2 AND trashed_at IS NULL',
  )
    .bind(parentId, nameKey(name))
    .first<NodeRecord>();
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/.test(e.message);
}

// ───────────────────────────── reads ─────────────────────────────

export type SortKey = 'name' | 'updated' | 'size' | 'type';
const SORT_EXPR: Record<SortKey, string> = {
  name: 'n.name_key',
  updated: 'n.updated_at',
  size: 'n.size',
  type: "COALESCE(n.mime, '')",
};

export interface ListOptions {
  sort?: SortKey;
  dir?: 'asc' | 'desc';
  cursor?: string | null;
  limit?: number;
}

function decodeCursor(c: string): [number, string | number, string] {
  try {
    return decodeSharedCursor(c);
  } catch {
    throw new AppError('BAD_REQUEST', 'invalid cursor');
  }
}

/** Folder listing, folders first, keyset-paginated (SPEC §8.2: 100 items/page). */
export async function listChildren(
  ctx: Ctx,
  userId: string,
  folderId: string,
  opts: ListOptions = {},
): Promise<{ folder: NodeDto; items: NodeDto[]; nextCursor: string | null }> {
  const { node } = await requireNode(ctx, userId, folderId);
  if (node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'not a folder');
  const sort = opts.sort ?? 'name';
  const dir = opts.dir ?? 'asc';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const expr = SORT_EXPR[sort];
  const op = dir === 'asc' ? '>' : '<';
  const k0 = "(CASE WHEN n.kind = 'folder' THEN 0 ELSE 1 END)";
  const binds: unknown[] = [userId, folderId];
  let where = `n.parent_id = ?2 AND n.trashed_at IS NULL AND n.status != 'uploading'`;
  if (opts.cursor) {
    const [c0, c1, cid] = decodeCursor(opts.cursor);
    binds.push(c0, c1, cid);
    where += ` AND (${k0} > ?3 OR (${k0} = ?3 AND (${expr} ${op} ?4 OR (${expr} = ?4 AND n.id ${op} ?5))))`;
  }
  const sql = `${SELECT_DTO} WHERE ${where}
    ORDER BY ${k0} ASC, ${expr} ${dir.toUpperCase()}, n.id ${dir.toUpperCase()} LIMIT ${limit + 1}`;
  const { results } = await ctx.env.DB.prepare(sql)
    .bind(...binds)
    .all<Row & { sort_key?: unknown }>();
  const page = results.slice(0, limit);
  let nextCursor: string | null = null;
  if (results.length > limit) {
    const last = page[page.length - 1]!;
    const key =
      sort === 'name'
        ? last.name_key
        : sort === 'updated'
          ? last.updated_at
          : sort === 'size'
            ? last.size
            : (last.mime ?? '');
    nextCursor = encodeCursor([last.kind === 'folder' ? 0 : 1, key, last.id]);
  }
  // Through the DTO query, so the open folder carries its cover for the banner (ADR-058).
  return { folder: await getNodeDto(ctx, userId, node.id), items: page.map(toDto), nextCursor };
}

export type Crumb = DriveCrumb;

export async function breadcrumb(ctx: Ctx, nodeId: string): Promise<Crumb[]> {
  const { results } = await ctx.env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, name, color, icon, depth) AS (
       SELECT id, parent_id, name, decor_color, decor_icon, 0 FROM nodes WHERE id = ?1
       UNION ALL SELECT n.id, n.parent_id, n.name, n.decor_color, n.decor_icon, up.depth + 1
         FROM nodes n JOIN up ON n.id = up.parent_id
       WHERE up.depth < 200)
     SELECT id, name, color, icon FROM up ORDER BY depth DESC`,
  )
    .bind(nodeId)
    .all<{ id: string; name: string; color: string | null; icon: string | null }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color && isFolderColor(r.color) ? r.color : null,
    icon: r.icon && isFolderIcon(r.icon) ? r.icon : null,
  }));
}

async function isDescendantOrSelf(ctx: Ctx, ancestorId: string, nodeId: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare(
    `WITH RECURSIVE up(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM nodes WHERE id = ?1
       UNION ALL SELECT n.id, n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id
       WHERE up.depth < 200)
     SELECT 1 AS hit FROM up WHERE id = ?2 LIMIT 1`,
  )
    .bind(nodeId, ancestorId)
    .first<{ hit: number }>();
  return Boolean(row);
}

async function spaceRootId(ctx: Ctx, node: NodeRecord): Promise<string> {
  const row =
    node.space === 'family'
      ? await ctx.env.DB.prepare(
          "SELECT id FROM nodes WHERE family_id = ?1 AND space = 'family' AND parent_id IS NULL",
        )
          .bind(node.family_id)
          .first<{ id: string }>()
      : await ctx.env.DB.prepare(
          "SELECT id FROM nodes WHERE owner_id = ?1 AND space = 'personal' AND parent_id IS NULL",
        )
          .bind(node.owner_id)
          .first<{ id: string }>();
  if (!row) throw new Error('space root missing');
  return row.id;
}

export async function requireWritableFolder(
  ctx: Ctx,
  userId: string,
  folderId: string,
): Promise<NodeRecord> {
  const { node } = await requireNode(ctx, userId, folderId, 'add');
  if (node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'target is not a folder');
  if (node.trashed_at !== null) throw new AppError('CONFLICT', 'target folder is in the trash');
  return node;
}

/** The user's Drive index is behind D1: it is written after the response (R3, ADR-074). */
export async function markManifestDirty(ctx: Ctx, userId: string): Promise<void> {
  await markIndexDirty(ctx, [userId]);
}

// ───────────────────────────── writes ─────────────────────────────

export async function createFolder(
  ctx: Ctx,
  userId: string,
  parentId: string,
  rawName: string,
  onConflict: 'error' | 'rename' | 'reuse' = 'rename',
): Promise<NodeDto> {
  const parent = await requireWritableFolder(ctx, userId, parentId);
  let name = sanitizeName(rawName);
  const existing = await siblingByName(ctx, parent.id, name);
  if (existing) {
    if (onConflict === 'reuse' && existing.kind === 'folder')
      return getNodeDto(ctx, userId, existing.id);
    if (onConflict === 'error')
      throw new AppError('NAME_CONFLICT', 'name already used', { existingId: existing.id });
    name = await uniqueName(ctx, parent.id, name);
  }
  const now = ctx.now();
  const id = ulid(now);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key,
           status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 'folder', ?7, ?8, 'ready', ?9, ?9)`,
      )
        .bind(
          id,
          parent.pool_id,
          parent.space,
          parent.family_id,
          userId,
          parent.id,
          name,
          nameKey(name),
          now,
        )
        .run();
      break;
    } catch (e) {
      if (!isUniqueViolation(e) || attempt === 2) throw e;
      if (onConflict === 'reuse') {
        const winner = await siblingByName(ctx, parent.id, name);
        if (winner?.kind === 'folder') return getNodeDto(ctx, userId, winner.id);
      }
      name = await uniqueName(ctx, parent.id, name);
    }
  }
  await markManifestDirty(ctx, userId);
  return getNodeDto(ctx, userId, id);
}

export async function renameNode(
  ctx: Ctx,
  userId: string,
  id: string,
  rawName: string,
): Promise<NodeDto> {
  const { node } = await requireNode(ctx, userId, id, 'edit');
  if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot rename a root folder');
  if (node.status === 'uploading') throw new AppError('UPLOAD_STATE', 'upload still running');
  const name = sanitizeName(rawName);
  const clash = await siblingByName(ctx, node.parent_id, name);
  if (clash && clash.id !== node.id)
    throw new AppError('NAME_CONFLICT', 'name already used', { existingId: clash.id });
  try {
    await ctx.env.DB.prepare(
      'UPDATE nodes SET name = ?2, name_key = ?3, updated_at = ?4, version = version + 1 WHERE id = ?1',
    )
      .bind(node.id, name, nameKey(name), ctx.now())
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('NAME_CONFLICT', 'name already used');
    throw e;
  }
  await markManifestDirty(ctx, node.owner_id);
  return getNodeDto(ctx, userId, node.id);
}

export interface DecorPatch {
  color?: string | null;
  icon?: string | null;
  coverId?: string | null;
}

/**
 * Colour, icon and cover for one or more folders (ADR-058). A part left out stays as it is; `null`
 * clears it. Needs edit access to every folder. The cover must be a ready image with a thumbnail
 * that the caller may see, in the same space as each folder, so everyone who sees the folder may
 * see the image too.
 */
export async function decorateFolders(
  ctx: Ctx,
  userId: string,
  ids: string[],
  patch: DecorPatch,
): Promise<NodeDto[]> {
  if (patch.color != null && !isFolderColor(patch.color))
    throw new AppError('VALIDATION', 'unknown colour', { field: 'color' });
  if (patch.icon != null && !isFolderIcon(patch.icon))
    throw new AppError('VALIDATION', 'unknown icon', { field: 'icon' });
  const folders: NodeRecord[] = [];
  for (const id of new Set(ids)) {
    const { node } = await requireNode(ctx, userId, id, 'edit');
    if (node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'not a folder');
    if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot decorate a root folder');
    if (node.trashed_at !== null) throw new AppError('CONFLICT', 'folder is in the trash');
    folders.push(node);
  }
  if (patch.coverId) {
    const { node: img } = await requireNode(ctx, userId, patch.coverId, 'view');
    const blob =
      img.kind === 'file' && img.status === 'ready' && img.trashed_at === null
        ? await ctx.env.DB.prepare(
            'SELECT thumb_key, scan_status, sniffed_mime FROM blobs WHERE id = ?1',
          )
            .bind(img.blob_id)
            .first<{ thumb_key: string | null; scan_status: string; sniffed_mime: string | null }>()
        : null;
    if (
      !blob ||
      !(blob.sniffed_mime ?? img.mime ?? '').startsWith('image/') ||
      blob.scan_status === 'infected' ||
      blob.scan_status === 'quarantined'
    )
      throw new AppError('VALIDATION', 'the cover must be an image', {
        field: 'coverId',
        reason: 'COVER_NOT_IMAGE',
      });
    if (!blob.thumb_key)
      throw new AppError('CONFLICT', 'no thumbnail yet', { reason: 'NO_THUMBNAIL' });
    for (const f of folders) {
      const same =
        f.space === img.space &&
        (f.space === 'family' ? f.family_id === img.family_id : f.owner_id === img.owner_id);
      if (!same)
        throw new AppError('VALIDATION', 'the cover must be in the same space as the folder', {
          field: 'coverId',
          reason: 'COVER_OTHER_SPACE',
        });
    }
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of [
    ['color', 'decor_color'],
    ['icon', 'decor_icon'],
    ['coverId', 'decor_cover_id'],
  ] as const) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${col} = ?${values.length + 1}`);
  }
  if (sets.length && folders.length) {
    const DB = ctx.env.DB;
    await DB.batch(
      folders.map((f) =>
        DB.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?1`).bind(f.id, ...values),
      ),
    );
    await markIndexDirty(
      ctx,
      folders.filter((f) => f.space === 'personal').map((f) => f.owner_id),
    );
  }
  return Promise.all(folders.map((f) => getNodeDto(ctx, userId, f.id)));
}

export async function moveNodes(
  ctx: Ctx,
  userId: string,
  ids: string[],
  targetId: string,
  opts: { confirmSpaceChange?: boolean } = {},
): Promise<NodeDto[]> {
  const target = await requireWritableFolder(ctx, userId, targetId);
  const moved: NodeDto[] = [];
  for (const id of ids) {
    const { node } = await requireNode(ctx, userId, id, 'edit');
    if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot move a root folder');
    if (node.trashed_at !== null) throw new AppError('CONFLICT', 'item is in the trash');
    if (node.status === 'uploading') throw new AppError('UPLOAD_STATE', 'upload still running');
    if (node.parent_id === target.id) {
      moved.push(await getNodeDto(ctx, userId, node.id));
      continue;
    }
    if (node.pool_id !== target.pool_id) {
      throw new AppError('BAD_REQUEST', 'cannot move across storage pools');
    }
    // Pribadi ⇄ Keluarga changes who can see the item: explicit confirmation (SPEC §9.1).
    if (node.space !== target.space || node.family_id !== target.family_id) {
      if (!opts.confirmSpaceChange) {
        throw new AppError('CONFLICT', 'moving changes who can see this item', {
          reason: 'SPACE_CHANGE',
          to: target.space,
        });
      }
      await changeSpace(ctx, userId, node, target);
    }
    if (node.kind === 'folder' && (await isDescendantOrSelf(ctx, node.id, target.id))) {
      throw new AppError('BAD_REQUEST', 'cannot move a folder into itself');
    }
    let name = node.name;
    if (await siblingByName(ctx, target.id, name)) name = await uniqueName(ctx, target.id, name);
    await ctx.env.DB.prepare(
      'UPDATE nodes SET parent_id = ?2, name = ?3, name_key = ?4, updated_at = ?5 WHERE id = ?1',
    )
      .bind(node.id, target.id, name, nameKey(name), ctx.now())
      .run();
    moved.push(await getNodeDto(ctx, userId, node.id));
  }
  await markManifestDirty(ctx, userId);
  return moved;
}

/** Re-labels a subtree as family or personal (same pool, so no bytes or quota move). */
async function changeSpace(
  ctx: Ctx,
  userId: string,
  node: NodeRecord,
  target: NodeRecord,
): Promise<void> {
  const DB = ctx.env.DB;
  if (target.space === 'family') {
    await DB.prepare(
      `${subtree(1)} UPDATE nodes SET space = 'family', family_id = ?2 WHERE id IN (SELECT id FROM sub)`,
    )
      .bind(node.id, target.family_id)
      .run();
    return;
  }
  // Family → private: only for subtrees made entirely by the mover, so nobody's items disappear.
  const foreign = await DB.prepare(
    `${subtree(1)} SELECT COUNT(*) AS n FROM nodes WHERE id IN (SELECT id FROM sub) AND created_by != ?2`,
  )
    .bind(node.id, userId)
    .first<{ n: number }>();
  if ((foreign?.n ?? 0) > 0) {
    throw new AppError('FORBIDDEN', 'the folder contains items made by other members', {
      reason: 'FOREIGN_ITEMS',
    });
  }
  await DB.batch([
    DB.prepare(
      `${subtree(1)} UPDATE shares SET revoked_at = ?3 WHERE created_by != ?2 AND revoked_at IS NULL
         AND id IN (SELECT share_id FROM share_items WHERE node_id IN (SELECT id FROM sub))`,
    ).bind(node.id, userId, ctx.now()),
    DB.prepare(
      `${subtree(1)} UPDATE nodes SET space = 'personal', family_id = NULL, owner_id = ?2 WHERE id IN (SELECT id FROM sub)`,
    ).bind(node.id, userId),
  ]);
}

/** "Buat salinan": new node, same blob (refcount+1), quota counted per node (SPEC §4). */
export async function copyFile(
  ctx: Ctx,
  userId: string,
  id: string,
  targetId?: string,
): Promise<NodeDto> {
  const { node } = await requireNode(ctx, userId, id, 'view');
  if (node.kind !== 'file') throw new AppError('BAD_REQUEST', 'only files can be copied');
  if (node.status !== 'ready' || !node.blob_id)
    throw new AppError('CONFLICT', 'file is not ready yet');
  const target = await requireWritableFolder(ctx, userId, targetId ?? node.parent_id!);
  if (target.pool_id !== node.pool_id)
    throw new AppError('BAD_REQUEST', 'cannot copy across storage pools');
  if (!(await addUsedIfFits(ctx, node.pool_id, node.size)))
    throw await quotaFullError(ctx, node.pool_id, node.size);
  const now = ctx.now();
  const newId = ulid(now);
  const name = await uniqueName(ctx, target.id, node.name);
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE blobs SET refcount = refcount + 1 WHERE id = ?1').bind(
        node.blob_id,
      ),
      ctx.env.DB.prepare(
        `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key,
           blob_id, size, mime, status, client_modified_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 'file', ?7, ?8, ?9, ?10, ?11, 'ready', ?12, ?13, ?13)`,
      ).bind(
        newId,
        target.pool_id,
        target.space,
        target.family_id,
        userId,
        target.id,
        name,
        nameKey(name),
        node.blob_id,
        node.size,
        node.mime,
        node.client_modified_at,
        now,
      ),
    ]);
  } catch (e) {
    await ctx.env.DB.prepare(
      'UPDATE storage_pools SET used_bytes = MAX(0, used_bytes - ?2) WHERE id = ?1',
    )
      .bind(node.pool_id, node.size)
      .run();
    throw e;
  }
  await markManifestDirty(ctx, userId);
  return getNodeDto(ctx, userId, newId);
}

export async function trashNodes(ctx: Ctx, userId: string, ids: string[]): Promise<number> {
  const cfg = await ctx.config();
  const now = ctx.now();
  const purgeAt = now + cfg.trash_retention_days * DAY_MS;
  let count = 0;
  for (const id of ids) {
    const { node } = await requireNode(ctx, userId, id, 'remove');
    if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot trash a root folder');
    if (node.trashed_at !== null) continue;
    const res = await ctx.env.DB.prepare(
      `${subtree(1)}
       UPDATE nodes SET trashed_at = ?2, trashed_by = ?3, trash_root_id = ?1, purge_at = ?4, updated_at = ?2
       WHERE id IN (SELECT id FROM sub) AND (trashed_at IS NULL OR id = ?1)`,
    )
      .bind(node.id, now, userId, purgeAt)
      .run();
    count += res.meta.changes;
    await markManifestDirty(ctx, node.owner_id);
  }
  return count;
}

export async function restoreNodes(ctx: Ctx, userId: string, ids: string[]): Promise<NodeDto[]> {
  const out: NodeDto[] = [];
  for (const id of ids) {
    const { node } = await requireNode(ctx, userId, id, 'remove');
    if (node.trash_root_id !== node.id) throw new AppError('BAD_REQUEST', 'not a trashed item');
    let parentId = node.parent_id!;
    const parent = await loadNode(ctx, parentId);
    if (!parent || parent.trashed_at !== null) parentId = await spaceRootId(ctx, node);
    let name = node.name;
    if (await siblingByName(ctx, parentId, name)) name = await uniqueName(ctx, parentId, name);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        'UPDATE nodes SET parent_id = ?2, name = ?3, name_key = ?4 WHERE id = ?1',
      ).bind(node.id, parentId, name, nameKey(name)),
      ctx.env.DB.prepare(
        `UPDATE nodes SET trashed_at = NULL, trashed_by = NULL, trash_root_id = NULL, purge_at = NULL,
           updated_at = ?2 WHERE trash_root_id = ?1`,
      ).bind(node.id, ctx.now()),
    ]);
    await markManifestDirty(ctx, node.owner_id);
    out.push(await getNodeDto(ctx, userId, node.id));
  }
  return out;
}

export interface DeleteResult {
  nodes: number;
  orphanBlobIds: string[];
}

/**
 * Permanently deletes `rootId` and its whole subtree (no access check — callers do that).
 * Quota: ready files leave used_bytes, uploading/scanning files release their reservation.
 * Blobs reaching refcount 0 are returned for R2 cleanup (never "delete prefix", SPEC §3).
 */
export async function deleteSubtree(ctx: Ctx, rootId: string): Promise<DeleteResult> {
  const root = await loadNode(ctx, rootId);
  if (!root) return { nodes: 0, orphanBlobIds: [] };
  if (root.parent_id === null) throw new AppError('FORBIDDEN', 'cannot delete a root folder');
  const DB = ctx.env.DB;
  const now = ctx.now();

  const { results: blobRows } = await DB.prepare(
    `${subtree(1)} SELECT DISTINCT blob_id FROM nodes WHERE id IN (SELECT id FROM sub) AND blob_id IS NOT NULL`,
  )
    .bind(rootId)
    .all<{ blob_id: string }>();
  const { results: activeUploads } = await DB.prepare(
    `${subtree(1)} SELECT id, r2_key, r2_upload_id FROM uploads
     WHERE status = 'active' AND node_id IN (SELECT id FROM sub)`,
  )
    .bind(rootId)
    .all<{ id: string; r2_key: string; r2_upload_id: string | null }>();

  const results = await DB.batch([
    DB.prepare(
      `${subtree(1)}
       UPDATE storage_pools SET
         used_bytes = MAX(0, used_bytes - (SELECT COALESCE(SUM(size), 0) FROM nodes
           WHERE id IN (SELECT id FROM sub) AND kind = 'file' AND status = 'ready')),
         reserved_bytes = MAX(0, reserved_bytes - (SELECT COALESCE(SUM(size), 0) FROM nodes
           WHERE id IN (SELECT id FROM sub) AND kind = 'file' AND status IN ('uploading', 'scanning'))),
         updated_at = ?3
       WHERE id = ?2`,
    ).bind(rootId, root.pool_id, now),
    DB.prepare(
      `${subtree(1)} UPDATE uploads SET status = 'aborted', completed_at = ?2
       WHERE status = 'active' AND node_id IN (SELECT id FROM sub)`,
    ).bind(rootId, now),
    DB.prepare(
      `${subtree(1)}
       UPDATE blobs SET refcount = MAX(0, refcount - (SELECT COUNT(*) FROM nodes n
         WHERE n.blob_id = blobs.id AND n.id IN (SELECT id FROM sub)))
       WHERE id IN (SELECT blob_id FROM nodes WHERE id IN (SELECT id FROM sub) AND blob_id IS NOT NULL)`,
    ).bind(rootId),
    DB.prepare(`${subtree(1)} DELETE FROM nodes WHERE id IN (SELECT id FROM sub)`).bind(rootId),
  ]);
  const deleted = results[3]?.meta.changes ?? 0;

  for (const u of activeUploads) {
    if (!u.r2_upload_id) continue;
    try {
      await ctx.env.BUCKET.resumeMultipartUpload(u.r2_key, u.r2_upload_id).abort();
    } catch {
      // Already gone; R2 also auto-aborts after 7 days.
    }
  }

  const orphanBlobIds: string[] = [];
  for (let i = 0; i < blobRows.length; i += 90) {
    const chunk = blobRows.slice(i, i + 90).map((b) => b.blob_id);
    const { results: zero } = await DB.prepare(
      `SELECT id FROM blobs WHERE refcount = 0 AND id IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`,
    )
      .bind(...chunk)
      .all<{ id: string }>();
    orphanBlobIds.push(...zero.map((z) => z.id));
  }
  for (const blobId of orphanBlobIds)
    await ctx.env.CLEANUP_QUEUE.send({ type: 'delete_blob', blobId });
  await markManifestDirty(ctx, root.owner_id);
  return { nodes: deleted, orphanBlobIds };
}

/** User-facing permanent delete (from the trash, or Shift+Delete with confirmation in the UI). */
export async function deleteForever(ctx: Ctx, userId: string, ids: string[]): Promise<number> {
  let total = 0;
  for (const id of ids) {
    const { node } = await requireNode(ctx, userId, id, 'remove');
    if (node.parent_id === null) throw new AppError('FORBIDDEN', 'cannot delete a root folder');
    total += (await deleteSubtree(ctx, node.id)).nodes;
  }
  return total;
}

/** The Trash in D1 (emptying it works there); the app's list is `readTrash` (ADR-077). */
export async function listTrash(ctx: Ctx, userId: string, only?: 'family'): Promise<NodeDto[]> {
  const personal = only ? '' : `(n.space = 'personal' AND n.owner_id = ?1) OR `;
  const { results } = await ctx.env.DB.prepare(
    `${SELECT_DTO}
     WHERE n.trash_root_id = n.id AND (${personal}(n.space = 'family' AND n.trashed_by = ?1))
     ORDER BY n.trashed_at DESC LIMIT 500`,
  )
    .bind(userId)
    .all<Row>();
  return results.map(toDto);
}

export async function emptyTrash(ctx: Ctx, userId: string): Promise<number> {
  const items = await listTrash(ctx, userId);
  let total = 0;
  for (const item of items) {
    const node = await loadNode(ctx, item.id);
    if (!node) continue;
    const access = await nodeAccess(ctx, userId, node);
    if (access.remove) total += (await deleteSubtree(ctx, node.id)).nodes;
  }
  return total;
}

/** Nightly purge of trash older than the retention window (SPEC §8.3). */
export async function purgeExpiredTrash(ctx: Ctx, limit = 200): Promise<number> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM nodes WHERE trash_root_id = id AND purge_at IS NOT NULL AND purge_at <= ?1 LIMIT ?2`,
  )
    .bind(ctx.now(), limit)
    .all<{ id: string }>();
  let total = 0;
  for (const r of results) total += (await deleteSubtree(ctx, r.id)).nodes;
  return total;
}

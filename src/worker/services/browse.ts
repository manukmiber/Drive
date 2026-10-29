// Cross-folder views: search, Berbintang, Terbaru (SPEC §8.1, §8.3). Search reads the person's own
// index (R2, ADR-077) and their family's (R4, ADR-078). Stars on family files are each member's own
// and Terbaru is not in any index yet, so those stay on D1.
import type { Ctx } from '../context';
import { DRIVE_TYPE_FILTERS, type DriveTypeFilter } from '../../shared/drive-tree';
import { markIndexDirty } from './drive-index-sync';
import { personalTree, searchTrees } from './drive-read';
import { AppError } from '../lib/errors';
import { requireNode } from './access';
import { COVER_SQL, toDto, type NodeDto } from './nodes';

/** Family nodes the user may see (§9.4). */
const FAMILY = `n.space = 'family'
  AND n.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?1)
  AND n.trashed_at IS NULL AND n.status != 'uploading' AND n.parent_id IS NOT NULL`;

/** Every node the user may see (Terbaru stays on D1 until it moves to the app, ADR-064). */
const VISIBLE = `((n.space = 'personal' AND n.owner_id = ?1)
  OR (n.space = 'family' AND n.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?1)))
  AND n.trashed_at IS NULL AND n.status != 'uploading' AND n.parent_id IS NOT NULL`;

const SELECT = `SELECT n.*, b.scan_status, b.thumb_key, ${COVER_SQL},
  (SELECT 1 FROM node_stars s WHERE s.node_id = n.id AND s.user_id = ?1) AS starred FROM nodes n
  LEFT JOIN blobs b ON b.id = n.blob_id`;

export type TypeFilter = DriveTypeFilter;

export interface SearchOptions {
  q: string;
  type?: TypeFilter | undefined;
  modifiedAfter?: number | undefined;
  space?: 'personal' | 'family' | undefined;
  limit?: number | undefined;
}

/** Names in the person's own Drive and their family's: every word a prefix, accents ignored. */
export async function search(ctx: Ctx, userId: string, o: SearchOptions): Promise<NodeDto[]> {
  return searchTrees(ctx, userId, o);
}

export async function setStar(
  ctx: Ctx,
  userId: string,
  nodeId: string,
  on: boolean,
): Promise<void> {
  const { node } = await requireNode(ctx, userId, nodeId, 'view');
  if (on) {
    await ctx.env.DB.prepare(
      'INSERT INTO node_stars (user_id, node_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING',
    )
      .bind(userId, nodeId, ctx.now())
      .run();
  } else {
    await ctx.env.DB.prepare('DELETE FROM node_stars WHERE user_id = ?1 AND node_id = ?2')
      .bind(userId, nodeId)
      .run();
  }
  // A star is in the index of the person's own tree (ADR-074).
  if (node.space === 'personal' && node.owner_id === userId) await markIndexDirty(ctx, [userId]);
}

/** Starred: the person's own from the index, family ones from D1, the most recently changed first. */
export async function listStarred(ctx: Ctx, userId: string): Promise<NodeDto[]> {
  const [{ tree }, { results }] = await Promise.all([
    personalTree(ctx, userId),
    ctx.env.DB.prepare(
      `${SELECT} JOIN node_stars st ON st.node_id = n.id AND st.user_id = ?1
       WHERE ${FAMILY} ORDER BY st.created_at DESC LIMIT 500`,
    )
      .bind(userId)
      .all<Parameters<typeof toDto>[0]>(),
  ]);
  return [...tree.starred(), ...results.map(toDto)]
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
    .slice(0, 500);
}

/** Recently opened or changed files. */
export async function listRecent(ctx: Ctx, userId: string): Promise<NodeDto[]> {
  const { results } = await ctx.env.DB.prepare(
    `${SELECT} LEFT JOIN node_recent r ON r.node_id = n.id AND r.user_id = ?1
     WHERE ${VISIBLE} AND n.kind = 'file'
       AND (r.accessed_at IS NOT NULL OR n.created_by = ?1)
     ORDER BY MAX(COALESCE(r.accessed_at, 0), n.updated_at) DESC LIMIT 100`,
  )
    .bind(userId)
    .all<Parameters<typeof toDto>[0]>();
  return results.map(toDto);
}

export function parseType(v: string | undefined): TypeFilter | undefined {
  if (!v) return undefined;
  if ((DRIVE_TYPE_FILTERS as readonly string[]).includes(v)) return v as TypeFilter;
  throw new AppError('VALIDATION', 'unknown type filter');
}

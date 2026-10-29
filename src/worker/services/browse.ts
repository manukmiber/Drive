// Cross-folder views: search (FTS5), Berbintang, Terbaru (SPEC §8.1, §8.3).
import type { Ctx } from '../context';
import { markIndexDirty } from './drive-index-sync';
import { AppError } from '../lib/errors';
import { requireNode } from './access';
import { COVER_SQL, toDto, type NodeDto } from './nodes';

/** Nodes the user may see: own personal space + family spaces they belong to (§9.4). */
const VISIBLE = `((n.space = 'personal' AND n.owner_id = ?1)
  OR (n.space = 'family' AND n.family_id IN (SELECT family_id FROM family_members WHERE user_id = ?1)))
  AND n.trashed_at IS NULL AND n.status != 'uploading' AND n.parent_id IS NOT NULL`;

const SELECT = `SELECT n.*, b.scan_status, b.thumb_key, ${COVER_SQL},
  (SELECT 1 FROM node_stars s WHERE s.node_id = n.id AND s.user_id = ?1) AS starred FROM nodes n
  LEFT JOIN blobs b ON b.id = n.blob_id`;

export type TypeFilter = 'folder' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'pdf';

const TYPE_SQL: Record<TypeFilter, string> = {
  folder: "n.kind = 'folder'",
  image: "n.mime LIKE 'image/%'",
  video: "n.mime LIKE 'video/%'",
  audio: "n.mime LIKE 'audio/%'",
  pdf: "n.mime = 'application/pdf'",
  document:
    "(n.mime LIKE 'text/%' OR n.mime LIKE 'application/vnd.%' OR n.mime IN ('application/pdf', 'application/msword', 'application/rtf'))",
  archive:
    "(n.mime LIKE '%zip%' OR n.mime LIKE '%rar%' OR n.mime LIKE '%7z%' OR n.mime LIKE '%tar%' OR n.mime LIKE '%zstd%' OR n.mime = 'application/gzip')",
};

/** Turns user input into a safe FTS5 prefix query: every token quoted, AND-ed, prefix-matched. */
export function ftsQuery(input: string): string | null {
  const tokens = input
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

export interface SearchOptions {
  q: string;
  type?: TypeFilter | undefined;
  modifiedAfter?: number | undefined;
  space?: 'personal' | 'family' | undefined;
  limit?: number | undefined;
}

export async function search(ctx: Ctx, userId: string, o: SearchOptions): Promise<NodeDto[]> {
  const match = ftsQuery(o.q);
  if (!match) return [];
  const where = [VISIBLE, 'n.rid IN (SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?2)'];
  const binds: unknown[] = [userId, match];
  if (o.type) where.push(TYPE_SQL[o.type]);
  if (o.modifiedAfter) {
    binds.push(o.modifiedAfter);
    where.push(`n.updated_at >= ?${binds.length}`);
  }
  if (o.space) {
    binds.push(o.space);
    where.push(`n.space = ?${binds.length}`);
  }
  const limit = Math.min(o.limit ?? 50, 100);
  const { results } = await ctx.env.DB.prepare(
    `${SELECT} WHERE ${where.join(' AND ')} ORDER BY (n.kind = 'folder') DESC, n.updated_at DESC LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<Parameters<typeof toDto>[0]>();
  return results.map(toDto);
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

export async function listStarred(ctx: Ctx, userId: string): Promise<NodeDto[]> {
  const { results } = await ctx.env.DB.prepare(
    `${SELECT} JOIN node_stars st ON st.node_id = n.id AND st.user_id = ?1
     WHERE ${VISIBLE} ORDER BY st.created_at DESC LIMIT 500`,
  )
    .bind(userId)
    .all<Parameters<typeof toDto>[0]>();
  return results.map(toDto);
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
  if (v in TYPE_SQL) return v as TypeFilter;
  throw new AppError('VALIDATION', 'unknown type filter');
}

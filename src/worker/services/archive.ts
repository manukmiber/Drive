// Builds archive entry lists for folders/bundles (SPEC §6.1, §7.2). Only `ready` files are
// included; rejected/scanning files and trashed items are skipped.
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import type { ZipEntry } from '../lib/zip';

interface Row {
  id: string;
  parent_id: string | null;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  updated_at: number;
  client_modified_at: number | null;
  status: string;
  r2_key: string | null;
  crc32: number | null;
  depth: number;
  root: string;
}

export interface ArchiveContent {
  entries: ZipEntry[];
  totalBytes: number;
  fileCount: number;
}

/** Entries for the given roots (files and/or folders), with folder structure preserved. */
export async function collectEntries(
  ctx: Ctx,
  rootIds: string[],
  limits?: { maxItems?: number },
): Promise<ArchiveContent> {
  if (!rootIds.length) return { entries: [], totalBytes: 0, fileCount: 0 };
  const placeholders = rootIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await ctx.env.DB.prepare(
    `WITH RECURSIVE t(id, depth, root) AS (
       SELECT id, 0, id FROM nodes WHERE id IN (${placeholders}) AND trashed_at IS NULL
       UNION ALL
       SELECT n.id, t.depth + 1, t.root FROM nodes n JOIN t ON n.parent_id = t.id
       WHERE n.trashed_at IS NULL AND t.depth < 64)
     SELECT n.id, n.parent_id, n.kind, n.name, n.size, n.updated_at, n.client_modified_at,
            CASE WHEN b.scan_status IN ('infected', 'quarantined') THEN 'rejected' ELSE n.status END AS status,
            b.r2_key, b.crc32, t.depth, t.root
     FROM t JOIN nodes n ON n.id = t.id LEFT JOIN blobs b ON b.id = n.blob_id
     ORDER BY t.root, t.depth, n.name_key`,
  )
    .bind(...rootIds)
    .all<Row>();
  const max = limits?.maxItems ?? 100_000;
  if (results.length > max)
    throw new AppError('PAYLOAD_TOO_LARGE', 'too many items for one archive', { max });

  const byId = new Map(results.map((r) => [r.id, r]));
  const pathOf = (r: Row): string => {
    const parts: string[] = [];
    let cur: Row | undefined = r;
    while (cur) {
      parts.unshift(cur.name);
      if (cur.depth === 0) break;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join('/');
  };

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const r of results) {
    const mtime = r.client_modified_at ?? r.updated_at;
    if (r.kind === 'folder') {
      entries.push({ path: `${pathOf(r)}/`, size: 0, crc32: 0, mtime, key: null });
    } else if (r.status === 'ready' && r.r2_key && r.crc32 !== null) {
      entries.push({ path: pathOf(r), size: r.size, crc32: r.crc32, mtime, key: r.r2_key });
      totalBytes += r.size;
      fileCount++;
    }
  }
  return { entries, totalBytes, fileCount };
}

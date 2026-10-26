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
  mime: string | null;
  blob_id: string | null;
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

/** Every node under the roots (and the roots), each with its path from its root. */
async function collectTree(
  ctx: Ctx,
  rootIds: string[],
  maxItems: number,
): Promise<Array<{ row: Row; path: string }>> {
  if (!rootIds.length) return [];
  const placeholders = rootIds.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await ctx.env.DB.prepare(
    `WITH RECURSIVE t(id, depth, root) AS (
       SELECT id, 0, id FROM nodes WHERE id IN (${placeholders}) AND trashed_at IS NULL
       UNION ALL
       SELECT n.id, t.depth + 1, t.root FROM nodes n JOIN t ON n.parent_id = t.id
       WHERE n.trashed_at IS NULL AND t.depth < 64)
     SELECT n.id, n.parent_id, n.kind, n.name, n.size, n.mime, n.blob_id, n.updated_at, n.client_modified_at,
            CASE WHEN b.scan_status IN ('infected', 'quarantined') THEN 'rejected' ELSE n.status END AS status,
            b.r2_key, b.crc32, t.depth, t.root
     FROM t JOIN nodes n ON n.id = t.id LEFT JOIN blobs b ON b.id = n.blob_id
     ORDER BY t.root, t.depth, n.name_key`,
  )
    .bind(...rootIds)
    .all<Row>();
  if (results.length > maxItems)
    throw new AppError('PAYLOAD_TOO_LARGE', 'too many items for one archive', { max: maxItems });

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
  return results.map((row) => ({ row, path: pathOf(row) }));
}

/** Entries for the given roots (files and/or folders), with folder structure preserved. */
export async function collectEntries(
  ctx: Ctx,
  rootIds: string[],
  limits?: { maxItems?: number },
): Promise<ArchiveContent> {
  const tree = await collectTree(ctx, rootIds, limits?.maxItems ?? 100_000);
  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  for (const { row: r, path } of tree) {
    const mtime = r.client_modified_at ?? r.updated_at;
    if (r.kind === 'folder') {
      entries.push({ path: `${path}/`, size: 0, crc32: 0, mtime, key: null });
    } else if (r.status === 'ready' && r.r2_key && r.crc32 !== null) {
      entries.push({ path, size: r.size, crc32: r.crc32, mtime, key: r.r2_key });
      totalBytes += r.size;
      fileCount++;
    }
  }
  return { entries, totalBytes, fileCount };
}

export interface TreeFile {
  nodeId: string;
  blobId: string;
  name: string;
  /** Path from its root, the root's own name first ("Foto/2024/a.jpg"). */
  path: string;
  size: number;
  mime: string | null;
  r2Key: string;
}

export interface TreeFiles {
  files: TreeFile[];
  /** Folder paths, so an empty folder can be made too. */
  folders: string[];
  /** Files left out because they are not ready (scanning, rejected, under review). */
  skipped: number;
  totalBytes: number;
}

/** Ready files under the roots, one by one: "download separately" and share listings (ADR-053). */
export async function collectFiles(
  ctx: Ctx,
  rootIds: string[],
  maxItems: number,
): Promise<TreeFiles> {
  const tree = await collectTree(ctx, rootIds, maxItems);
  const out: TreeFiles = { files: [], folders: [], skipped: 0, totalBytes: 0 };
  for (const { row: r, path } of tree) {
    if (r.kind === 'folder') out.folders.push(path);
    else if (r.status === 'ready' && r.r2_key && r.blob_id) {
      out.files.push({
        nodeId: r.id,
        blobId: r.blob_id,
        name: r.name,
        path,
        size: r.size,
        mime: r.mime,
        r2Key: r.r2_key,
      });
      out.totalBytes += r.size;
    } else out.skipped++;
  }
  return out;
}

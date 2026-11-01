// D1 (ADR-084): version history. When a file's content is replaced (an upload or an editor saving
// over it, Kompres "replace original"), the old content stays as a version instead of going to the
// Trash. The owner's answers: versions count toward the quota, live at most `version_keep_days`
// (≤ 30) days, and how many a file keeps is the person's choice, per space (the index header's
// `keepVersions`; 0 turns history off and replacing works as before).
//
// While Drive still writes D1 first (R3–R8), a version is a `nodes` row of kind 'version' under its
// file (the kind column is open by design, no new table or column): quota, refcounts, deleting a
// subtree, the Trash, moving between spaces and pools, account deletion and the data export all
// cover it as they cover files. The index shows versions as the file entry's `vs` column. Generic
// node routes never reach a version (requireNode refuses the kind); only the file's routes here do.
import { DAY_MS } from '../../shared/constants';
import { forgetTexts } from './content-index';
import { parseIndexHead, type IndexVersion } from '../../shared/drive-index';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { loadNode, requireNode, type NodeRecord } from './access';
import { logOf, recordActivity, type Located } from './activity';
import { changeIndex, indexKey, type IndexOwner } from './drive-index';
import { markIndexDirty } from './drive-index-sync';
import { treeNode } from './drive-read';
import { createDownloadToken, assertDownloadable } from './download';
import { deleteSubtree, getNodeDto, type NodeDto } from './nodes';

export const MAX_KEEP = 100;

export interface VersionDto {
  id: string;
  number: number;
  size: number;
  /** When it stopped being the file's content. */
  savedAt: number;
  /** When that content was made. */
  contentAt: number;
  kept: boolean;
  /** When it goes by itself (`version_keep_days` after savedAt). */
  expiresAt: number;
}

export async function headOf(ctx: Ctx, owner: IndexOwner): Promise<Record<string, unknown> | null> {
  const obj = await ctx.env.BUCKET.get(indexKey(owner), { range: { offset: 0, length: 65536 } });
  if (!obj || !('text' in obj)) return null;
  const text = await obj.text();
  const nl = text.indexOf('\n');
  try {
    return parseIndexHead(nl < 0 ? text : text.slice(0, nl));
  } catch {
    return null;
  }
}

/** How many versions a file in this space keeps (0: history off). */
export async function keepCount(ctx: Ctx, n: Located): Promise<number> {
  const head = await headOf(ctx, logOf(n));
  const v = head?.keepVersions;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return Math.min(v, MAX_KEEP);
  return (await ctx.config()).versions_default_keep;
}

/**
 * Turns the file's current content into a version (a statement to batch with the change that
 * replaces it). Guarded on the file still holding `blobId`, so a lost race inserts nothing.
 */
export function versionInsert(ctx: Ctx, fileId: string, blobId: string): D1PreparedStatement {
  const now = ctx.now();
  const id = ulid(now);
  return ctx.env.DB.prepare(
    `INSERT INTO nodes (id, pool_id, space, family_id, owner_id, created_by, parent_id, kind, name, name_key,
       blob_id, size, mime, status, client_modified_at, created_at, updated_at, version)
     SELECT ?2, pool_id, space, family_id, owner_id, created_by, id, 'version', name, '#v' || ?2,
       blob_id, size, mime, 'ready', client_modified_at, ?3, updated_at, version
     FROM nodes WHERE id = ?1 AND kind = 'file' AND status = 'ready' AND blob_id = ?4`,
  ).bind(fileId, id, now, blobId);
}

/** Drops a file's oldest versions past the count (kept ones don't count). */
export async function pruneFile(ctx: Ctx, fileId: string, keep: number): Promise<number> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM nodes WHERE parent_id = ?1 AND kind = 'version' AND status = 'ready'
     ORDER BY created_at DESC, version DESC LIMIT -1 OFFSET ?2`,
  )
    .bind(fileId, keep)
    .all<{ id: string }>();
  for (const r of results) await deleteSubtree(ctx, r.id);
  return results.length;
}

/**
 * An upload (or an editor's save) replacing `file` with the content of the hidden upload node
 * `incoming`: the file keeps its id, links and history, and its old content becomes a version.
 * False when history is off or the file can't take it (then the caller trashes the old file).
 */
export async function replaceWithVersion(
  ctx: Ctx,
  userId: string,
  file: NodeRecord,
  incoming: NodeRecord,
): Promise<boolean> {
  if (file.kind !== 'file' || file.status !== 'ready' || !file.blob_id || !incoming.blob_id)
    return false;
  try {
    await requireNode(ctx, userId, file.id, 'edit');
  } catch (e) {
    if (e instanceof AppError) return false;
    throw e;
  }
  const keep = await keepCount(ctx, file);
  if (keep === 0) return false;
  const DB = ctx.env.DB;
  const now = ctx.now();
  const swapped = `(SELECT blob_id FROM nodes WHERE id = ?1) = ?2`;
  const res = await DB.batch([
    versionInsert(ctx, file.id, file.blob_id),
    DB.prepare(
      `UPDATE nodes SET blob_id = ?2, size = ?3, mime = ?4, client_modified_at = ?5, status = 'scanning',
         version = version + 1, updated_at = ?6
       WHERE id = ?1 AND blob_id = ?7 AND status = 'ready'`,
    ).bind(
      file.id,
      incoming.blob_id,
      incoming.size,
      incoming.mime,
      incoming.client_modified_at,
      now,
      file.blob_id,
    ),
    DB.prepare(`UPDATE uploads SET node_id = ?3 WHERE node_id = ?4 AND ${swapped}`).bind(
      file.id,
      incoming.blob_id,
      file.id,
      incoming.id,
    ),
    DB.prepare(`DELETE FROM nodes WHERE id = ?3 AND ${swapped}`).bind(
      file.id,
      incoming.blob_id,
      incoming.id,
    ),
  ]);
  if (res[1]?.meta.changes !== 1) return false;
  recordActivity(ctx, userId, { action: 'replace', node: file });
  // D6 (ADR-090): the old content's search text no longer describes the file.
  ctx.defer(forgetTexts(ctx, logOf(file), [file.id]));
  await pruneFile(ctx, file.id, keep);
  await markIndexDirty(ctx, [file.owner_id]);
  return true;
}

async function fileAndVersion(
  ctx: Ctx,
  userId: string,
  fileId: string,
  versionId: string,
  need: 'view' | 'edit' | 'remove',
) {
  const { node: file } = await requireNode(ctx, userId, fileId, need);
  const version = await loadNode(ctx, versionId);
  if (!version || version.kind !== 'version' || version.parent_id !== file.id)
    throw new AppError('NOT_FOUND', 'version not found');
  return { file, version };
}

function toDto(v: IndexVersion, days: number): VersionDto {
  return {
    id: v.id,
    number: v.n,
    size: v.size,
    savedAt: v.savedAt,
    contentAt: v.contentAt,
    kept: v.kept,
    expiresAt: v.savedAt + days * DAY_MS,
  };
}

/** A file's versions, newest first, from the index (D1 while the index hasn't the file yet). */
export async function listVersions(
  ctx: Ctx,
  userId: string,
  fileId: string,
): Promise<{ items: VersionDto[]; keep: number; days: number }> {
  const days = (await ctx.config()).version_keep_days;
  const found = await treeNode(ctx, userId, fileId);
  let list: IndexVersion[];
  let where: Located;
  if (found) {
    if (found.node.kind !== 'file') throw new AppError('BAD_REQUEST', 'not a file');
    list = found.tree.versions(fileId);
    where = {
      space: found.node.space,
      owner_id: found.node.ownerId,
      family_id: 'family' in found.index ? found.index.family : null,
    };
  } else {
    const { node } = await requireNode(ctx, userId, fileId, 'view');
    if (node.kind !== 'file') throw new AppError('BAD_REQUEST', 'not a file');
    const { results } = await ctx.env.DB.prepare(
      `SELECT id, version, size, created_at, updated_at, status FROM nodes
       WHERE parent_id = ?1 AND kind = 'version' ORDER BY created_at DESC, version DESC`,
    )
      .bind(fileId)
      .all<{
        id: string;
        version: number;
        size: number;
        created_at: number;
        updated_at: number;
        status: string;
      }>();
    list = results.map((r) => ({
      id: r.id,
      n: r.version,
      size: r.size,
      savedAt: r.created_at,
      contentAt: r.updated_at,
      kept: r.status === 'kept',
    }));
    where = node;
  }
  return { items: list.map((v) => toDto(v, days)), keep: await keepCount(ctx, where), days };
}

/** A signed link to a version's content (the same /d/ links files use). */
export async function versionDownload(
  ctx: Ctx,
  userId: string,
  fileId: string,
  versionId: string,
): Promise<{ url: string; expiresAt: number }> {
  const { version } = await fileAndVersion(ctx, userId, fileId, versionId, 'view');
  const blob = await ctx.env.DB.prepare('SELECT scan_status FROM blobs WHERE id = ?1')
    .bind(version.blob_id)
    .first<{ scan_status: string }>();
  assertDownloadable(version, blob?.scan_status ?? null, userId);
  const cfg = await ctx.config();
  const expiresAt = ctx.now() + cfg.download_link_ttl_seconds * 1000;
  const token = await createDownloadToken(ctx.env.DOWNLOAD_SECRET, {
    blobId: version.blob_id!,
    nodeId: version.id,
    userId,
    exp: expiresAt,
  });
  return { url: `/d/${token}/${encodeURIComponent(version.name)}`, expiresAt };
}

/** Makes a version the file's content again; what the file held becomes a version itself. */
export async function restoreVersion(
  ctx: Ctx,
  userId: string,
  fileId: string,
  versionId: string,
): Promise<NodeDto> {
  const { file, version } = await fileAndVersion(ctx, userId, fileId, versionId, 'edit');
  if (file.trashed_at !== null) throw new AppError('CONFLICT', 'file is in the trash');
  if (file.status !== 'ready' || !file.blob_id)
    throw new AppError('CONFLICT', 'file is not ready yet');
  const DB = ctx.env.DB;
  const now = ctx.now();
  // Bytes stay as they were: the file's old content moves to a new version, the version's to the
  // file. References move along with them, so no refcount changes either.
  const res = await DB.batch([
    versionInsert(ctx, file.id, file.blob_id),
    DB.prepare(
      `UPDATE nodes SET blob_id = ?2, size = ?3, mime = ?4, client_modified_at = ?5,
         version = version + 1, updated_at = ?6
       WHERE id = ?1 AND blob_id = ?7 AND status = 'ready'`,
    ).bind(
      file.id,
      version.blob_id,
      version.size,
      version.mime,
      version.client_modified_at,
      now,
      file.blob_id,
    ),
    DB.prepare(
      `DELETE FROM nodes WHERE id = ?2 AND (SELECT blob_id FROM nodes WHERE id = ?1) = ?3`,
    ).bind(file.id, version.id, version.blob_id),
  ]);
  if (res[1]?.meta.changes !== 1) throw new AppError('CONFLICT', 'the file changed meanwhile');
  recordActivity(ctx, userId, {
    action: 'revert',
    node: file,
    from: String(version.version),
  });
  await pruneFile(ctx, file.id, await keepCount(ctx, file));
  await markIndexDirty(ctx, [file.owner_id]);
  return getNodeDto(ctx, userId, file.id);
}

/** Deletes a version for good (its bytes leave the quota). Needs the right to remove the file. */
export async function deleteVersion(
  ctx: Ctx,
  userId: string,
  fileId: string,
  versionId: string,
): Promise<void> {
  const { version } = await fileAndVersion(ctx, userId, fileId, versionId, 'remove');
  await deleteSubtree(ctx, version.id);
}

/** Keeps a version past the count (it still goes after the days limit), or stops keeping it. */
export async function keepVersion(
  ctx: Ctx,
  userId: string,
  fileId: string,
  versionId: string,
  kept: boolean,
): Promise<void> {
  const { file, version } = await fileAndVersion(ctx, userId, fileId, versionId, 'edit');
  await ctx.env.DB.prepare(`UPDATE nodes SET status = ?2 WHERE id = ?1 AND kind = 'version'`)
    .bind(version.id, kept ? 'kept' : 'ready')
    .run();
  if (!kept) await pruneFile(ctx, file.id, await keepCount(ctx, file));
  await markIndexDirty(ctx, [file.owner_id]);
}

export interface VersionSettings {
  personal: { keepVersions: number };
  family: { keepVersions: number; canChange: boolean } | null;
  days: number;
  max: number;
}

export async function versionSettings(ctx: Ctx, userId: string): Promise<VersionSettings> {
  const fam = await ctx.env.DB.prepare(
    'SELECT family_id, role FROM family_members WHERE user_id = ?1',
  )
    .bind(userId)
    .first<{ family_id: string; role: string }>();
  const personal = await keepCount(ctx, { space: 'personal', owner_id: userId, family_id: null });
  const family = fam
    ? {
        keepVersions: await keepCount(ctx, {
          space: 'family',
          owner_id: userId,
          family_id: fam.family_id,
        }),
        canChange: fam.role === 'owner',
      }
    : null;
  return {
    personal: { keepVersions: personal },
    family,
    days: (await ctx.config()).version_keep_days,
    max: MAX_KEEP,
  };
}

/**
 * How many versions files in a space keep. The person's own space is theirs to set; a family's
 * belongs to its owner. Lowering it drops what is now past the count.
 */
export async function setKeepVersions(
  ctx: Ctx,
  userId: string,
  space: 'personal' | 'family',
  keep: number,
): Promise<VersionSettings> {
  if (!Number.isInteger(keep) || keep < 0 || keep > MAX_KEEP)
    throw new AppError('VALIDATION', 'keepVersions out of range', { max: MAX_KEEP });
  let owner: IndexOwner;
  let filter: string;
  let bind: string;
  if (space === 'family') {
    const fam = await ctx.env.DB.prepare(
      'SELECT family_id, role FROM family_members WHERE user_id = ?1',
    )
      .bind(userId)
      .first<{ family_id: string; role: string }>();
    if (!fam) throw new AppError('NOT_FOUND', 'not in a family');
    if (fam.role !== 'owner')
      throw new AppError('FORBIDDEN', 'only the family owner can change this');
    owner = { family: fam.family_id };
    filter = `space = 'family' AND family_id = ?1`;
    bind = fam.family_id;
  } else {
    owner = { user: userId };
    filter = `space = 'personal' AND owner_id = ?1`;
    bind = userId;
  }
  await changeIndex(ctx.env.BUCKET, owner, (doc) => doc.setMeta('keepVersions', keep));
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY created_at DESC, version DESC) AS rn
       FROM nodes WHERE kind = 'version' AND status = 'ready' AND ${filter})
     WHERE rn > ?2 LIMIT 500`,
  )
    .bind(bind, keep)
    .all<{ id: string }>();
  for (const r of results) await deleteSubtree(ctx, r.id);
  return versionSettings(ctx, userId);
}

/** Nightly: versions older than `version_keep_days` go (those in the Trash go with their file). */
export async function purgeOldVersions(ctx: Ctx, limit = 500): Promise<number> {
  const cfg = await ctx.config();
  const { results } = await ctx.env.DB.prepare(
    `SELECT id FROM nodes WHERE kind = 'version' AND trashed_at IS NULL AND created_at <= ?1 LIMIT ?2`,
  )
    .bind(ctx.now() - cfg.version_keep_days * DAY_MS, limit)
    .all<{ id: string }>();
  for (const r of results) await deleteSubtree(ctx, r.id);
  return results.length;
}

// R2 (ADR-077): reads of a personal Drive come from the user's index (`u/{userId}/index.txt`),
// not from D1; R4 (ADR-078) does the same for a family's (`f/{familyId}/index.txt`). The views
// themselves are shared/drive-tree.ts, which the web app runs too.
//
// Until R8 every change still lands in D1 first and reaches the index a moment later (R3,
// ADR-074). So a read checks the marks in `manifest_dirty` (the person's own, or any member's for a
// family): unmarked, the stored index is current and is served as it is (the app's index request is
// then R2 streaming to the client); marked, the index is brought up to D1 in memory for this answer
// only, and the flush that the change asked for writes it. Either way a person sees their change
// in the next read.
//
// Uploads still running aren't in an index, and Recent and family stars aren't either: those reads
// stay on D1.
import { IndexFormatError, parseIndex } from '../../shared/drive-index';
import {
  DriveCursorError,
  DriveTree,
  searchOrder,
  type DriveNode,
  type DrivePageOptions,
  type DriveSearch,
} from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { requireNode, type Access } from './access';
import { FAMILY_ROOT_NAME, PERSONAL_ROOT_NAME } from './accounts';
import { indexKey, readIndex, type IndexOwner } from './drive-index';
import { project, readFamilyTree, readTree } from './drive-index-sync';
import { breadcrumb, getNodeDto, listChildren, type Crumb, type NodeDto } from './nodes';

export type DriveSpace = 'personal' | 'family';

const OWNER: Access = { view: true, edit: true, remove: true, add: true, isOwner: true };

interface IndexState {
  owner: IndexOwner;
  /** Behind D1: a mark is waiting (or being flushed) for this index. */
  behind: boolean;
  /** The pool's files are locked until payment (SPEC §12.5). */
  locked: boolean;
  /** Family only: the reader's role in it. */
  role: 'owner' | 'member' | null;
}

const LOCKED_SQL = (pool: string) =>
  `(SELECT s.status FROM subscriptions s WHERE s.pool_id = ${pool}
    ORDER BY s.created_at DESC LIMIT 1) = 'suspended'`;

async function personalState(ctx: Ctx, userId: string): Promise<IndexState> {
  const row = await ctx.env.DB.prepare(
    `SELECT EXISTS (SELECT 1 FROM manifest_dirty WHERE user_id = ?1) AS behind,
            COALESCE((SELECT ${LOCKED_SQL('p.id')} FROM storage_pools p
                      WHERE p.owner_type = 'user' AND p.owner_id = ?1), 0) AS locked`,
  )
    .bind(userId)
    .first<{ behind: number; locked: number }>();
  return {
    owner: { user: userId },
    behind: Boolean(row?.behind),
    locked: Boolean(row?.locked),
    role: null,
  };
}

/** The reader's family, or null; behind when any member is marked (a member's flush writes it). */
async function familyState(ctx: Ctx, userId: string): Promise<IndexState | null> {
  const row = await ctx.env.DB.prepare(
    `SELECT m.family_id, m.role, COALESCE(${LOCKED_SQL('f.pool_id')}, 0) AS locked,
            EXISTS (SELECT 1 FROM manifest_dirty d JOIN family_members x ON x.user_id = d.user_id
                    WHERE x.family_id = m.family_id) AS behind
     FROM family_members m JOIN families f ON f.id = m.family_id WHERE m.user_id = ?1`,
  )
    .bind(userId)
    .first<{ family_id: string; role: 'owner' | 'member'; locked: number; behind: number }>();
  if (!row) return null;
  return {
    owner: { family: row.family_id },
    behind: Boolean(row.behind),
    locked: Boolean(row.locked),
    role: row.role,
  };
}

/** The index brought up to D1 in memory (nothing is written; the change's own flush does that). */
async function freshText(ctx: Ctx, owner: IndexOwner): Promise<string | null> {
  const { doc } = await readIndex(ctx.env.BUCKET, owner);
  if ('user' in owner) {
    const tree = await readTree(ctx, owner.user);
    project(doc, tree.rows, tree.used);
  } else {
    const tree = await readFamilyTree(ctx, owner.family);
    if (!tree) return null;
    project(doc, tree.rows, tree.used, tree.members);
  }
  return doc.toText();
}

export interface DriveIndex {
  /** R2's etag of the stored index; null when this answer was brought up to D1 in memory. */
  etag: string | null;
  body: ReadableStream | string;
  locked: boolean;
  /** Who asked, and the Trash retention: what a client needs to read it as the API does. */
  owner: string;
  trashDays: number;
  role: 'owner' | 'member' | null;
}

/**
 * An index as it stands now: the person's own, or their family's (null when they have none).
 * What the app and API clients pull first.
 */
export async function openIndex(
  ctx: Ctx,
  userId: string,
  space: DriveSpace = 'personal',
): Promise<DriveIndex | null> {
  const [state, cfg] = await Promise.all([
    space === 'family' ? familyState(ctx, userId) : personalState(ctx, userId),
    ctx.config(),
  ]);
  if (!state) return null;
  const about = {
    locked: state.locked,
    owner: userId,
    trashDays: cfg.trash_retention_days,
    role: state.role,
  };
  if (!state.behind) {
    const obj = await ctx.env.BUCKET.get(indexKey(state.owner));
    if (obj) return { etag: obj.httpEtag, body: obj.body, ...about };
  }
  const text = await freshText(ctx, state.owner);
  return text === null ? null : { etag: null, body: text, ...about };
}

/** The index as an HTTP answer: plain text with its etag, or 304 when the client already has it. */
export function indexResponse(idx: DriveIndex, ifNoneMatch: string | undefined): Response {
  const drop = () => {
    if (typeof idx.body !== 'string') void idx.body.cancel();
  };
  if (idx.locked) {
    drop();
    throw new AppError('ACCOUNT_SUSPENDED', 'file access is locked until payment');
  }
  const headers = new Headers({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'private, no-cache',
    'x-drive-owner': idx.owner,
    'x-drive-trash-days': String(idx.trashDays),
  });
  if (idx.etag) {
    headers.set('etag', idx.etag);
    const known = (ifNoneMatch ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (known.includes(idx.etag)) {
      drop();
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(idx.body, { headers });
}

/** GET …/drive/index: the person's own index, or their family's (`space=family`; 404 without one). */
export async function indexAnswer(
  ctx: Ctx,
  userId: string,
  space: DriveSpace,
  ifNoneMatch: string | undefined,
): Promise<Response> {
  const idx = await openIndex(ctx, userId, space);
  if (!idx) throw new AppError('NOT_FOUND', 'not in a family');
  return indexResponse(idx, ifNoneMatch);
}

interface LoadedTree {
  tree: DriveTree;
  locked: boolean;
  role: 'owner' | 'member' | null;
}

const trees = new WeakMap<Ctx, Map<string, Promise<LoadedTree | null>>>();

/** One of the person's trees for this request (read once however many questions it answers). */
export function driveTree(
  ctx: Ctx,
  userId: string,
  space: DriveSpace = 'personal',
): Promise<LoadedTree | null> {
  let m = trees.get(ctx);
  if (!m) trees.set(ctx, (m = new Map()));
  const key = `${space}:${userId}`;
  let p = m.get(key);
  if (!p) {
    p = (async () => {
      const idx = await openIndex(ctx, userId, space);
      if (!idx) return null;
      const text = typeof idx.body === 'string' ? idx.body : await new Response(idx.body).text();
      try {
        const { head, entries } = parseIndex(text);
        const tree = new DriveTree(head, entries, {
          ownerId: userId,
          trashDays: idx.trashDays,
          rootName: space === 'family' ? FAMILY_ROOT_NAME : PERSONAL_ROOT_NAME,
        });
        return { tree, locked: idx.locked, role: idx.role };
      } catch (e) {
        if (e instanceof IndexFormatError) throw new AppError('INTERNAL', e.message);
        throw e;
      }
    })();
    m.set(key, p);
  }
  return p;
}

/** The person's own tree (there always is one, if only a root). */
export async function personalTree(ctx: Ctx, userId: string): Promise<LoadedTree> {
  return (await driveTree(ctx, userId, 'personal'))!;
}

/** Family rights (SPEC §9.2), as `nodeAccess` gives them; in the index the owner is the maker. */
function familyAccess(node: DriveNode, userId: string, role: LoadedTree['role']): Access {
  const privileged = role === 'owner' || node.createdBy === userId;
  return {
    view: true,
    edit: privileged || node.familyCanEdit,
    remove: privileged,
    add: true,
    isOwner: node.ownerId === userId,
  };
}

/** The node in one of the person's trees, their own first; locked files answer as requireNode does. */
async function treeNode(ctx: Ctx, userId: string, id: string) {
  for (const space of ['personal', 'family'] as const) {
    const t = await driveTree(ctx, userId, space);
    const node = t?.tree.node(id);
    if (!t || !node) continue;
    if (t.locked) throw new AppError('ACCOUNT_SUSPENDED', 'file access is locked until payment');
    const access = space === 'personal' ? OWNER : familyAccess(node, userId, t.role);
    return { tree: t.tree, node, access };
  }
  return null;
}

/** The scan's details live with the content, not in the index (ADR-064): the label comes from there. */
async function withScanDetail(ctx: Ctx, node: NodeDto): Promise<NodeDto> {
  if (node.kind !== 'file') return node;
  const row = await ctx.env.DB.prepare(
    'SELECT b.scan_status FROM nodes n JOIN blobs b ON b.id = n.blob_id WHERE n.id = ?1',
  )
    .bind(node.id)
    .first<{ scan_status: string }>();
  return row ? { ...node, scanStatus: row.scan_status } : node;
}

/** A file or folder with the folders above it, and what the person may do with it. */
export async function readNode(
  ctx: Ctx,
  userId: string,
  id: string,
): Promise<{ node: NodeDto; path: Crumb[]; access: Access }> {
  const found = await treeNode(ctx, userId, id);
  if (found)
    return {
      node: await withScanDetail(ctx, found.node),
      path: found.tree.path(id),
      access: found.access,
    };
  const { access } = await requireNode(ctx, userId, id);
  const [node, path] = await Promise.all([getNodeDto(ctx, userId, id), breadcrumb(ctx, id)]);
  return { node, path, access };
}

/** A page of a folder (SPEC §8.2), with the breadcrumb on the first page. */
export async function readChildren(
  ctx: Ctx,
  userId: string,
  folderId: string,
  opts: DrivePageOptions,
): Promise<{ folder: NodeDto; items: NodeDto[]; nextCursor: string | null; path?: Crumb[] }> {
  const found = await treeNode(ctx, userId, folderId);
  if (!found) {
    const res = await listChildren(ctx, userId, folderId, opts);
    return opts.cursor ? res : { ...res, path: await breadcrumb(ctx, folderId) };
  }
  if (found.node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'not a folder');
  let page: { items: NodeDto[]; nextCursor: string | null };
  try {
    page = found.tree.page(folderId, opts);
  } catch (e) {
    if (e instanceof DriveCursorError) throw new AppError('BAD_REQUEST', 'invalid cursor');
    throw e;
  }
  return {
    folder: found.node,
    ...page,
    ...(opts.cursor ? {} : { path: found.tree.path(folderId) }),
  };
}

/** Name search over the person's own tree and their family's, in one order. */
export async function searchTrees(
  ctx: Ctx,
  userId: string,
  o: DriveSearch & { space?: DriveSpace | undefined },
): Promise<NodeDto[]> {
  const limit = Math.min(o.limit ?? 50, 100);
  const spaces = (['personal', 'family'] as const).filter((s) => !o.space || o.space === s);
  const found = await Promise.all(
    spaces.map(async (s) => (await driveTree(ctx, userId, s))?.tree.search(o) ?? []),
  );
  return found.flat().sort(searchOrder).slice(0, limit);
}

/** The Trash: the person's own, and what they put there in their family's space. */
export async function readTrash(ctx: Ctx, userId: string): Promise<NodeDto[]> {
  const [own, family] = await Promise.all([
    driveTree(ctx, userId, 'personal'),
    driveTree(ctx, userId, 'family'),
  ]);
  return [...(own?.tree.trash() ?? []), ...(family?.tree.trash(500, userId) ?? [])]
    .sort((a, b) => b.trashedAt! - a.trashedAt! || (a.id < b.id ? 1 : -1))
    .slice(0, 500);
}

// R2 (ADR-077): reads of a personal Drive come from the user's index (`u/{userId}/index.txt`),
// not from D1. The views themselves are shared/drive-tree.ts, which the web app runs too.
//
// Until R8 every change still lands in D1 first and reaches the index a moment later (R3,
// ADR-074). So a read checks the user's mark in `manifest_dirty`: unmarked, the stored index is
// current and is served as it is (the app's index request is then R2 streaming to the client);
// marked, the index is brought up to D1 in memory for this answer only, and the flush that the
// change asked for writes it. Either way a person sees their change in the next read.
//
// Family folders (R4) and uploads still running aren't in the index: those reads stay on D1.
import { IndexFormatError, parseIndex } from '../../shared/drive-index';
import {
  DriveCursorError,
  DriveTree,
  searchOrder,
  type DrivePageOptions,
  type DriveSearch,
} from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { requireNode, type Access } from './access';
import { PERSONAL_ROOT_NAME } from './accounts';
import { indexKey, readIndex } from './drive-index';
import { project, readTree } from './drive-index-sync';
import { breadcrumb, getNodeDto, listChildren, listTrash, type Crumb, type NodeDto } from './nodes';

const OWNER: Access = { view: true, edit: true, remove: true, add: true, isOwner: true };

/** Whether the stored index is behind D1, and whether the person's files are locked (SPEC §12.5). */
async function indexState(ctx: Ctx, userId: string): Promise<{ behind: boolean; locked: boolean }> {
  const DB = ctx.env.DB;
  const [mark, pool] = await DB.batch([
    DB.prepare('SELECT 1 AS m FROM manifest_dirty WHERE user_id = ?1').bind(userId),
    DB.prepare(
      `SELECT (SELECT status FROM subscriptions s WHERE s.pool_id = p.id
               ORDER BY s.created_at DESC LIMIT 1) AS sub
       FROM storage_pools p WHERE p.owner_type = 'user' AND p.owner_id = ?1`,
    ).bind(userId),
  ]);
  return {
    behind: mark!.results.length > 0,
    locked: (pool!.results[0] as { sub: string | null } | undefined)?.sub === 'suspended',
  };
}

/** The index brought up to D1 in memory (nothing is written; the change's own flush does that). */
async function freshText(ctx: Ctx, userId: string): Promise<string> {
  const { doc } = await readIndex(ctx.env.BUCKET, { user: userId });
  const tree = await readTree(ctx, userId);
  project(doc, tree.rows, tree.used);
  return doc.toText();
}

export interface PersonalIndex {
  /** R2's etag of the stored index; null when this answer was brought up to D1 in memory. */
  etag: string | null;
  body: ReadableStream | string;
  locked: boolean;
  /** Whose index it is, and the Trash retention: what a client needs to read it as the API does. */
  owner: string;
  trashDays: number;
}

/** The person's index as it stands now: what the app and API clients pull first. */
export async function openPersonalIndex(ctx: Ctx, userId: string): Promise<PersonalIndex> {
  const [{ behind, locked }, cfg] = await Promise.all([indexState(ctx, userId), ctx.config()]);
  const about = { locked, owner: userId, trashDays: cfg.trash_retention_days };
  if (!behind) {
    const obj = await ctx.env.BUCKET.get(indexKey({ user: userId }));
    if (obj) return { etag: obj.httpEtag, body: obj.body, ...about };
  }
  return { etag: null, body: await freshText(ctx, userId), ...about };
}

/** The index as an HTTP answer: plain text with its etag, or 304 when the client already has it. */
export function indexResponse(idx: PersonalIndex, ifNoneMatch: string | undefined): Response {
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

const trees = new WeakMap<Ctx, Map<string, Promise<{ tree: DriveTree; locked: boolean }>>>();

/** The person's tree for this request (read once however many questions it answers). */
export function personalTree(
  ctx: Ctx,
  userId: string,
): Promise<{ tree: DriveTree; locked: boolean }> {
  let m = trees.get(ctx);
  if (!m) trees.set(ctx, (m = new Map()));
  let p = m.get(userId);
  if (!p) {
    p = (async () => {
      const idx = await openPersonalIndex(ctx, userId);
      const text = typeof idx.body === 'string' ? idx.body : await new Response(idx.body).text();
      try {
        const { head, entries } = parseIndex(text);
        const tree = new DriveTree(head, entries, {
          ownerId: userId,
          trashDays: idx.trashDays,
          rootName: PERSONAL_ROOT_NAME,
        });
        return { tree, locked: idx.locked };
      } catch (e) {
        if (e instanceof IndexFormatError)
          throw new AppError('INTERNAL', e.message, { index: indexKey({ user: userId }) });
        throw e;
      }
    })();
    m.set(userId, p);
  }
  return p;
}

/** A tree node of the person's own, else null; locked files answer as requireNode does. */
async function ownNode(ctx: Ctx, userId: string, id: string) {
  const { tree, locked } = await personalTree(ctx, userId);
  const node = tree.node(id);
  if (!node) return null;
  if (locked) throw new AppError('ACCOUNT_SUSPENDED', 'file access is locked until payment');
  return { tree, node };
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
  const own = await ownNode(ctx, userId, id);
  if (own)
    return { node: await withScanDetail(ctx, own.node), path: own.tree.path(id), access: OWNER };
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
  const own = await ownNode(ctx, userId, folderId);
  if (!own) {
    const res = await listChildren(ctx, userId, folderId, opts);
    return opts.cursor ? res : { ...res, path: await breadcrumb(ctx, folderId) };
  }
  if (own.node.kind !== 'folder') throw new AppError('BAD_REQUEST', 'not a folder');
  let page: { items: NodeDto[]; nextCursor: string | null };
  try {
    page = own.tree.page(folderId, opts);
  } catch (e) {
    if (e instanceof DriveCursorError) throw new AppError('BAD_REQUEST', 'invalid cursor');
    throw e;
  }
  return {
    folder: own.node,
    ...page,
    ...(opts.cursor ? {} : { path: own.tree.path(folderId) }),
  };
}

/** Personal results from the index merged with family ones from D1, in one order. */
export async function mergeSearch(
  ctx: Ctx,
  userId: string,
  o: DriveSearch & { space?: 'personal' | 'family' | undefined },
  family: () => Promise<NodeDto[]>,
): Promise<NodeDto[]> {
  const limit = Math.min(o.limit ?? 50, 100);
  const [mine, theirs] = await Promise.all([
    o.space === 'family' ? [] : personalTree(ctx, userId).then(({ tree }) => tree.search(o)),
    o.space === 'personal' ? [] : family(),
  ]);
  return [...mine, ...theirs].sort(searchOrder).slice(0, limit);
}

/** The Trash: the person's own from the index, what they trashed in a family from D1. */
export async function readTrash(ctx: Ctx, userId: string): Promise<NodeDto[]> {
  const [{ tree }, family] = await Promise.all([
    personalTree(ctx, userId),
    listTrash(ctx, userId, 'family'),
  ]);
  return [...tree.trash(), ...family]
    .sort((a, b) => b.trashedAt! - a.trashedAt! || (a.id < b.id ? 1 : -1))
    .slice(0, 500);
}

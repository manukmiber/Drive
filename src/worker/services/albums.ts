// D10 (ADR-093): albums in the Gallery. An album is a list of references to files (never copies,
// so it adds nothing to storage), kept in one small R2 object per space next to its index:
// u/{userId}/albums.json for the person's own, f/{familyId}/albums.json for the family's
// (ADR-064: not D1). Every reader sees only the files they may see in their own trees; a file that
// is gone or in the Trash simply doesn't show, and is dropped the next time the album is written.
import type { DriveNode } from '../../shared/drive-tree';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { ulid } from '../lib/ids';
import { albumKey, isRateLimited, type IndexOwner } from './drive-index';
import { driveTree, type DriveSpace } from './drive-read';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AlbumSort = 'added' | 'newest' | 'oldest';

export interface Album {
  id: string;
  name: string;
  /** Node ids in the album's own order (the order they were added, or as rearranged). */
  items: string[];
  /** The file shown on the album; null = its first visible photo. */
  cover: string | null;
  sort: AlbumSort;
  /** Family albums: who put each file in (only they can tell when their own file is gone). */
  addedBy?: Record<string, string>;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface AlbumDoc {
  v: 1;
  albums: Album[];
}

const empty = (): AlbumDoc => ({ v: 1, albums: [] });

function parse(text: string): AlbumDoc {
  try {
    const d = JSON.parse(text) as AlbumDoc;
    return d && Array.isArray(d.albums) ? d : empty();
  } catch {
    return empty();
  }
}

async function readAlbums(bucket: R2Bucket, owner: IndexOwner): Promise<AlbumDoc> {
  const obj = await bucket.get(albumKey(owner));
  return obj ? parse(await obj.text()) : empty();
}

/** Read, change, write with R2's etag condition (another writer in between: read again). */
async function changeAlbums<T>(
  bucket: R2Bucket,
  owner: IndexOwner,
  change: (doc: AlbumDoc) => T | Promise<T>,
  attempts = 10,
): Promise<T> {
  const key = albumKey(owner);
  for (let attempt = 1; ; attempt++) {
    const obj = await bucket.get(key);
    const doc = obj ? parse(await obj.text()) : empty();
    const out = await change(doc);
    let limited = false;
    try {
      const put = doc.albums.length
        ? await bucket.put(key, JSON.stringify(doc), {
            httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
            onlyIf: obj ? { etagMatches: obj.etag } : new Headers({ 'if-none-match': '*' }),
          })
        : obj
          ? (await bucket.delete(key), true)
          : true;
      if (put) return out;
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      limited = true;
    }
    if (attempt >= attempts)
      throw new AppError('INDEX_BUSY', 'The albums are busy, try again', { index: key });
    await sleep((limited ? 1000 : Math.min(150 * attempt, 1000)) + Math.floor(Math.random() * 250));
  }
}

/** Where the person's albums of a space live (null: no family). */
async function ownerOf(ctx: Ctx, userId: string, space: DriveSpace) {
  if (space === 'personal') return { owner: { user: userId } as IndexOwner, role: null };
  const t = await driveTree(ctx, userId, 'family');
  return t ? { owner: t.index, role: t.role } : null;
}

/** Every file the person can see, by id: their own tree, then their family's. */
async function visibleFiles(ctx: Ctx, userId: string) {
  const trees = await Promise.all([
    driveTree(ctx, userId, 'personal'),
    driveTree(ctx, userId, 'family'),
  ]);
  return (id: string): DriveNode | null => {
    for (const t of trees) {
      if (!t || t.locked) continue;
      const n = t.tree.node(id);
      if (n && n.kind === 'file' && n.trashedAt === null && n.status !== 'rejected') return n;
    }
    return null;
  };
}

export interface AlbumView {
  id: string;
  name: string;
  space: DriveSpace;
  /** What this person sees in it. */
  count: number;
  coverId: string | null;
  sort: AlbumSort;
  createdAt: number;
  updatedAt: number;
  /** May rename or delete it (who made it, or the family's owner). */
  canManage: boolean;
}

const galleryDate = (n: DriveNode) => n.takenAt ?? n.clientModifiedAt ?? n.createdAt;

function ordered(a: Album, see: (id: string) => DriveNode | null): DriveNode[] {
  const nodes = a.items.map(see).filter((n): n is DriveNode => n !== null);
  if (a.sort === 'newest') nodes.sort((x, y) => galleryDate(y) - galleryDate(x));
  if (a.sort === 'oldest') nodes.sort((x, y) => galleryDate(x) - galleryDate(y));
  return nodes;
}

function view(
  a: Album,
  space: DriveSpace,
  nodes: DriveNode[],
  userId: string,
  role: 'owner' | 'member' | null,
): AlbumView {
  const cover = a.cover && nodes.some((n) => n.id === a.cover) ? a.cover : (nodes[0]?.id ?? null);
  return {
    id: a.id,
    name: a.name,
    space,
    count: nodes.length,
    coverId: cover,
    sort: a.sort,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    canManage: space === 'personal' || a.createdBy === userId || role === 'owner',
  };
}

/** The person's albums and their family's, newest change first. */
export async function listAlbums(ctx: Ctx, userId: string): Promise<AlbumView[]> {
  const see = await visibleFiles(ctx, userId);
  const out: AlbumView[] = [];
  for (const space of ['personal', 'family'] as const) {
    const where = await ownerOf(ctx, userId, space);
    if (!where) continue;
    const doc = await readAlbums(ctx.env.BUCKET, where.owner);
    for (const a of doc.albums) out.push(view(a, space, ordered(a, see), userId, where.role));
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Finds an album by id in the person's spaces (another's id is simply not found). */
async function locate(ctx: Ctx, userId: string, id: string) {
  for (const space of ['personal', 'family'] as const) {
    const where = await ownerOf(ctx, userId, space);
    if (!where) continue;
    const doc = await readAlbums(ctx.env.BUCKET, where.owner);
    const album = doc.albums.find((a) => a.id === id);
    if (album) return { space, ...where, album };
  }
  throw new AppError('NOT_FOUND', 'no such album');
}

export async function getAlbum(
  ctx: Ctx,
  userId: string,
  id: string,
  offset = 0,
  limit = 500,
): Promise<{ album: AlbumView; items: DriveNode[]; nextOffset: number | null }> {
  const { space, album, role } = await locate(ctx, userId, id);
  const nodes = ordered(album, await visibleFiles(ctx, userId));
  const items = nodes.slice(offset, offset + limit);
  return {
    album: view(album, space, nodes, userId, role),
    items,
    nextOffset: offset + limit < nodes.length ? offset + limit : null,
  };
}

const MEDIA = (n: DriveNode) => /^(image|video)\//.test(n.mime ?? '');

/** Only the person's own visible photos and videos may go in; the rest is left out quietly. */
async function addable(ctx: Ctx, userId: string, nodeIds: string[]): Promise<string[]> {
  const see = await visibleFiles(ctx, userId);
  return [...new Set(nodeIds)].filter((id) => {
    const n = see(id);
    return n !== null && MEDIA(n);
  });
}

/**
 * Drops references to files that are gone for good (a file in the Trash may come back). A family
 * album can hold members' own files the writer can't see: those are left for whoever added them.
 */
async function prune(ctx: Ctx, userId: string, a: Album, space: DriveSpace): Promise<void> {
  const [own, fam] = await Promise.all([
    driveTree(ctx, userId, 'personal'),
    driveTree(ctx, userId, 'family'),
  ]);
  if (own?.locked || fam?.locked) return;
  const known = (id: string) => Boolean(own?.tree.node(id) || fam?.tree.node(id));
  a.items = a.items.filter((id) => {
    if (known(id)) return true;
    if (space === 'personal') return false;
    const by = a.addedBy?.[id];
    return by !== undefined && by !== userId;
  });
  if (a.addedBy) {
    const left = new Set(a.items);
    for (const id of Object.keys(a.addedBy)) if (!left.has(id)) delete a.addedBy[id];
  }
}

export async function createAlbum(
  ctx: Ctx,
  userId: string,
  input: { name: string; space: DriveSpace; nodeIds?: string[] },
): Promise<AlbumView> {
  const where = await ownerOf(ctx, userId, input.space);
  if (!where) throw new AppError('NOT_FOUND', 'not in a family');
  const cfg = await ctx.config();
  const items = (await addable(ctx, userId, input.nodeIds ?? [])).slice(0, cfg.album_max_items);
  const now = ctx.now();
  const album: Album = {
    id: ulid(now),
    name: input.name.trim(),
    items,
    cover: null,
    sort: 'added',
    ...(input.space === 'family'
      ? { addedBy: Object.fromEntries(items.map((i) => [i, userId])) }
      : {}),
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  await changeAlbums(ctx.env.BUCKET, where.owner, (doc) => {
    if (doc.albums.length >= cfg.album_max_per_space)
      throw new AppError('CONFLICT', 'too many albums', { reason: 'ALBUM_LIMIT' });
    doc.albums.push(album);
  });
  const see = await visibleFiles(ctx, userId);
  return view(album, input.space, ordered(album, see), userId, where.role);
}

export interface AlbumChange {
  name?: string;
  coverId?: string | null;
  sort?: AlbumSort;
  /** Add these files (at the end). */
  add?: string[];
  /** Take these files out. */
  remove?: string[];
  /** A new order: the ids given come first, in this order, the rest after as they were. */
  order?: string[];
}

/** Renaming and the sort order are for whoever may manage it; adding and removing for every member. */
export async function updateAlbum(
  ctx: Ctx,
  userId: string,
  id: string,
  change: AlbumChange,
): Promise<AlbumView> {
  const where = await locate(ctx, userId, id);
  const manage =
    where.space === 'personal' || where.album.createdBy === userId || where.role === 'owner';
  if ((change.name !== undefined || change.sort !== undefined) && !manage)
    throw new AppError('FORBIDDEN', 'only who made the album renames it');
  const cfg = await ctx.config();
  const add = change.add ? await addable(ctx, userId, change.add) : [];
  const see = await visibleFiles(ctx, userId);
  const updated = await changeAlbums(ctx.env.BUCKET, where.owner, async (doc) => {
    const a = doc.albums.find((x) => x.id === id);
    if (!a) throw new AppError('NOT_FOUND', 'no such album');
    await prune(ctx, userId, a, where.space);
    if (change.name !== undefined) a.name = change.name.trim();
    if (change.sort !== undefined) a.sort = change.sort;
    if (change.remove?.length) {
      // Only files this person can see: what is hidden from them stays for those who see it.
      const out = new Set(change.remove.filter((r) => see(r)));
      a.items = a.items.filter((i) => !out.has(i));
      if (a.addedBy) for (const r of out) delete a.addedBy[r];
    }
    if (add.length) {
      const have = new Set(a.items);
      for (const i of add)
        if (!have.has(i)) {
          a.items.push(i);
          if (where.space === 'family') (a.addedBy ??= {})[i] = userId;
        }
      if (a.items.length > cfg.album_max_items)
        throw new AppError('CONFLICT', 'the album is full', { reason: 'ALBUM_FULL' });
    }
    if (change.order?.length) {
      const first = change.order.filter((i) => a.items.includes(i));
      const firstSet = new Set(first);
      a.items = [...first, ...a.items.filter((i) => !firstSet.has(i))];
      a.sort = 'added';
    }
    if (change.coverId !== undefined) {
      if (change.coverId !== null && !(a.items.includes(change.coverId) && see(change.coverId)))
        throw new AppError('VALIDATION', 'the cover must be a photo in the album', {
          field: 'coverId',
        });
      a.cover = change.coverId;
    }
    a.updatedAt = ctx.now();
    return { ...a };
  });
  return view(updated, where.space, ordered(updated, see), userId, where.role);
}

export async function deleteAlbum(ctx: Ctx, userId: string, id: string): Promise<void> {
  const where = await locate(ctx, userId, id);
  if (!(where.space === 'personal' || where.album.createdBy === userId || where.role === 'owner'))
    throw new AppError('FORBIDDEN', 'only who made the album deletes it');
  await changeAlbums(ctx.env.BUCKET, where.owner, (doc) => {
    doc.albums = doc.albums.filter((a) => a.id !== id);
  });
}

/** Data export: the person's own albums (ids of files, names, order). */
export async function exportAlbums(ctx: Ctx, userId: string): Promise<Album[]> {
  return (await readAlbums(ctx.env.BUCKET, { user: userId })).albums;
}

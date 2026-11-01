// D8 (ADR-091): every photo and video the person may see in their own Drive and their family's,
// newest first by when it was taken, a page at a time. Read from the indexes (R2); the query is the
// search box's syntax (D6), with images and videos and the taken date as defaults.
import type { DriveNode } from '../../shared/drive-tree';
import { parseSearch } from '../../shared/search-query';
import type { Ctx } from '../context';
import { AppError } from '../lib/errors';
import { driveTree, type DriveSpace } from './drive-read';

export interface GalleryOptions {
  space?: DriveSpace | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** The date a photo is filed under: taken, else the device's time, else when it came in. */
export function galleryDate(n: Pick<DriveNode, 'takenAt' | 'clientModifiedAt' | 'createdAt'>) {
  return n.takenAt ?? n.clientModifiedAt ?? n.createdAt;
}

function decodeCursor(c: string): [number, string] {
  try {
    const v = JSON.parse(atob(c.replace(/-/g, '+').replace(/_/g, '/'))) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'string')
      return [v[0], v[1]];
  } catch {
    // fall through
  }
  throw new AppError('BAD_REQUEST', 'invalid cursor');
}

const encodeCursor = (date: number, id: string) =>
  btoa(JSON.stringify([date, id]))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function gallery(
  ctx: Ctx,
  userId: string,
  o: GalleryOptions,
): Promise<{ items: DriveNode[]; nextCursor: string | null }> {
  const q = o.q ?? '';
  const p = parseSearch(q);
  p.types = p.types.length
    ? p.types.filter((t) => t === 'image' || t === 'video')
    : ['image', 'video'];
  if (!p.types.length) return { items: [], nextCursor: null };
  if (!/(^|\s)-?(tanggal|date):/i.test(q)) p.dateField = 'taken';
  if (o.space) p.space = o.space;
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 500);
  const all: DriveNode[] = [];
  for (const space of ['personal', 'family'] as const) {
    if (p.space && p.space !== space) continue;
    const loaded = await driveTree(ctx, userId, space);
    if (!loaded || loaded.locked) continue;
    const within = p.inFolder ? loaded.tree.foldersNamed(p.inFolder) : null;
    if (within && !within.length) continue;
    for (const { node } of loaded.tree.find(p, { within }))
      if (node.kind === 'file' && node.status !== 'rejected') all.push(node);
  }
  all.sort((a, b) => galleryDate(b) - galleryDate(a) || (a.id < b.id ? 1 : -1));
  let rest = all;
  if (o.cursor) {
    const [d, id] = decodeCursor(o.cursor);
    rest = all.filter((n) => galleryDate(n) < d || (galleryDate(n) === d && n.id < id));
  }
  const items = rest.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rest.length > limit && last ? encodeCursor(galleryDate(last), last.id) : null,
  };
}

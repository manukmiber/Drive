// R2 (ADR-077): what the explorer shows of a personal Drive, read from the user's index
// (`u/{userId}/index.txt`, format in drive-index.ts) instead of D1. The Worker (the app's and v1's
// read routes) and the web app (which pulls the index first and lists folders itself) both use this
// one implementation, so the two can't drift apart.
//
// While Drive moves off D1 (R3–R8) a node's id is still its D1 id, kept in the entry's `x` column;
// entry numbers stay inside one index and are never shown.
import type { IndexEntry, IndexHead } from './drive-index';
import { isFolderColor, isFolderIcon, type FolderColor, type FolderDecor } from './folder-decor';

/** A file or folder as the app and the API see it (the Worker's NodeDto). */
export interface DriveNode {
  id: string;
  parentId: string | null;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  mime: string | null;
  status: 'uploading' | 'scanning' | 'ready' | 'rejected';
  scanStatus: string | null;
  space: 'personal' | 'family';
  ownerId: string;
  createdBy: string;
  familyCanEdit: boolean;
  starred: boolean;
  hasThumb: boolean;
  trashedAt: number | null;
  purgeAt: number | null;
  createdAt: number;
  updatedAt: number;
  clientModifiedAt: number | null;
  /** Folders only; null when undecorated (ADR-058). */
  decor: FolderDecor | null;
}

export interface DriveCrumb {
  id: string;
  name: string;
  /** The folder's colour and icon (ADR-058); a breadcrumb never shows a cover. */
  color: FolderColor | null;
  icon: string | null;
}

export type DriveSort = 'name' | 'updated' | 'size' | 'type';
export type DriveTypeFilter =
  'folder' | 'image' | 'video' | 'audio' | 'document' | 'archive' | 'pdf';

export interface DriveSearch {
  q: string;
  type?: DriveTypeFilter | undefined;
  modifiedAfter?: number | undefined;
  limit?: number | undefined;
}

export interface DrivePageOptions {
  sort?: DriveSort | undefined;
  dir?: 'asc' | 'desc' | undefined;
  cursor?: string | null | undefined;
  limit?: number | undefined;
}

/** Case-insensitive key used for sibling names and for sorting by name. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** Thrown for a cursor this tree didn't hand out. */
export class DriveCursorError extends Error {
  constructor() {
    super('invalid cursor');
    this.name = 'DriveCursorError';
  }
}

export function encodeCursor(v: unknown[]): string {
  return btoa(JSON.stringify(v)).replace(/=+$/, '');
}

export function decodeCursor(c: string): [number, string | number, string] {
  try {
    const v = JSON.parse(atob(c)) as unknown;
    if (Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && typeof v[2] === 'string')
      return v as [number, string | number, string];
  } catch {
    // fall through
  }
  throw new DriveCursorError();
}

const DAY_MS = 86_400_000;

/**
 * Search words the way D1's FTS5 index read them (`unicode61 remove_diacritics 2`): letters and
 * digits only, lower case, accents removed.
 */
function words(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Every word of the query starts some word of the name (FTS5 prefix query, AND-ed). */
export function matchesQuery(name: string, query: string[]): boolean {
  const have = words(name);
  return query.every((q) => have.some((w) => w.startsWith(q)));
}

/** The query's words, at most 8, as search() takes them; empty means no search at all. */
export function queryWords(q: string): string[] {
  return words(q).slice(0, 8);
}

/** The app's type filters, matched on kind and MIME type (same rules as D1's `TYPE_SQL`). */
export function matchesType(n: Pick<DriveNode, 'kind' | 'mime'>, type: DriveTypeFilter): boolean {
  const m = (n.mime ?? '').toLowerCase();
  switch (type) {
    case 'folder':
      return n.kind === 'folder';
    case 'image':
    case 'video':
    case 'audio':
      return m.startsWith(`${type}/`);
    case 'pdf':
      return m === 'application/pdf';
    case 'document':
      return (
        m.startsWith('text/') ||
        m.startsWith('application/vnd.') ||
        m === 'application/pdf' ||
        m === 'application/msword' ||
        m === 'application/rtf'
      );
    case 'archive':
      return /zip|rar|7z|tar|zstd/.test(m) || m === 'application/gzip';
  }
}

export const DRIVE_TYPE_FILTERS: readonly DriveTypeFilter[] = [
  'folder',
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'pdf',
];

export interface DriveTreeOptions {
  /** The index's user: owner and creator of everything in it. */
  ownerId: string;
  /** Trash retention, for purgeAt (trashed at + this many days). */
  trashDays: number;
  /** What the root folder is called (it isn't an entry; the app shows its own words for it). */
  rootName: string;
}

type SortValue = string | number;

/** Folders first, then the sort key, then the id: the order D1's listing used. */
function sortTuple(n: DriveNode, sort: DriveSort): [number, SortValue, string] {
  const key =
    sort === 'name'
      ? nameKey(n.name)
      : sort === 'updated'
        ? n.updatedAt
        : sort === 'size'
          ? n.size
          : (n.mime ?? '');
  return [n.kind === 'folder' ? 0 : 1, key, n.id];
}

function compareTuples(
  a: [number, SortValue, string],
  b: [number, SortValue, string],
  dir: 1 | -1,
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return (a[1] < b[1] ? -1 : 1) * dir;
  if (a[2] !== b[2]) return (a[2] < b[2] ? -1 : 1) * dir;
  return 0;
}

/** One personal index, ready to answer the explorer's questions. */
export class DriveTree {
  readonly rootId: string;
  readonly rev: number;
  private readonly rootCreated: number;
  private readonly byId = new Map<string, IndexEntry>();
  private readonly byNumber = new Map<number, IndexEntry>();
  private readonly kids = new Map<number, IndexEntry[]>();
  private readonly nodes = new Map<number, DriveNode>();

  constructor(
    head: IndexHead,
    entries: IndexEntry[],
    private readonly opts: DriveTreeOptions,
  ) {
    this.rootId = typeof head.root === 'string' ? head.root : '';
    this.rev = head.rev;
    this.rootCreated = typeof head.rootAt === 'number' ? head.rootAt * 1000 : 0;
    for (const e of entries) {
      this.byNumber.set(e.id, e);
      this.byId.set(DriveTree.idOf(e), e);
      const list = this.kids.get(e.parent);
      if (list) list.push(e);
      else this.kids.set(e.parent, [e]);
    }
  }

  /** The id the app and API use: the D1 id while there is one. */
  static idOf(e: IndexEntry): string {
    return e.legacy || String(e.id);
  }

  /** True when `id` is the root or an entry of this tree. */
  has(id: string): boolean {
    return Boolean(this.rootId) && (id === this.rootId || this.byId.has(id));
  }

  get size(): number {
    return this.byNumber.size;
  }

  private rootNode(): DriveNode {
    return {
      id: this.rootId,
      parentId: null,
      kind: 'folder',
      name: this.opts.rootName,
      size: 0,
      mime: null,
      status: 'ready',
      scanStatus: null,
      space: 'personal',
      ownerId: this.opts.ownerId,
      createdBy: this.opts.ownerId,
      familyCanEdit: false,
      starred: false,
      hasThumb: false,
      trashedAt: null,
      purgeAt: null,
      createdAt: this.rootCreated,
      updatedAt: this.rootCreated,
      clientModifiedAt: null,
      decor: null,
    };
  }

  /** A cover shows only when it is a ready file in this tree, not in the Trash, with a thumbnail. */
  private coverId(n: number): string | null {
    const c = n ? this.byNumber.get(n) : undefined;
    if (!c || c.kind !== 'file' || c.status !== 'ready' || c.trashedAt !== null || !c.thumb)
      return null;
    return DriveTree.idOf(c);
  }

  private toNode(e: IndexEntry): DriveNode {
    const cached = this.nodes.get(e.id);
    if (cached) return cached;
    const folder = e.kind === 'folder';
    const blocked = e.status === 'blocked';
    let decor: FolderDecor | null = null;
    if (folder && e.decor) {
      const color = e.decor.color && isFolderColor(e.decor.color) ? e.decor.color : null;
      const icon = e.decor.icon && isFolderIcon(e.decor.icon) ? e.decor.icon : null;
      const coverId = this.coverId(e.decor.cover);
      if (color || icon || coverId) decor = { color, icon, coverId };
    }
    const parent = e.parent ? this.byNumber.get(e.parent) : undefined;
    const node: DriveNode = {
      id: DriveTree.idOf(e),
      parentId: parent ? DriveTree.idOf(parent) : this.rootId,
      kind: e.kind,
      name: e.name,
      size: e.size,
      mime: e.mime || null,
      status: blocked ? 'rejected' : e.status === 'scanning' ? 'scanning' : 'ready',
      // The scan's details stay with the content (ADR-064); the index only knows the outcome.
      scanStatus: folder
        ? null
        : blocked
          ? 'infected'
          : e.status === 'scanning'
            ? 'pending'
            : 'clean',
      space: 'personal',
      ownerId: this.opts.ownerId,
      createdBy: this.opts.ownerId,
      familyCanEdit: false,
      starred: e.starred,
      hasThumb: e.thumb,
      trashedAt: e.trashedAt,
      purgeAt: e.trashedAt === null ? null : e.trashedAt + this.opts.trashDays * DAY_MS,
      createdAt: e.created,
      updatedAt: e.updated,
      clientModifiedAt: e.clientModified,
      decor,
    };
    this.nodes.set(e.id, node);
    return node;
  }

  /** The node, or null when it isn't in this tree. */
  node(id: string): DriveNode | null {
    if (!this.rootId) return null;
    if (id === this.rootId) return this.rootNode();
    const e = this.byId.get(id);
    return e ? this.toNode(e) : null;
  }

  private numberOf(id: string): number | null {
    if (id === this.rootId) return 0;
    const e = this.byId.get(id);
    return e ? e.id : null;
  }

  /** What is in a folder (not in the Trash), folders first, sorted. */
  children(folderId: string, sort: DriveSort = 'name', dir: 'asc' | 'desc' = 'asc'): DriveNode[] {
    const n = this.numberOf(folderId);
    if (n === null) return [];
    const d = dir === 'asc' ? 1 : -1;
    return (this.kids.get(n) ?? [])
      .filter((e) => e.trashedAt === null)
      .map((e) => this.toNode(e))
      .map((node) => ({ node, key: sortTuple(node, sort) }))
      .sort((a, b) => compareTuples(a.key, b.key, d))
      .map((x) => x.node);
  }

  /** A page of children after `cursor`, with the cursor for the next page (the API's paging). */
  page(
    folderId: string,
    o: DrivePageOptions = {},
  ): { items: DriveNode[]; nextCursor: string | null } {
    const sort = o.sort ?? 'name';
    const dir = o.dir ?? 'asc';
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 200);
    let all = this.children(folderId, sort, dir);
    if (o.cursor) {
      const after = decodeCursor(o.cursor);
      const d = dir === 'asc' ? 1 : -1;
      all = all.filter((n) => compareTuples(sortTuple(n, sort), after, d) > 0);
    }
    const items = all.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: all.length > limit && last ? encodeCursor(sortTuple(last, sort)) : null,
    };
  }

  /** From the root down to `id` itself; empty when it isn't in this tree. */
  path(id: string): DriveCrumb[] {
    if (!this.has(id)) return [];
    const out: DriveCrumb[] = [];
    let e = id === this.rootId ? undefined : this.byId.get(id);
    for (let depth = 0; e && depth < 200; depth++) {
      const folder = e.kind === 'folder' && e.decor;
      out.push({
        id: DriveTree.idOf(e),
        name: e.name,
        color: folder && e.decor!.color && isFolderColor(e.decor!.color) ? e.decor!.color : null,
        icon: folder && e.decor!.icon && isFolderIcon(e.decor!.icon) ? e.decor!.icon : null,
      });
      e = e.parent ? this.byNumber.get(e.parent) : undefined;
    }
    out.push({ id: this.rootId, name: this.opts.rootName, color: null, icon: null });
    return out.reverse();
  }

  private live(): IndexEntry[] {
    return [...this.byNumber.values()].filter((e) => e.trashedAt === null);
  }

  /** Name search over everything not in the Trash: folders first, then the newest. */
  search(o: DriveSearch): DriveNode[] {
    const query = queryWords(o.q);
    if (!query.length) return [];
    const limit = Math.min(o.limit ?? 50, 100);
    return this.live()
      .filter((e) => matchesQuery(e.name, query))
      .map((e) => this.toNode(e))
      .filter((n) => !o.type || matchesType(n, o.type))
      .filter((n) => !o.modifiedAfter || n.updatedAt >= o.modifiedAfter)
      .sort(searchOrder)
      .slice(0, limit);
  }

  /** Starred and not in the Trash, the most recently changed first (the index keeps no star time). */
  starred(limit = 500): DriveNode[] {
    return this.live()
      .filter((e) => e.starred)
      .map((e) => this.toNode(e))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }

  /** What the person put in the Trash (the top of each trashed subtree), the latest first. */
  trash(limit = 500): DriveNode[] {
    return [...this.byNumber.values()]
      .filter((e) => e.trashedAt !== null && e.trashRoot === e.id)
      .map((e) => this.toNode(e))
      .sort((a, b) => b.trashedAt! - a.trashedAt! || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
  }
}

/** Search results: folders first, then the most recently changed. */
export function searchOrder(a: DriveNode, b: DriveNode): number {
  return (
    (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) ||
    b.updatedAt - a.updatedAt ||
    (a.id < b.id ? 1 : -1)
  );
}

// The Drive index (ADR-064): one text object per user (`u/{userId}/index.txt`) or family
// (`f/{familyId}/index.txt`) holding the whole file tree. Line 1 is a JSON header; every other line
// is one entry, a JSON array whose columns the header names, with trailing default values left off.
// One entry per line lets the Worker change a few entries without parsing the rest (Workers Free
// gives a request 10 ms of CPU), and lets apps read everything with a single JSON.parse. Stored
// uncompressed: Cloudflare compresses it (brotli/gzip) on the way to the client.

export const INDEX_VERSION = 1;

/**
 * Column order of a version-1 row. Rare values go last so they can be trimmed.
 * id: entry number (never reused) · p: parent entry, 0 = root · k: 1 folder, 0 file · n: name ·
 * s: size in bytes · m: MIME type · b: content object under the index's folder (a number for new
 * uploads, a legacy key otherwise; 0 for folders) · x: the entry's id in D1 while Drive moves off it
 * (R3–R8, ADR-074; "" otherwise) · st: 1 while the scanner has not cleared it, 2 blocked (the
 * scanner or a takedown refused it) · c / u / cm: created, updated (0 = same as created), modified on the uploader's device, in unix
 * seconds · th: has a thumbnail · f: starred · t: moved to Trash at · tr: the entry the person
 * trashed · d: folder decoration [colour, icon, cover entry] · o / e / tb: family only: owner,
 * others may edit, trashed by (member positions in the header) · ex: goes to the Trash on this day
 * (D12, ADR-082; kept only here, not in D1) · vs: a file's earlier contents, newest first, each
 * [id, version number, size, saved at, content from, kept] (D1, ADR-084) · md: what a photo or video
 * says about itself, [taken at (unix s, 0 = not said), width, height, duration ms], present once read
 * (D8, ADR-091; kept only here).
 */
export const INDEX_COLUMNS = [
  'id',
  'p',
  'k',
  'n',
  's',
  'm',
  'b',
  'x',
  'st',
  'c',
  'u',
  'cm',
  'th',
  'f',
  't',
  'tr',
  'd',
  'o',
  'e',
  'tb',
  'ex',
  'vs',
  'md',
] as const;
type Column = (typeof INDEX_COLUMNS)[number];

export interface IndexHead {
  v: number;
  /** Raised by one on every write. */
  rev: number;
  /** The next entry number. */
  next: number;
  cols: string[];
  /** Family index: member user ids; owner/trashedBy are positions here, a leaver becomes null. */
  members?: Array<string | null>;
  [extra: string]: unknown;
}

export interface FolderDecorEntry {
  color: string | null;
  icon: string | null;
  cover: number;
}

export interface IndexEntry {
  id: number;
  parent: number;
  kind: 'file' | 'folder';
  name: string;
  size: number;
  mime: string;
  blob: number | string;
  /** The node's id in D1 while Drive still writes there (ADR-074); "" for entries born in the index. */
  legacy: string;
  status: 'ready' | 'scanning' | 'blocked';
  /** Times are in milliseconds here and whole seconds in the file. */
  created: number;
  updated: number;
  clientModified: number | null;
  thumb: boolean;
  starred: boolean;
  trashedAt: number | null;
  trashRoot: number;
  decor: FolderDecorEntry | null;
  owner: number;
  canEdit: boolean;
  trashedBy: number;
  /** D12: when it goes to the Trash by itself; the index is the only place that keeps it. */
  expiresAt: number | null;
  /** D1 (ADR-084): a file's earlier contents, newest first. */
  versions: IndexVersion[];
  /** D8 (ADR-091): read from a photo or video's own bytes; absent until read. */
  media?: IndexMedia | null;
}

export interface IndexMedia {
  /** ms; null when the file does not say when it was taken. */
  takenAt: number | null;
  width: number;
  height: number;
  durationMs: number;
}

export interface IndexVersion {
  /** The version's id (its D1 row while Drive moves off D1). */
  id: string;
  /** The file's version number this content had. */
  n: number;
  size: number;
  /** When it stopped being the file's content (ms here, seconds in the file). */
  savedAt: number;
  /** When that content was made. */
  contentAt: number;
  /** Kept past the count the person chose (still goes after the days limit). */
  kept: boolean;
}

type Cell = number | string | Array<string | number> | Array<Array<string | number>>;
type Row = Cell[];

export class IndexFormatError extends Error {
  constructor(message: string) {
    super(`drive index: ${message}`);
    this.name = 'IndexFormatError';
  }
}

const sec = (ms: number) => Math.floor(ms / 1000);

export function newIndexHead(): IndexHead {
  return { v: INDEX_VERSION, rev: 0, next: 1, cols: [...INDEX_COLUMNS] };
}

export function parseIndexHead(line: string): IndexHead {
  let head: IndexHead;
  try {
    head = JSON.parse(line) as IndexHead;
  } catch {
    throw new IndexFormatError('header is not JSON');
  }
  if (!head || typeof head !== 'object' || Array.isArray(head))
    throw new IndexFormatError('header is not an object');
  if (head.v !== INDEX_VERSION) throw new IndexFormatError(`unsupported version ${String(head.v)}`);
  if (!Number.isSafeInteger(head.rev) || !Number.isSafeInteger(head.next) || head.next < 1)
    throw new IndexFormatError('bad rev/next');
  if (!Array.isArray(head.cols) || head.cols[0] !== 'id')
    throw new IndexFormatError('bad column list');
  return head;
}

/** Where each known column sits in a row written under `cols` (-1: absent). */
export function columnMap(cols: readonly string[]): Record<Column, number> {
  return Object.fromEntries(INDEX_COLUMNS.map((c) => [c, cols.indexOf(c)])) as Record<
    Column,
    number
  >;
}

/** True when rows written under `cols` use the current layout. */
export function isCurrentLayout(cols: readonly string[]): boolean {
  return cols.length === INDEX_COLUMNS.length && INDEX_COLUMNS.every((c, i) => cols[i] === c);
}

export function entryToRow(e: IndexEntry): Row {
  const created = sec(e.created);
  const updated = sec(e.updated);
  const row: Row = [
    e.id,
    e.parent,
    e.kind === 'folder' ? 1 : 0,
    e.name,
    e.size,
    e.mime,
    e.blob,
    e.legacy,
    e.status === 'scanning' ? 1 : e.status === 'blocked' ? 2 : 0,
    created,
    updated === created ? 0 : updated,
    e.clientModified === null ? 0 : sec(e.clientModified),
    e.thumb ? 1 : 0,
    e.starred ? 1 : 0,
    e.trashedAt === null ? 0 : sec(e.trashedAt),
    e.trashRoot,
    e.decor ? [e.decor.color ?? '', e.decor.icon ?? '', e.decor.cover] : 0,
    e.owner,
    e.canEdit ? 1 : 0,
    e.trashedBy,
    e.expiresAt === null ? 0 : sec(e.expiresAt),
    e.versions.length
      ? e.versions.map((v) => [v.id, v.n, v.size, sec(v.savedAt), sec(v.contentAt), v.kept ? 1 : 0])
      : 0,
    e.media
      ? [
          e.media.takenAt === null ? 0 : sec(e.media.takenAt),
          e.media.width,
          e.media.height,
          e.media.durationMs,
        ]
      : 0,
  ];
  let end = row.length;
  while (end > 4 && (row[end - 1] === 0 || row[end - 1] === '')) end--;
  return row.slice(0, end);
}

export function entryLine(e: IndexEntry): string {
  return JSON.stringify(entryToRow(e));
}

function int(v: unknown, what: string, min = 0): number {
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min)
    throw new IndexFormatError(`bad ${what}`);
  return v;
}

export function rowToEntry(row: unknown, map: Record<Column, number>): IndexEntry {
  if (!Array.isArray(row)) throw new IndexFormatError('row is not an array');
  const at = (c: Column): unknown => (map[c] < 0 ? undefined : row[map[c]]);
  const id = int(at('id'), 'id', 1);
  const name = at('n');
  if (typeof name !== 'string' || !name) throw new IndexFormatError(`bad name for ${id}`);
  const created = int(at('c'), 'created') * 1000;
  const updated = int(at('u'), 'updated') * 1000;
  const blob = at('b') ?? 0;
  if (typeof blob !== 'string' && (typeof blob !== 'number' || !Number.isSafeInteger(blob)))
    throw new IndexFormatError(`bad blob for ${id}`);
  const mime = at('m') ?? '';
  if (typeof mime !== 'string') throw new IndexFormatError(`bad mime for ${id}`);
  const legacy = at('x') ?? '';
  if (typeof legacy !== 'string') throw new IndexFormatError(`bad legacy id for ${id}`);
  const st = at('st');
  const d = at('d') ?? 0;
  let decor: FolderDecorEntry | null = null;
  if (Array.isArray(d)) {
    const [color, icon, cover] = d as unknown[];
    decor = {
      color: typeof color === 'string' && color ? color : null,
      icon: typeof icon === 'string' && icon ? icon : null,
      cover: typeof cover === 'number' && Number.isSafeInteger(cover) ? cover : 0,
    };
  } else if (d !== 0) throw new IndexFormatError(`bad decoration for ${id}`);
  const cm = int(at('cm'), 'clientModified');
  const t = int(at('t'), 'trashedAt');
  const ex = int(at('ex'), 'expiresAt');
  const vs = at('vs') ?? 0;
  const versions: IndexVersion[] = [];
  if (Array.isArray(vs)) {
    for (const v of vs as unknown[]) {
      if (!Array.isArray(v) || typeof v[0] !== 'string')
        throw new IndexFormatError(`bad version for ${id}`);
      versions.push({
        id: v[0],
        n: int(v[1], 'version number'),
        size: int(v[2], 'version size'),
        savedAt: int(v[3], 'version saved') * 1000,
        contentAt: int(v[4], 'version content') * 1000,
        kept: v[5] === 1,
      });
    }
  } else if (vs !== 0) throw new IndexFormatError(`bad versions for ${id}`);
  const md = at('md') ?? 0;
  let media: IndexMedia | null = null;
  if (Array.isArray(md)) {
    const [tk, w, h, du] = md as unknown[];
    media = {
      takenAt: int(tk, 'taken') ? int(tk, 'taken') * 1000 : null,
      width: int(w, 'width'),
      height: int(h, 'height'),
      durationMs: int(du, 'duration'),
    };
  } else if (md !== 0) throw new IndexFormatError(`bad media for ${id}`);
  return {
    id,
    parent: int(at('p'), 'parent'),
    kind: at('k') === 1 ? 'folder' : 'file',
    name,
    size: int(at('s'), 'size'),
    mime,
    blob,
    legacy,
    status: st === 1 ? 'scanning' : st === 2 ? 'blocked' : 'ready',
    created,
    updated: updated || created,
    clientModified: cm ? cm * 1000 : null,
    thumb: at('th') === 1,
    starred: at('f') === 1,
    trashedAt: t ? t * 1000 : null,
    trashRoot: int(at('tr'), 'trashRoot'),
    decor,
    owner: int(at('o'), 'owner'),
    canEdit: at('e') === 1,
    trashedBy: int(at('tb'), 'trashedBy'),
    expiresAt: ex ? ex * 1000 : null,
    versions,
    ...(media ? { media } : {}),
  };
}

/** Rows of an index body (every line ends with "\n"), parsed in one go. */
export function parseRows(body: string): unknown[] {
  if (!body) return [];
  if (!body.endsWith('\n')) throw new IndexFormatError('truncated');
  try {
    return JSON.parse(`[${body.slice(0, -1).replaceAll('\n', ',')}]`) as unknown[];
  } catch {
    throw new IndexFormatError('rows are not JSON');
  }
}

/** The whole index: what web, app, and desktop read first. */
export function parseIndex(text: string): { head: IndexHead; entries: IndexEntry[] } {
  const nl = text.indexOf('\n');
  if (nl < 0) throw new IndexFormatError('no header');
  const head = parseIndexHead(text.slice(0, nl));
  const map = columnMap(head.cols);
  const entries = parseRows(text.slice(nl + 1)).map((r) => rowToEntry(r, map));
  return { head, entries };
}

export function serializeIndex(head: IndexHead, entries: Iterable<IndexEntry>): string {
  let out = `${JSON.stringify({ ...head, cols: [...INDEX_COLUMNS] })}\n`;
  for (const e of entries) out += `${entryLine(e)}\n`;
  return out;
}

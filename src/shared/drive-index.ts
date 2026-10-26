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
 * uploads, a legacy key otherwise; 0 for folders) · st: 1 while the scanner has not cleared it ·
 * c / u / cm: created, updated (0 = same as created), modified on the uploader's device, in unix
 * seconds · th: has a thumbnail · f: starred · t: moved to Trash at · tr: the entry the person
 * trashed · d: folder decoration [colour, icon, cover entry] · o / e / tb: family only: owner,
 * others may edit, trashed by (member positions in the header).
 */
export const INDEX_COLUMNS = [
  'id',
  'p',
  'k',
  'n',
  's',
  'm',
  'b',
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
  status: 'ready' | 'scanning';
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
}

type Cell = number | string | Array<string | number>;
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
    e.status === 'scanning' ? 1 : 0,
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
  return {
    id,
    parent: int(at('p'), 'parent'),
    kind: at('k') === 1 ? 'folder' : 'file',
    name,
    size: int(at('s'), 'size'),
    mime,
    blob,
    status: at('st') === 1 ? 'scanning' : 'ready',
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

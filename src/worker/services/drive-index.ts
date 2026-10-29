// Reading and changing a Drive index in R2 (ADR-064). The format lives in shared/drive-index.ts.
//
// IndexDoc edits the text line by line: get/set/delete touch only the lines they need, so a rename
// in a 10,000-entry index costs well under a millisecond instead of a full parse and re-serialize.
// changeIndex writes with R2's etag condition (If-None-Match: * for a new index), and on a lost race
// reads again and re-runs the change. R2 takes one write per second per key and answers 429 beyond
// that, so busy callers wait and retry too; callers that change many entries should do it in one
// changeIndex call.
import {
  columnMap,
  entryLine,
  IndexFormatError,
  isCurrentLayout,
  newIndexHead,
  parseIndexHead,
  parseRows,
  rowToEntry,
  serializeIndex,
  type IndexEntry,
  type IndexHead,
} from '../../shared/drive-index';
import { AppError } from '../lib/errors';

export type IndexOwner = { user: string } | { family: string };

export function indexKey(owner: IndexOwner): string {
  return 'user' in owner ? `u/${owner.user}/index.txt` : `f/${owner.family}/index.txt`;
}

/** Up to this many changed entries are spliced in place; more, and the body is walked once. */
const SPLICE_MAX = 8;

export class IndexDoc {
  private readonly map: ReturnType<typeof columnMap>;
  private readonly changes = new Map<number, IndexEntry | null>();
  private headChanged = false;

  private constructor(
    readonly head: IndexHead,
    /** Everything after the header, starting with its "\n"; every row line ends with "\n". */
    private readonly body: string,
    private readonly source: string | null,
  ) {
    this.map = columnMap(head.cols);
  }

  static empty(): IndexDoc {
    return new IndexDoc(newIndexHead(), '\n', null);
  }

  static parse(text: string): IndexDoc {
    const nl = text.indexOf('\n');
    if (nl < 0) throw new IndexFormatError('no header');
    if (!text.endsWith('\n')) throw new IndexFormatError('truncated');
    return new IndexDoc(parseIndexHead(text.slice(0, nl)), text.slice(nl), text);
  }

  get changed(): boolean {
    return this.headChanged || this.changes.size > 0;
  }

  /** A fresh entry number. */
  allocate(): number {
    this.headChanged = true;
    return this.head.next++;
  }

  /** Where entry `id`'s line sits in the body: [start of line, its "\n"], or null. */
  private locate(id: number): [number, number] | null {
    const at = this.body.indexOf(`\n[${id},`);
    if (at < 0) return null;
    return [at + 1, this.body.indexOf('\n', at + 1)];
  }

  get(id: number): IndexEntry | null {
    if (this.changes.has(id)) {
      const e = this.changes.get(id)!;
      return e && copy(e);
    }
    const span = this.locate(id);
    if (!span) return null;
    return this.decode(this.body.slice(span[0], span[1]));
  }

  set(entry: IndexEntry): void {
    if (!Number.isSafeInteger(entry.id) || entry.id < 1 || entry.id >= this.head.next)
      throw new Error(`drive index: entry ${entry.id} was not allocated`);
    if (!entry.name) throw new Error('drive index: an entry needs a name');
    this.changes.set(entry.id, copy(entry));
  }

  delete(id: number): void {
    if (this.locate(id)) this.changes.set(id, null);
    else this.changes.delete(id);
  }

  /** Sets a header field other than the format's own (v, rev, next, cols); unchanged values are no write. */
  setMeta(key: string, value: unknown): void {
    if (key === 'v' || key === 'rev' || key === 'next' || key === 'cols')
      throw new Error(`drive index: ${key} is not metadata`);
    if (JSON.stringify(this.head[key]) === JSON.stringify(value)) return;
    if (value === undefined) delete this.head[key];
    else this.head[key] = value;
    this.headChanged = true;
  }

  /** Every entry (a full parse; use parents() when only the tree shape is needed). */
  entries(): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const row of parseRows(this.body.slice(1))) {
      const e = rowToEntry(row, this.map);
      if (!this.changes.has(e.id)) out.push(e);
    }
    for (const e of this.changes.values()) if (e) out.push(copy(e));
    return out;
  }

  /** Entry → parent for every entry, read from the first two numbers of each line. */
  parents(): Map<number, number> {
    const out = new Map<number, number>();
    if (!this.fastLayout()) {
      for (const e of this.entries()) out.set(e.id, e.parent);
      return out;
    }
    const b = this.body;
    let i = 1;
    while (i < b.length) {
      const c1 = b.indexOf(',', i);
      const c2 = b.indexOf(',', c1 + 1);
      out.set(Number(b.slice(i + 1, c1)), Number(b.slice(c1 + 1, c2)));
      i = b.indexOf('\n', c2) + 1;
    }
    for (const [id, e] of this.changes) {
      if (e) out.set(id, e.parent);
      else out.delete(id);
    }
    return out;
  }

  /** The text to store. Raises `rev` when anything changed. */
  toText(): string {
    if (!this.changed && this.source !== null) return this.source;
    this.head.rev++;
    if (!this.fastLayout()) return serializeIndex(this.head, this.entries());
    const head = JSON.stringify(this.head);
    return this.changes.size <= SPLICE_MAX ? head + this.splice() : head + this.walk();
  }

  private fastLayout(): boolean {
    return isCurrentLayout(this.head.cols);
  }

  private decode(line: string): IndexEntry {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new IndexFormatError('row is not JSON');
    }
    return rowToEntry(row, this.map);
  }

  private splice(): string {
    const edits: Array<[number, number, string]> = [];
    let added = '';
    for (const [id, e] of this.changes) {
      const span = this.locate(id);
      if (span) edits.push([span[0], span[1] + 1, e ? `${entryLine(e)}\n` : '']);
      else if (e) added += `${entryLine(e)}\n`;
    }
    edits.sort((a, b) => a[0] - b[0]);
    let out = '';
    let from = 0;
    for (const [start, end, text] of edits) {
      out += this.body.slice(from, start) + text;
      from = end;
    }
    return out + this.body.slice(from) + added;
  }

  private walk(): string {
    const b = this.body;
    const pending = new Map(this.changes);
    const parts: string[] = ['\n'];
    let i = 1;
    while (i < b.length) {
      const end = b.indexOf('\n', i);
      const id = Number(b.slice(i + 1, b.indexOf(',', i)));
      if (pending.has(id)) {
        const e = pending.get(id);
        pending.delete(id);
        if (e) parts.push(`${entryLine(e)}\n`);
      } else parts.push(b.slice(i, end + 1));
      i = end + 1;
    }
    for (const e of pending.values()) if (e) parts.push(`${entryLine(e)}\n`);
    return parts.join('');
  }
}

function copy(e: IndexEntry): IndexEntry {
  return { ...e, decor: e.decor && { ...e.decor } };
}

export async function readIndex(
  bucket: R2Bucket,
  owner: IndexOwner,
): Promise<{ doc: IndexDoc; etag: string | null }> {
  const obj = await bucket.get(indexKey(owner));
  if (!obj) return { doc: IndexDoc.empty(), etag: null };
  const text = await obj.text();
  try {
    return { doc: IndexDoc.parse(text), etag: obj.etag };
  } catch (e) {
    // Never fall back to an empty index here: the next write would erase the tree.
    if (e instanceof IndexFormatError)
      throw new AppError('INTERNAL', e.message, { index: indexKey(owner) });
    throw e;
  }
}

const isRateLimited = (e: unknown) =>
  e instanceof Error && /\(10058\)|TooManyRequests/.test(e.message);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ChangeOptions {
  attempts?: number;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Read the index, run `change` on it, and write it back if anything changed, retrying on a lost
 * race or R2's per-key write limit. `change` may run more than once, each time on a fresh read, so
 * it must not have side effects outside the doc (send notifications after this returns).
 */
export async function changeIndex<T>(
  bucket: R2Bucket,
  owner: IndexOwner,
  change: (doc: IndexDoc) => T | Promise<T>,
  { attempts = 12, wait = sleep }: ChangeOptions = {},
): Promise<T> {
  const key = indexKey(owner);
  for (let attempt = 1; ; attempt++) {
    const { doc, etag } = await readIndex(bucket, owner);
    const result = await change(doc);
    if (!doc.changed) return result;
    let limited = false;
    try {
      const put = await bucket.put(key, doc.toText(), {
        httpMetadata: { contentType: 'text/plain; charset=utf-8', cacheControl: 'no-store' },
        onlyIf: etag ? { etagMatches: etag } : new Headers({ 'if-none-match': '*' }),
      });
      if (put) return result;
    } catch (e) {
      if (!isRateLimited(e)) throw e;
      limited = true;
    }
    if (attempt >= attempts)
      throw new AppError('INDEX_BUSY', 'The file list is busy, try again', { index: key });
    const base = limited ? 1000 : Math.min(150 * attempt, 1000);
    await wait(base + Math.floor(Math.random() * 250));
  }
}

// W6 (ADR-100): the live copies of a Space's files being edited together, inside the Space's room.
// Protocol and limits in shared/space-doc.ts. Plain code over the room's SQL, so it is tested in
// Node with the rest of the room (ADR-001).
import {
  MAX_DOC_DATA,
  MAX_OPEN_DOCS,
  type DocClientFrame,
  type DocKind,
  type DocPerson,
  type DocServerFrame,
} from '../../shared/space-doc';
import type { ServerFrame } from '../../shared/space-room';
import type { Conn, RoomSql, SqlValue } from './space-room-core';

export const DOC_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS docs (
     node TEXT PRIMARY KEY, kind TEXT NOT NULL, seeded INTEGER NOT NULL DEFAULT 0,
     seeder TEXT, saved_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS doc_items (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, data TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS doc_items_node_idx ON doc_items (node, seq)',
];

const NODE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const KINDS: readonly DocKind[] = ['doc', 'sheet'];

export class DocError extends Error {
  constructor(
    readonly code: 'bad_frame' | 'too_long' | 'not_found' | 'forbidden' | 'readonly',
    message: string,
  ) {
    super(message);
  }
}

export interface DocHost {
  sql: RoomSql;
  now(): number;
  connections(): Conn[];
  send(conn: Conn, frame: ServerFrame | DocServerFrame): void;
}

interface DocRow {
  node: string;
  kind: DocKind;
  seeded: number;
  seeder: string | null;
  saved_seq: number;
}

const num = (v: SqlValue | undefined) => (typeof v === 'number' ? v : Number(v ?? 0));

export class RoomDocs {
  constructor(private host: DocHost) {}

  private get sql() {
    return this.host.sql;
  }

  private row(node: string): DocRow | null {
    const r = this.sql.exec('SELECT * FROM docs WHERE node = ?', node)[0];
    if (!r) return null;
    return {
      node: String(r.node),
      kind: String(r.kind) as DocKind,
      seeded: num(r.seeded),
      seeder: typeof r.seeder === 'string' ? r.seeder : null,
      saved_seq: num(r.saved_seq),
    };
  }

  /** Connections with this file open, oldest first: the first writer among them saves. */
  private holders(node: string): Conn[] {
    return this.host
      .connections()
      .filter((c) => c.state.docs?.[node] !== undefined)
      .sort(
        (a, b) =>
          a.state.docs![node]! - b.state.docs![node]! || a.state.id.localeCompare(b.state.id),
      );
  }

  private saverOf(node: string): Conn | null {
    return this.holders(node).find((c) => !c.state.readonly && c.state.role !== 'guest') ?? null;
  }

  private people(node: string): DocPerson[] {
    const seen = new Map<string, DocPerson>();
    for (const c of this.holders(node))
      if (!seen.has(c.state.user))
        seen.set(c.state.user, { user: c.state.user, name: c.state.name });
    return [...seen.values()];
  }

  private lastSeq(node: string): number {
    return num(
      this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM doc_items WHERE node = ?', node)[0]?.s,
    );
  }

  private open(conn: Conn, node: unknown): DocRow {
    if (typeof node !== 'string' || conn.state.docs?.[node] === undefined)
      throw new DocError('not_found', 'open the file first');
    const row = this.row(node);
    if (!row) throw new DocError('not_found', 'no such file open');
    return row;
  }

  private data(v: unknown): string {
    if (typeof v !== 'string' || !v) throw new DocError('bad_frame', 'data is a string');
    if (v.length > MAX_DOC_DATA) throw new DocError('too_long', 'too large to edit together');
    return v;
  }

  private writer(conn: Conn): void {
    if (conn.state.readonly) throw new DocError('readonly', 'this Space is read-only');
  }

  /** Every frame whose `t` starts with `doc.`. */
  handle(conn: Conn, f: DocClientFrame): void {
    switch (f.t) {
      case 'doc.join':
        return this.join(conn, f.node, f.kind);
      case 'doc.leave':
        return this.leave(conn, f.node);
      case 'doc.seed':
        return this.seed(conn, f);
      case 'doc.push':
        return this.push(conn, f);
      case 'doc.aware':
        return this.aware(conn, f);
      case 'doc.saved':
        return this.saved(conn, f);
      case 'doc.compact':
        return this.compact(conn, f);
      default:
        throw new DocError('bad_frame', 'unknown frame');
    }
  }

  private join(conn: Conn, node: unknown, kind: unknown): void {
    if (typeof node !== 'string' || !NODE_ID.test(node)) throw new DocError('bad_frame', 'node');
    if (!KINDS.includes(kind as DocKind)) throw new DocError('bad_frame', 'kind');
    // Guests do not see the Space's files (ADR-099), so they have nothing to open here.
    if (conn.state.role === 'guest') throw new DocError('forbidden', 'guests cannot open files');
    const docs = conn.state.docs ?? {};
    if (docs[node] === undefined && Object.keys(docs).length >= MAX_OPEN_DOCS)
      throw new DocError('bad_frame', `at most ${MAX_OPEN_DOCS} files open at once`);
    let row = this.row(node);
    if (row && row.kind !== kind)
      throw new DocError('bad_frame', 'the file is open as another kind');
    const now = this.host.now();
    if (!row) {
      this.sql.exec(
        'INSERT INTO docs (node, kind, seeded, seeder, saved_seq, created_at) VALUES (?, ?, 0, NULL, 0, ?)',
        node,
        kind as DocKind,
        now,
      );
      row = this.row(node)!;
    }
    conn.state.docs = { ...docs, [node]: docs[node] ?? now };
    conn.save();
    // The snapshot comes from one person: whoever was asked and is still here, else this one.
    let seed = false;
    if (!row.seeded && !conn.state.readonly) {
      const asked = row.seeder && this.holders(node).some((c) => c.state.id === row!.seeder);
      if (!asked || row.seeder === conn.state.id) {
        this.sql.exec('UPDATE docs SET seeder = ? WHERE node = ?', conn.state.id, node);
        seed = true;
      }
    }
    const items = this.sql
      .exec('SELECT seq, data FROM doc_items WHERE node = ? ORDER BY seq', node)
      .map((r) => ({ seq: num(r.seq), data: String(r.data) }));
    const people = this.people(node);
    this.host.send(conn, {
      t: 'doc.state',
      node,
      kind: row.kind,
      items,
      seed,
      saver: this.saverOf(node)?.socket === conn.socket,
      people,
    });
    for (const c of this.holders(node))
      if (c.socket !== conn.socket) this.host.send(c, { t: 'doc.people', node, people });
  }

  private seed(conn: Conn, f: Extract<DocClientFrame, { t: 'doc.seed' }>): void {
    const row = this.open(conn, f.node);
    this.writer(conn);
    if (row.seeded || row.seeder !== conn.state.id)
      throw new DocError('forbidden', 'someone else starts this file');
    const data = this.data(f.data);
    this.sql.exec('INSERT INTO doc_items (node, data) VALUES (?, ?)', row.node, data);
    this.sql.exec('UPDATE docs SET seeded = 1, seeder = NULL WHERE node = ?', row.node);
    const item = { seq: this.lastSeq(row.node), data };
    for (const c of this.holders(row.node))
      if (c.socket !== conn.socket)
        this.host.send(c, { t: 'doc.push', node: row.node, item, user: conn.state.user });
    this.host.send(conn, { t: 'doc.ack', node: row.node, seq: item.seq, nonce: 'seed' });
  }

  private push(conn: Conn, f: Extract<DocClientFrame, { t: 'doc.push' }>): void {
    const row = this.open(conn, f.node);
    this.writer(conn);
    if (!row.seeded) throw new DocError('not_found', 'the file has not started yet');
    const data = this.data(f.data);
    const nonce = typeof f.nonce === 'string' ? f.nonce.slice(0, 64) : '';
    this.sql.exec('INSERT INTO doc_items (node, data) VALUES (?, ?)', row.node, data);
    const item = { seq: this.lastSeq(row.node), data };
    this.host.send(conn, { t: 'doc.ack', node: row.node, seq: item.seq, nonce });
    for (const c of this.holders(row.node))
      if (c.socket !== conn.socket)
        this.host.send(c, { t: 'doc.push', node: row.node, item, user: conn.state.user });
  }

  private aware(conn: Conn, f: Extract<DocClientFrame, { t: 'doc.aware' }>): void {
    const row = this.open(conn, f.node);
    if (typeof f.data !== 'string' || f.data.length > 8_000)
      throw new DocError('bad_frame', 'awareness is a short string');
    for (const c of this.holders(row.node))
      if (c.socket !== conn.socket)
        this.host.send(c, { t: 'doc.aware', node: row.node, data: f.data, user: conn.state.user });
  }

  private saved(conn: Conn, f: Extract<DocClientFrame, { t: 'doc.saved' }>): void {
    const row = this.open(conn, f.node);
    this.writer(conn);
    const upto = Math.min(
      typeof f.upto === 'number' && Number.isSafeInteger(f.upto) ? f.upto : 0,
      this.lastSeq(row.node),
    );
    this.sql.exec('UPDATE docs SET saved_seq = max(saved_seq, ?) WHERE node = ?', upto, row.node);
  }

  /** The saver's whole copy stands for everything up to `upto`; the rest stays after it. */
  private compact(conn: Conn, f: Extract<DocClientFrame, { t: 'doc.compact' }>): void {
    const row = this.open(conn, f.node);
    this.writer(conn);
    if (this.saverOf(row.node)?.socket !== conn.socket)
      throw new DocError('forbidden', 'only the saver compacts');
    const data = this.data(f.data);
    const upto = typeof f.upto === 'number' && Number.isSafeInteger(f.upto) ? f.upto : -1;
    const has = this.sql.exec('SELECT 1 FROM doc_items WHERE node = ? AND seq = ?', row.node, upto);
    if (!has.length) throw new DocError('bad_frame', 'upto is one of the file’s changes');
    this.sql.exec('DELETE FROM doc_items WHERE node = ? AND seq <= ?', row.node, upto);
    this.sql.exec('INSERT INTO doc_items (seq, node, data) VALUES (?, ?, ?)', upto, row.node, data);
  }

  private leave(conn: Conn, node: unknown): void {
    if (typeof node !== 'string' || conn.state.docs?.[node] === undefined) return;
    this.drop(conn, [node]);
  }

  /** A connection closed: every file it had open loses it. */
  closed(conn: Conn): void {
    const nodes = Object.keys(conn.state.docs ?? {});
    if (nodes.length) this.drop(conn, nodes);
  }

  private drop(conn: Conn, nodes: string[]): void {
    const docs = { ...(conn.state.docs ?? {}) };
    const savers = new Map(nodes.map((n) => [n, this.saverOf(n)?.socket ?? null]));
    for (const n of nodes) delete docs[n];
    conn.state.docs = docs;
    conn.save();
    for (const node of nodes) {
      const left = this.holders(node).filter((c) => c.socket !== conn.socket);
      const row = this.row(node);
      if (!row) continue;
      if (!left.length) {
        // Nobody has it open: if the file holds everything, the live copy goes.
        if (row.saved_seq >= this.lastSeq(node) || !row.seeded) {
          this.sql.exec('DELETE FROM doc_items WHERE node = ?', node);
          this.sql.exec('DELETE FROM docs WHERE node = ?', node);
        }
        continue;
      }
      const people = this.people(node).filter(
        (p) => p.user !== conn.state.user || left.some((c) => c.state.user === p.user),
      );
      for (const c of left) this.host.send(c, { t: 'doc.people', node, people });
      const next = left.find((c) => !c.state.readonly && c.state.role !== 'guest');
      if (savers.get(node) === conn.socket && next) this.host.send(next, { t: 'doc.saver', node });
      if (!row.seeded && row.seeder === conn.state.id && next) {
        this.sql.exec('UPDATE docs SET seeder = ? WHERE node = ?', next.state.id, node);
        this.host.send(next, { t: 'doc.seedme', node });
      }
    }
  }

  /** The Space's role for someone changed to guest: they lose every file they had open. */
  dropUser(user: string): void {
    for (const c of this.host.connections())
      if (c.state.user === user && c.state.docs && Object.keys(c.state.docs).length)
        this.drop(c, Object.keys(c.state.docs));
  }
}

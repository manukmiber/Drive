// W3/W4 (ADR-096): a Space's live room — chat topics, threads, mentions, read marks, who is here, and
// document locks — as a plain class over a small SQL interface and the open sockets. The Durable
// Object (space-room.ts) only wraps it, so all of this runs and is tested in Node (ADR-001: no workerd
// here). Everything a connection is (who, role, rate window) lives in its socket's attachment, since
// a hibernated room keeps its sockets but not its memory.
//
// Who the person is and their role are decided by the Worker before the socket reaches the room
// (routes/space-live.ts); the room trusts them, and is told when they change (setMember).
import { ulid } from '../lib/ids';
import {
  HISTORY_PAGE,
  MAX_FRAME_CHARS,
  MAX_LOCKS_PER_CONNECTION,
  MENTION,
  ROOM_CLOSE,
  ROOM_RATE,
  TYPING_EVERY_MS,
  type LockDto,
  type MessageDto,
  type RoomErrorCode,
  type RoomRole,
  type ServerFrame,
  type TopicDto,
} from '../../shared/space-room';

export type SqlValue = string | number | null;

export interface RoomSql {
  /** One statement; the rows it returns (none for a write). */
  exec(sql: string, ...params: SqlValue[]): Record<string, SqlValue>[];
}

export interface ConnState {
  id: string;
  user: string;
  name: string;
  role: RoomRole;
  readonly: boolean;
  window: number;
  count: number;
  typingAt: number;
}

export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Conn {
  socket: RoomSocket;
  state: ConnState;
  /** Writes `state` back to where it is kept (the socket's attachment). */
  save(): void;
}

export interface RoomHost {
  sql: RoomSql;
  now(): number;
  /** Every open connection, the one being handled included. */
  connections(): Conn[];
}

export interface RoomLimits {
  maxChars: number;
  maxTopics: number;
}

/** What the room asks its wrapper to do after a frame: notices for people who are not here. */
export interface MentionEffect {
  kind: 'mention';
  users: string[];
  topic: { id: string; name: string; guests: boolean };
  message: { id: string; excerpt: string };
  by: { id: string; name: string };
}

export type Effect = MentionEffect;

interface TopicRow {
  id: string;
  name: string;
  guests: number;
  created_by: string | null;
  created_at: number;
}

const MAX_TOPIC_NAME = 60;
const MAX_MENTIONS = 20;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS topics (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'channel', node_id TEXT,
     guests INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, topic TEXT NOT NULL, thread TEXT,
     author TEXT, at INTEGER NOT NULL, edited_at INTEGER, text TEXT, mentions TEXT)`,
  'CREATE INDEX IF NOT EXISTS messages_topic_idx ON messages (topic, thread, seq)',
  'CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread) WHERE thread IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS messages_author_idx ON messages (author)',
  `CREATE TABLE IF NOT EXISTS reads (
     user_id TEXT NOT NULL, topic TEXT NOT NULL, upto INTEGER NOT NULL, PRIMARY KEY (user_id, topic))`,
  'CREATE TABLE IF NOT EXISTS people (user_id TEXT PRIMARY KEY, name TEXT NOT NULL, seen_at INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS locks (
     node TEXT PRIMARY KEY, user_id TEXT NOT NULL, conn TEXT NOT NULL, since INTEGER NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
];

const MESSAGE_SELECT = `SELECT m.seq, m.id, m.topic, m.thread, m.author, p.name AS author_name, m.at,
    m.edited_at, m.text, m.mentions,
    CASE WHEN m.thread IS NULL THEN (SELECT COUNT(*) FROM messages r WHERE r.thread = m.id) ELSE 0 END AS replies
  FROM messages m LEFT JOIN people p ON p.user_id = m.author`;

const str = (v: SqlValue | undefined): string | null => (typeof v === 'string' ? v : null);
const num = (v: SqlValue | undefined): number => (typeof v === 'number' ? v : Number(v ?? 0));

function messageDto(r: Record<string, SqlValue>): MessageDto {
  const mentions = str(r.mentions);
  return {
    id: String(r.id),
    seq: num(r.seq),
    topic: String(r.topic),
    thread: str(r.thread),
    author: str(r.author),
    authorName: str(r.author_name),
    at: num(r.at),
    editedAt: r.edited_at === null ? null : num(r.edited_at),
    text: str(r.text),
    mentions: mentions ? (JSON.parse(mentions) as string[]) : [],
    replies: num(r.replies),
  };
}

/** Mentions in a text, without repeats or the author, at most MAX_MENTIONS. */
export function mentionsIn(text: string, author: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    if (m[1] && m[1] !== author) out.add(m[1]);
    if (out.size >= MAX_MENTIONS) break;
  }
  return [...out];
}

/** A topic's name as people type it: no leading '#', single spaces, 1 to 60 characters. */
export function topicName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.replace(/^#+/, '').trim().replace(/\s+/g, ' ');
  return name && name.length <= MAX_TOPIC_NAME ? name : null;
}

const ROLES: readonly RoomRole[] = ['admin', 'member', 'guest'];

/**
 * The Worker's calls (`/internal/<call>`, services/space-room.ts), shared by the Durable Object and
 * the dev rooms. Null for a call that does not exist. `purge` asks the caller to drop the storage.
 */
export function internalCall(
  core: SpaceRoomCore,
  call: string,
  body: Record<string, unknown>,
): { result: unknown; purge?: true } | null {
  switch (call) {
    case 'member': {
      const role = ROLES.includes(body.role as RoomRole) ? (body.role as RoomRole) : null;
      core.setMember(
        String(body.user),
        role,
        typeof body.readonly === 'boolean' ? body.readonly : undefined,
      );
      return { result: { ok: true } };
    }
    case 'readonly':
      core.setReadonly(body.readonly === true);
      return { result: { ok: true } };
    case 'forget':
      return { result: { removed: core.forgetUser(String(body.user)) } };
    case 'files':
      core.filesChanged(Array.isArray(body.ids) ? body.ids.map(String) : []);
      return { result: { ok: true } };
    case 'export':
      return { result: { messages: core.exportUser(String(body.user)) } };
    case 'purge':
      core.closeAll();
      return { result: { ok: true }, purge: true };
    default:
      return null;
  }
}

/** A connection's starting state, from what the Worker checked (routes/space-live.ts). */
export function connState(headers: Headers, now: number, id: string): ConnState | null {
  const user = headers.get('x-zk-user');
  const role = headers.get('x-zk-role') as RoomRole | null;
  if (!user || !role || !ROLES.includes(role)) return null;
  return {
    id,
    user,
    name: (headers.get('x-zk-name') ?? '').slice(0, 100),
    role,
    readonly: headers.get('x-zk-readonly') === '1',
    window: now,
    count: 0,
    typingAt: 0,
  };
}

/** The first topic's name, in the language of whoever opens the room first. */
export const defaultTopicName = (headers: Headers): string =>
  headers.get('x-zk-lang') === 'en' ? 'general' : 'umum';

class FrameError extends Error {
  constructor(
    readonly code: RoomErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type Frame = Record<string, unknown>;

export class SpaceRoomCore {
  constructor(
    private host: RoomHost,
    private limits: RoomLimits,
  ) {}

  setLimits(limits: RoomLimits): void {
    this.limits = limits;
  }

  private get sql(): RoomSql {
    return this.host.sql;
  }

  migrate(): void {
    for (const s of SCHEMA) this.sql.exec(s);
  }

  /** A small fact the room keeps about itself (which Space it is). */
  meta(key: string): string | null {
    return str(this.sql.exec('SELECT v FROM meta WHERE k = ?', key)[0]?.v);
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
      key,
      value,
    );
  }

  /* ------------------------------------------------------- connections -- */

  /**
   * A new connection: the topics it may see, who is here, and the locks; others hear it arrived.
   * True on the person's first visit to this room ever (the wrapper notes it in space_seen).
   */
  open(conn: Conn, defaultTopic: string): boolean {
    const now = this.host.now();
    const first = !this.sql.exec('SELECT 1 FROM people WHERE user_id = ?', conn.state.user).length;
    if (!this.sql.exec('SELECT 1 FROM topics LIMIT 1').length)
      this.sql.exec(
        'INSERT INTO topics (id, name, guests, created_by, created_at) VALUES (?, ?, 1, NULL, ?)',
        ulid(now),
        defaultTopic,
        now,
      );
    this.sql.exec(
      `INSERT INTO people (user_id, name, seen_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at`,
      conn.state.user,
      conn.state.name,
      now,
    );
    this.hello(conn);
    const others = this.host.connections().filter((c) => c.socket !== conn.socket);
    if (!others.some((c) => c.state.user === conn.state.user))
      this.broadcast(
        { t: 'presence', user: conn.state.user, online: true },
        (c) => c.state.role !== 'guest' && c.socket !== conn.socket,
      );
    return first;
  }

  private hello(conn: Conn): void {
    const guest = conn.state.role === 'guest';
    const online = guest
      ? []
      : [...new Set(this.host.connections().map((c) => c.state.user))].filter(
          (u) => u !== conn.state.user,
        );
    this.send(conn, {
      t: 'hello',
      me: conn.state.user,
      role: conn.state.role,
      readonly: conn.state.readonly,
      topics: this.topicsFor(conn.state.user, conn.state.role),
      online,
      locks: this.locks(),
    });
  }

  /** A connection went (closed, errored): its locks go, and if it was the person's last, so do they. */
  closed(conn: Conn): void {
    for (const r of this.sql.exec('SELECT node FROM locks WHERE conn = ?', conn.state.id)) {
      this.sql.exec('DELETE FROM locks WHERE node = ?', String(r.node));
      this.broadcast({ t: 'unlock', node: String(r.node) }, (c) => c.socket !== conn.socket);
    }
    const others = this.host.connections().filter((c) => c.socket !== conn.socket);
    if (!others.some((c) => c.state.user === conn.state.user))
      this.broadcast(
        { t: 'presence', user: conn.state.user, online: false },
        (c) => c.state.role !== 'guest' && c.socket !== conn.socket,
      );
  }

  /** One frame from a connection. Returns what the wrapper still has to do (notices). */
  message(conn: Conn, raw: string): Effect[] {
    if (!this.pace(conn)) return [];
    let frame: Frame;
    try {
      if (raw.length > MAX_FRAME_CHARS) throw new FrameError('too_long', 'frame too large');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new FrameError('bad_frame', 'a frame is a JSON object');
      frame = parsed as Frame;
    } catch (e) {
      this.fail(conn, e instanceof FrameError ? e : new FrameError('bad_frame', 'not JSON'));
      return [];
    }
    try {
      return this.handle(conn, frame);
    } catch (e) {
      if (e instanceof FrameError) {
        this.fail(conn, e, typeof frame.nonce === 'string' ? frame.nonce : undefined);
        return [];
      }
      throw e;
    }
  }

  /** The rate window: too many frames are refused, and twice too many close the connection. */
  private pace(conn: Conn): boolean {
    const now = this.host.now();
    const s = conn.state;
    if (now - s.window >= ROOM_RATE.windowMs) {
      s.window = now;
      s.count = 0;
    }
    s.count += 1;
    conn.save();
    if (s.count > ROOM_RATE.frames * 2) {
      conn.socket.close(ROOM_CLOSE.abuse, 'too many frames');
      return false;
    }
    if (s.count > ROOM_RATE.frames) {
      this.fail(conn, new FrameError('rate_limited', 'slow down'));
      return false;
    }
    return true;
  }

  private handle(conn: Conn, f: Frame): Effect[] {
    switch (f.t) {
      case 'send':
        return this.post(conn, f);
      case 'edit':
        this.edit(conn, f);
        return [];
      case 'delete':
        this.remove(conn, f);
        return [];
      case 'read':
        this.read(conn, f);
        return [];
      case 'typing':
        this.typing(conn, f);
        return [];
      case 'history':
        this.history(conn, f);
        return [];
      case 'topic.create':
        this.createTopic(conn, f);
        return [];
      case 'topic.update':
        this.updateTopic(conn, f);
        return [];
      case 'topic.remove':
        this.removeTopic(conn, f);
        return [];
      case 'lock':
        this.lock(conn, f);
        return [];
      case 'unlock':
        this.unlock(conn, f);
        return [];
      default:
        throw new FrameError('bad_frame', 'unknown frame');
    }
  }

  /* ------------------------------------------------------------ topics -- */

  private topicsFor(user: string, role: RoomRole): TopicDto[] {
    return this.sql
      .exec(
        `SELECT t.id, t.name, t.guests, t.created_by, t.created_at,
           (SELECT COALESCE(MAX(seq), 0) FROM messages WHERE topic = t.id) AS last,
           (SELECT COUNT(*) FROM messages m WHERE m.topic = t.id AND m.text IS NOT NULL
              AND (m.author IS NULL OR m.author != ?)
              AND m.seq > COALESCE((SELECT upto FROM reads WHERE user_id = ? AND topic = t.id), 0)) AS unread
         FROM topics t ${role === 'guest' ? 'WHERE t.guests = 1' : ''} ORDER BY t.created_at, t.id`,
        user,
        user,
      )
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        guests: num(r.guests) === 1,
        createdBy: str(r.created_by),
        createdAt: num(r.created_at),
        unread: num(r.unread),
        last: num(r.last),
      }));
  }

  private topicDto(t: TopicRow, unread = 0): TopicDto {
    const last = this.sql.exec(
      'SELECT COALESCE(MAX(seq), 0) AS last FROM messages WHERE topic = ?',
      t.id,
    )[0];
    return {
      id: t.id,
      name: t.name,
      guests: t.guests === 1,
      createdBy: t.created_by,
      createdAt: t.created_at,
      unread,
      last: num(last?.last),
    };
  }

  private topic(id: unknown): TopicRow | null {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    const r = this.sql.exec('SELECT * FROM topics WHERE id = ?', id)[0];
    return r
      ? {
          id: String(r.id),
          name: String(r.name),
          guests: num(r.guests),
          created_by: str(r.created_by),
          created_at: num(r.created_at),
        }
      : null;
  }

  private static sees(role: RoomRole, t: TopicRow): boolean {
    return role !== 'guest' || t.guests === 1;
  }

  /** The topic, if this connection may see it; otherwise it does not exist for them. */
  private visibleTopic(conn: Conn, id: unknown): TopicRow {
    const t = this.topic(id);
    if (!t || !SpaceRoomCore.sees(conn.state.role, t))
      throw new FrameError('not_found', 'no such topic');
    return t;
  }

  private writable(conn: Conn): void {
    if (conn.state.readonly) throw new FrameError('readonly', 'this Space is read-only');
  }

  private nameFree(name: string, except?: string): void {
    const clash = this.sql.exec(
      'SELECT id FROM topics WHERE lower(name) = lower(?) AND id != ?',
      name,
      except ?? '',
    );
    if (clash.length) throw new FrameError('bad_frame', 'a topic has that name already');
  }

  private createTopic(conn: Conn, f: Frame): void {
    this.writable(conn);
    if (conn.state.role === 'guest') throw new FrameError('forbidden', 'guests cannot add topics');
    const name = topicName(f.name);
    if (!name) throw new FrameError('bad_frame', 'a topic name is 1 to 60 characters');
    const n = num(this.sql.exec('SELECT COUNT(*) AS n FROM topics')[0]?.n);
    if (n >= this.limits.maxTopics)
      throw new FrameError('topics_full', `at most ${this.limits.maxTopics} topics`);
    this.nameFree(name);
    const now = this.host.now();
    const t: TopicRow = {
      id: ulid(now),
      name,
      guests: f.guests === true ? 1 : 0,
      created_by: conn.state.user,
      created_at: now,
    };
    this.sql.exec(
      'INSERT INTO topics (id, name, guests, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      t.id,
      t.name,
      t.guests,
      t.created_by,
      t.created_at,
    );
    const dto = this.topicDto(t);
    const nonce = typeof f.nonce === 'string' ? f.nonce : undefined;
    for (const c of this.host.connections())
      if (SpaceRoomCore.sees(c.state.role, t))
        this.send(c, {
          t: 'topic',
          topic: dto,
          ...(c.socket === conn.socket && nonce ? { nonce } : {}),
        });
  }

  /** A topic's name, or whether guests are in it. The Space's admins or the topic's maker. */
  private updateTopic(conn: Conn, f: Frame): void {
    this.writable(conn);
    const t = this.visibleTopic(conn, f.id);
    if (conn.state.role !== 'admin' && t.created_by !== conn.state.user)
      throw new FrameError('forbidden', 'only admins and who made the topic');
    const next = { ...t };
    if (f.name !== undefined) {
      const name = topicName(f.name);
      if (!name) throw new FrameError('bad_frame', 'a topic name is 1 to 60 characters');
      this.nameFree(name, t.id);
      next.name = name;
    }
    if (typeof f.guests === 'boolean') next.guests = f.guests ? 1 : 0;
    this.sql.exec(
      'UPDATE topics SET name = ?, guests = ? WHERE id = ?',
      next.name,
      next.guests,
      t.id,
    );
    const dto = this.topicDto(next);
    for (const c of this.host.connections()) {
      if (SpaceRoomCore.sees(c.state.role, next)) this.send(c, { t: 'topic', topic: dto });
      else if (SpaceRoomCore.sees(c.state.role, t)) this.send(c, { t: 'topic.removed', id: t.id });
    }
  }

  /** A topic and everything said in it go for good. The Space's admins or the topic's maker. */
  private removeTopic(conn: Conn, f: Frame): void {
    this.writable(conn);
    const t = this.visibleTopic(conn, f.id);
    if (conn.state.role !== 'admin' && t.created_by !== conn.state.user)
      throw new FrameError('forbidden', 'only admins and who made the topic');
    this.sql.exec('DELETE FROM messages WHERE topic = ?', t.id);
    this.sql.exec('DELETE FROM reads WHERE topic = ?', t.id);
    this.sql.exec('DELETE FROM topics WHERE id = ?', t.id);
    this.broadcast({ t: 'topic.removed', id: t.id }, (c) => SpaceRoomCore.sees(c.state.role, t));
  }

  /* ---------------------------------------------------------- messages -- */

  private messageRow(id: unknown): Record<string, SqlValue> | null {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    return this.sql.exec(`${MESSAGE_SELECT} WHERE m.id = ?`, id)[0] ?? null;
  }

  private text(v: unknown): string {
    if (typeof v !== 'string' || !v.trim()) throw new FrameError('bad_frame', 'a message has text');
    if (v.length > this.limits.maxChars)
      throw new FrameError('too_long', `at most ${this.limits.maxChars} characters`);
    return v;
  }

  private post(conn: Conn, f: Frame): Effect[] {
    this.writable(conn);
    const t = this.visibleTopic(conn, f.topic);
    const text = this.text(f.text);
    let thread: string | null = null;
    if (f.thread !== undefined && f.thread !== null) {
      const root = this.messageRow(f.thread);
      if (!root || root.topic !== t.id || root.thread !== null)
        throw new FrameError('not_found', 'no such message to answer');
      thread = String(root.id);
    }
    const now = this.host.now();
    const id = ulid(now);
    const mentions = mentionsIn(text, conn.state.user);
    this.sql.exec(
      `INSERT INTO messages (id, topic, thread, author, at, text, mentions) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      t.id,
      thread,
      conn.state.user,
      now,
      text,
      mentions.length ? JSON.stringify(mentions) : null,
    );
    const row = this.messageRow(id)!;
    const message = messageDto(row);
    this.markRead(conn.state.user, t.id, message.seq);
    const nonce = typeof f.nonce === 'string' ? f.nonce : undefined;
    for (const c of this.host.connections())
      if (SpaceRoomCore.sees(c.state.role, t))
        this.send(c, {
          t: 'msg',
          message,
          ...(c.socket === conn.socket && nonce ? { nonce } : {}),
        });

    const here = new Set(this.host.connections().map((c) => c.state.user));
    const away = mentions.filter((u) => !here.has(u));
    if (!away.length) return [];
    return [
      {
        kind: 'mention',
        users: away,
        topic: { id: t.id, name: t.name, guests: t.guests === 1 },
        message: { id, excerpt: text.replace(MENTION, '@').slice(0, 140) },
        by: { id: conn.state.user, name: conn.state.name },
      },
    ];
  }

  private edit(conn: Conn, f: Frame): void {
    this.writable(conn);
    const row = this.messageRow(f.id);
    const t = row ? this.topic(row.topic) : null;
    if (!row || !t || !SpaceRoomCore.sees(conn.state.role, t))
      throw new FrameError('not_found', 'no such message');
    if (row.author !== conn.state.user)
      throw new FrameError('forbidden', 'only who wrote it can change it');
    if (row.text === null) throw new FrameError('not_found', 'the message was deleted');
    const text = this.text(f.text);
    const now = this.host.now();
    const mentions = mentionsIn(text, conn.state.user);
    this.sql.exec(
      'UPDATE messages SET text = ?, edited_at = ?, mentions = ? WHERE id = ?',
      text,
      now,
      mentions.length ? JSON.stringify(mentions) : null,
      String(row.id),
    );
    this.broadcast({ t: 'edited', id: String(row.id), text, editedAt: now }, (c) =>
      SpaceRoomCore.sees(c.state.role, t),
    );
  }

  /** Who wrote it, or a Space admin. The text goes; the row stays for the replies around it. */
  private remove(conn: Conn, f: Frame): void {
    this.writable(conn);
    const row = this.messageRow(f.id);
    const t = row ? this.topic(row.topic) : null;
    if (!row || !t || !SpaceRoomCore.sees(conn.state.role, t))
      throw new FrameError('not_found', 'no such message');
    if (row.author !== conn.state.user && conn.state.role !== 'admin')
      throw new FrameError('forbidden', 'only who wrote it or an admin');
    this.sql.exec(
      'UPDATE messages SET text = NULL, mentions = NULL, edited_at = ? WHERE id = ?',
      this.host.now(),
      String(row.id),
    );
    this.broadcast({ t: 'deleted', ids: [String(row.id)] }, (c) =>
      SpaceRoomCore.sees(c.state.role, t),
    );
  }

  private markRead(user: string, topic: string, upto: number): void {
    this.sql.exec(
      `INSERT INTO reads (user_id, topic, upto) VALUES (?, ?, ?)
       ON CONFLICT (user_id, topic) DO UPDATE SET upto = max(upto, excluded.upto)`,
      user,
      topic,
      upto,
    );
  }

  private read(conn: Conn, f: Frame): void {
    const t = this.visibleTopic(conn, f.topic);
    const last = num(
      this.sql.exec('SELECT COALESCE(MAX(seq), 0) AS last FROM messages WHERE topic = ?', t.id)[0]
        ?.last,
    );
    const upto = typeof f.upto === 'number' && Number.isSafeInteger(f.upto) ? f.upto : -1;
    if (upto < 0) throw new FrameError('bad_frame', 'upto is a message order number');
    this.markRead(conn.state.user, t.id, Math.min(upto, last));
    const now = num(
      this.sql.exec(
        'SELECT upto FROM reads WHERE user_id = ? AND topic = ?',
        conn.state.user,
        t.id,
      )[0]?.upto,
    );
    this.broadcast(
      { t: 'read', topic: t.id, upto: now },
      (c) => c.state.user === conn.state.user && c.socket !== conn.socket,
    );
  }

  private typing(conn: Conn, f: Frame): void {
    if (conn.state.readonly) return;
    const t = this.visibleTopic(conn, f.topic);
    const now = this.host.now();
    if (now - conn.state.typingAt < TYPING_EVERY_MS) return;
    conn.state.typingAt = now;
    conn.save();
    this.broadcast(
      { t: 'typing', topic: t.id, user: conn.state.user, name: conn.state.name },
      (c) => c.state.user !== conn.state.user && SpaceRoomCore.sees(c.state.role, t),
    );
  }

  private history(conn: Conn, f: Frame): void {
    const t = this.visibleTopic(conn, f.topic);
    let thread: string | null = null;
    if (f.thread !== undefined && f.thread !== null) {
      const root = this.messageRow(f.thread);
      if (!root || root.topic !== t.id) throw new FrameError('not_found', 'no such thread');
      thread = String(root.id);
    }
    const limit =
      typeof f.limit === 'number' && Number.isSafeInteger(f.limit)
        ? Math.max(1, Math.min(HISTORY_PAGE, f.limit))
        : HISTORY_PAGE;
    const before =
      typeof f.before === 'number' && Number.isSafeInteger(f.before)
        ? f.before
        : Number.MAX_SAFE_INTEGER;
    const rows = this.sql.exec(
      `${MESSAGE_SELECT} WHERE m.topic = ? AND ${thread ? 'm.thread = ?' : 'm.thread IS NULL AND ? IS NULL'}
         AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`,
      t.id,
      thread,
      before,
      limit + 1,
    );
    const more = rows.length > limit;
    this.send(conn, {
      t: 'history',
      topic: t.id,
      thread,
      messages: rows.slice(0, limit).reverse().map(messageDto),
      more,
    });
  }

  /* ------------------------------------------------------------- locks -- */

  private locks(): LockDto[] {
    return this.sql
      .exec(
        `SELECT l.node, l.user_id, l.since, p.name FROM locks l LEFT JOIN people p ON p.user_id = l.user_id
         ORDER BY l.since`,
      )
      .map((r) => ({
        node: String(r.node),
        user: String(r.user_id),
        name: str(r.name) ?? '',
        since: num(r.since),
      }));
  }

  /** W5: one person edits a document at a time; the others see who, and read meanwhile. */
  private lock(conn: Conn, f: Frame): void {
    this.writable(conn);
    if (typeof f.node !== 'string' || !NODE_ID.test(f.node))
      throw new FrameError('bad_frame', 'node is an item id');
    const held = this.sql.exec(
      `SELECT l.user_id, p.name FROM locks l LEFT JOIN people p ON p.user_id = l.user_id WHERE l.node = ?`,
      f.node,
    )[0];
    if (held && held.user_id !== conn.state.user)
      throw new FrameError('locked', `${str(held.name) ?? 'someone'} is editing it`);
    if (held) return;
    const mine = num(
      this.sql.exec('SELECT COUNT(*) AS n FROM locks WHERE conn = ?', conn.state.id)[0]?.n,
    );
    if (mine >= MAX_LOCKS_PER_CONNECTION)
      throw new FrameError('bad_frame', 'too many open documents');
    const now = this.host.now();
    this.sql.exec(
      'INSERT INTO locks (node, user_id, conn, since) VALUES (?, ?, ?, ?)',
      f.node,
      conn.state.user,
      conn.state.id,
      now,
    );
    this.broadcast(
      {
        t: 'lock',
        lock: { node: f.node, user: conn.state.user, name: conn.state.name, since: now },
      },
      () => true,
    );
  }

  private unlock(conn: Conn, f: Frame): void {
    if (typeof f.node !== 'string' || !NODE_ID.test(f.node))
      throw new FrameError('bad_frame', 'node is an item id');
    const held = this.sql.exec('SELECT user_id FROM locks WHERE node = ?', f.node)[0];
    if (!held || held.user_id !== conn.state.user) return;
    this.sql.exec('DELETE FROM locks WHERE node = ?', f.node);
    this.broadcast({ t: 'unlock', node: f.node }, () => true);
  }

  /* ----------------------------------------------- told by the Worker -- */

  /** Someone's role changed, or they are out of the Space (null): their connections follow. */
  setMember(user: string, role: RoomRole | null, readonly?: boolean): void {
    for (const c of this.host.connections()) {
      if (c.state.user !== user) continue;
      if (!role) {
        c.socket.close(ROOM_CLOSE.removed, 'removed from the Space');
        continue;
      }
      c.state.role = role;
      if (readonly !== undefined) c.state.readonly = readonly;
      c.save();
      this.send(c, { t: 'role', role, readonly: c.state.readonly });
      this.hello(c);
    }
  }

  /** The team became read-only, or active again (W2). */
  setReadonly(readonly: boolean): void {
    for (const c of this.host.connections()) {
      c.state.readonly = readonly;
      c.save();
      this.send(c, { t: 'role', role: c.state.role, readonly });
    }
  }

  /**
   * T15: a deleted account's messages go. A message others answered stays as an empty row without
   * an author, so the thread keeps its place; the rest are deleted outright.
   */
  forgetUser(user: string): number {
    const ids = this.sql
      .exec('SELECT id FROM messages WHERE author = ?', user)
      .map((r) => String(r.id));
    this.sql.exec(
      `DELETE FROM messages WHERE author = ?
         AND (thread IS NOT NULL OR NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread = messages.id))`,
      user,
    );
    this.sql.exec(
      'UPDATE messages SET author = NULL, text = NULL, mentions = NULL WHERE author = ?',
      user,
    );
    this.sql.exec('DELETE FROM reads WHERE user_id = ?', user);
    this.sql.exec('DELETE FROM people WHERE user_id = ?', user);
    for (const r of this.sql.exec('SELECT node FROM locks WHERE user_id = ?', user)) {
      this.sql.exec('DELETE FROM locks WHERE node = ?', String(r.node));
      this.broadcast({ t: 'unlock', node: String(r.node) }, () => true);
    }
    for (let i = 0; i < ids.length; i += 500)
      this.broadcast({ t: 'deleted', ids: ids.slice(i, i + 500) }, (c) => c.state.user !== user);
    this.setMember(user, null);
    return ids.length;
  }

  /** Items in the Space changed: whoever has its files open refetches them. */
  filesChanged(ids: string[]): void {
    this.broadcast({ t: 'files', ids: ids.slice(0, 1000) }, (c) => c.state.role !== 'guest');
  }

  /** The Space is gone: everyone is told, and the wrapper deletes the storage. */
  closeAll(): void {
    for (const c of this.host.connections()) c.socket.close(ROOM_CLOSE.gone, 'the Space is gone');
  }

  /** Data export: what this person wrote here, oldest first. */
  exportUser(
    user: string,
  ): Array<{ topic: string; at: number; text: string; thread: string | null }> {
    return this.sql
      .exec(
        `SELECT t.name AS topic, m.at, m.text, m.thread FROM messages m JOIN topics t ON t.id = m.topic
         WHERE m.author = ? AND m.text IS NOT NULL ORDER BY m.seq LIMIT 100000`,
        user,
      )
      .map((r) => ({
        topic: String(r.topic),
        at: num(r.at),
        text: String(r.text),
        thread: str(r.thread),
      }));
  }

  /* ------------------------------------------------------------ helpers -- */

  private send(conn: Conn, frame: ServerFrame): void {
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {
      // A socket that is closing: its close handler runs next.
    }
  }

  private broadcast(frame: ServerFrame, to: (c: Conn) => boolean): void {
    const data = JSON.stringify(frame);
    for (const c of this.host.connections()) {
      if (!to(c)) continue;
      try {
        c.socket.send(data);
      } catch {
        // As in send().
      }
    }
  }

  private fail(conn: Conn, e: FrameError, nonce?: string): void {
    this.send(conn, { t: 'error', code: e.code, message: e.message, ...(nonce ? { nonce } : {}) });
  }
}

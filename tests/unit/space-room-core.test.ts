// W3/W4 (ADR-096): a Space's live room, on node:sqlite — topics and who sees them, messages,
// threads, read marks, typing, pacing, locks, and what the Worker tells it.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '../../src/shared/space-room';
import {
  SpaceRoomCore,
  type Conn,
  type ConnState,
  type RoomSocket,
  type SqlValue,
} from '../../src/worker/rooms/space-room-core';

type FrameOf<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;

class Sock implements RoomSocket {
  frames: ServerFrame[] = [];
  closed: number | null = null;
  constructor(
    private room: Room,
    readonly state: ConnState,
  ) {}
  send(d: string) {
    if (this.closed === null) this.frames.push(JSON.parse(d) as ServerFrame);
  }
  close(code?: number) {
    if (this.closed !== null) return;
    this.closed = code ?? 1000;
    this.room.drop(this);
  }
  say(f: unknown) {
    return this.room.core.message(this.room.conn(this), JSON.stringify(f));
  }
  of<T extends ServerFrame['t']>(t: T): FrameOf<T>[] {
    return this.frames.filter((f): f is FrameOf<T> => f.t === t);
  }
  last<T extends ServerFrame['t']>(t: T): FrameOf<T> {
    const f = this.of(t).at(-1);
    if (!f) throw new Error(`no ${t} frame`);
    return f;
  }
}

class Room {
  db = new DatabaseSync(':memory:');
  socks: Sock[] = [];
  clock = 1_000_000;
  core: SpaceRoomCore;
  constructor(limits = { maxChars: 100, maxTopics: 10 }) {
    this.core = new SpaceRoomCore(
      {
        sql: { exec: (q, ...p) => this.db.prepare(q).all(...p) as Record<string, SqlValue>[] },
        now: () => this.clock,
        connections: () => this.socks.map((s) => this.conn(s)),
      },
      limits,
    );
    this.core.migrate();
  }
  conn(s: Sock): Conn {
    return { socket: s, state: s.state, save: () => {} };
  }
  join(user: string, role: 'admin' | 'member' | 'guest', readonly = false): Sock {
    const s = new Sock(this, {
      id: `${user}-${this.socks.length}`,
      user,
      name: user.toUpperCase(),
      role,
      readonly,
      window: this.clock,
      count: 0,
      typingAt: 0,
    });
    this.socks.push(s);
    this.core.open(this.conn(s), 'umum');
    return s;
  }
  drop(s: Sock) {
    this.core.closed(this.conn(s));
    this.socks = this.socks.filter((x) => x !== s);
  }
  count(table: string, where = '1') {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }
    ).n;
  }
}

const general = (s: Sock) => s.last('hello').topics[0]!.id;

describe('Space room (ADR-096)', () => {
  it('opens with #umum for everyone, keeps team topics from guests, and no presence for them', () => {
    const r = new Room();
    const admin = r.join('a', 'admin');
    const guest = r.join('g', 'guest');
    expect(admin.last('hello').topics.map((t) => [t.name, t.guests])).toEqual([['umum', true]]);
    expect(guest.last('hello').online).toEqual([]);
    expect(admin.last('presence')).toEqual({ t: 'presence', user: 'g', online: true });
    expect(guest.of('presence')).toEqual([]);

    admin.say({ t: 'topic.create', name: '#Internal', nonce: 'n1' });
    const created = admin.last('topic');
    expect(created).toMatchObject({ nonce: 'n1', topic: { name: 'Internal', guests: false } });
    expect(guest.of('topic')).toEqual([]);
    guest.say({ t: 'send', topic: created.topic.id, text: 'halo' });
    expect(guest.last('error').code).toBe('not_found');
    guest.say({ t: 'topic.create', name: 'punya tamu' });
    expect(guest.last('error').code).toBe('forbidden');

    // Opening it to guests shows it to them; closing it takes it away again.
    admin.say({ t: 'topic.update', id: created.topic.id, guests: true });
    expect(guest.last('topic').topic.id).toBe(created.topic.id);
    admin.say({ t: 'topic.update', id: created.topic.id, guests: false });
    expect(guest.last('topic.removed').id).toBe(created.topic.id);
    admin.say({ t: 'topic.create', name: 'internal' });
    expect(admin.last('error').message).toMatch(/name already/);
  });

  it('posts, edits and deletes with the right people, and tells whoever sees the topic', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const b = r.join('b', 'member');
    const admin = r.join('x', 'admin');
    const topic = general(a);
    a.say({ t: 'send', topic, text: 'pertama', nonce: 'k' });
    const msg = a.last('msg');
    expect(msg.nonce).toBe('k');
    expect(b.last('msg')).toEqual({ t: 'msg', message: msg.message });
    expect(msg.message).toMatchObject({ author: 'a', authorName: 'A', text: 'pertama', seq: 1 });

    b.say({ t: 'edit', id: msg.message.id, text: 'diubah' });
    expect(b.last('error').code).toBe('forbidden');
    a.say({ t: 'edit', id: msg.message.id, text: 'diubah' });
    expect(b.last('edited')).toMatchObject({ id: msg.message.id, text: 'diubah' });
    b.say({ t: 'delete', id: msg.message.id });
    expect(b.last('error').code).toBe('forbidden');
    admin.say({ t: 'delete', id: msg.message.id });
    expect(a.last('deleted').ids).toEqual([msg.message.id]);
    a.say({ t: 'edit', id: msg.message.id, text: 'lagi' });
    expect(a.last('error').code).toBe('not_found');

    a.say({ t: 'send', topic, text: 'x'.repeat(101) });
    expect(a.last('error').code).toBe('too_long');
    a.say({ t: 'send', topic, text: '   ' });
    expect(a.last('error').code).toBe('bad_frame');
    a.say('not json at all');
    expect(a.last('error').code).toBe('bad_frame');
  });

  it('keeps threads one level deep and pages history newest first', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const topic = general(a);
    for (let i = 1; i <= 5; i++) a.say({ t: 'send', topic, text: `pesan ${i}` });
    const root = a.of('msg')[0]!.message;
    a.say({ t: 'send', topic, text: 'jawaban', thread: root.id });
    const reply = a.last('msg').message;
    expect(reply.thread).toBe(root.id);
    a.say({ t: 'send', topic, text: 'jawaban dari jawaban', thread: reply.id });
    expect(a.last('error').code).toBe('not_found');

    a.say({ t: 'history', topic, limit: 2 });
    let h = a.last('history');
    expect(h.messages.map((m) => m.text)).toEqual(['pesan 4', 'pesan 5']);
    expect(h.more).toBe(true);
    a.say({ t: 'history', topic, limit: 10, before: h.messages[0]!.seq });
    h = a.last('history');
    expect(h.messages.map((m) => [m.text, m.replies])).toEqual([
      ['pesan 1', 1],
      ['pesan 2', 0],
      ['pesan 3', 0],
    ]);
    expect(h.more).toBe(false);
    a.say({ t: 'history', topic, thread: root.id });
    expect(a.last('history').messages.map((m) => m.text)).toEqual(['jawaban']);
  });

  it('counts unread per person and carries read marks to their other devices', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const topic = general(a);
    a.say({ t: 'send', topic, text: 'satu' });
    a.say({ t: 'send', topic, text: 'dua' });
    const phone = r.join('b', 'member');
    expect(phone.last('hello').topics[0]).toMatchObject({ unread: 2, last: 2 });
    // Their own message is never unread to them.
    expect(r.join('a', 'member').last('hello').topics[0]!.unread).toBe(0);
    const laptop = r.join('b', 'member');
    phone.say({ t: 'read', topic, upto: 1 });
    expect(laptop.last('read')).toEqual({ t: 'read', topic, upto: 1 });
    phone.say({ t: 'read', topic, upto: 99 });
    expect(r.join('b', 'member').last('hello').topics[0]!.unread).toBe(0);
  });

  it('passes typing on at most every three seconds, and slows down a flood', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const b = r.join('b', 'member');
    const topic = general(a);
    a.say({ t: 'typing', topic });
    a.say({ t: 'typing', topic });
    expect(b.of('typing')).toHaveLength(1);
    expect(a.of('typing')).toHaveLength(0);
    r.clock += 3_000;
    a.say({ t: 'typing', topic });
    expect(b.of('typing')).toHaveLength(2);

    for (let i = 0; i < 40; i++) a.say({ t: 'read', topic, upto: 0 });
    expect(a.last('error').code).toBe('rate_limited');
    for (let i = 0; i < 40; i++) a.say({ t: 'read', topic, upto: 0 });
    expect(a.closed).toBe(1008);
  });

  it('locks a document for one person and frees it when their connection goes', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const b = r.join('b', 'member');
    a.say({ t: 'lock', node: 'NODE1' });
    expect(b.last('lock').lock).toMatchObject({ node: 'NODE1', user: 'a', name: 'A' });
    b.say({ t: 'lock', node: 'NODE1' });
    expect(b.last('error')).toMatchObject({ code: 'locked', message: 'A is editing it' });
    expect(
      r
        .join('c', 'member')
        .last('hello')
        .locks.map((l) => l.node),
    ).toEqual(['NODE1']);
    b.say({ t: 'unlock', node: 'NODE1' });
    expect(r.count('locks')).toBe(1);
    a.close();
    expect(b.last('unlock')).toEqual({ t: 'unlock', node: 'NODE1' });
    expect(b.last('presence')).toEqual({ t: 'presence', user: 'a', online: false });
    expect(r.count('locks')).toBe(0);
  });

  it('follows role changes, and closes someone taken out of the Space', () => {
    const r = new Room();
    const admin = r.join('a', 'admin');
    admin.say({ t: 'topic.create', name: 'tim' });
    const m = r.join('m', 'member');
    expect(m.last('hello').topics).toHaveLength(2);
    r.core.setMember('m', 'guest');
    expect(m.last('role')).toEqual({ t: 'role', role: 'guest', readonly: false });
    expect(m.last('hello').topics.map((t) => t.name)).toEqual(['umum']);
    r.core.setMember('m', null);
    expect(m.closed).toBe(4403);

    r.core.setReadonly(true);
    admin.say({ t: 'send', topic: general(admin), text: 'tidak bisa' });
    expect(admin.last('error').code).toBe('readonly');
    admin.say({ t: 'history', topic: general(admin) });
    expect(admin.last('history').messages).toEqual([]);
  });

  it('asks for notices only for mentioned people who are not in the room', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    r.join('b', 'member');
    const topic = general(a);
    expect(a.say({ t: 'send', topic, text: 'halo <@b> dan <@c> dan <@a> <@c>' })).toEqual([
      {
        kind: 'mention',
        users: ['c'],
        topic: { id: topic, name: 'umum', guests: true },
        message: { id: a.last('msg').message.id, excerpt: 'halo @ dan @ dan @ @' },
        by: { id: 'a', name: 'A' },
      },
    ]);
    expect(a.last('msg').message.mentions).toEqual(['b', 'c']);
  });

  it('forgets a deleted account: its lone messages go, answered ones stay empty', () => {
    const r = new Room();
    const a = r.join('a', 'member');
    const b = r.join('b', 'member');
    const topic = general(a);
    a.say({ t: 'send', topic, text: 'akar' });
    const root = a.last('msg').message;
    a.say({ t: 'send', topic, text: 'sendirian' });
    const lone = a.last('msg').message;
    b.say({ t: 'send', topic, text: 'jawaban b', thread: root.id });
    a.say({ t: 'lock', node: 'DOC' });

    expect(r.core.exportUser('a').map((m) => m.text)).toEqual(['akar', 'sendirian']);
    expect(r.core.forgetUser('a')).toBe(2);
    expect(a.closed).toBe(4403);
    expect(b.last('deleted').ids.sort()).toEqual([root.id, lone.id].sort());
    expect(b.last('unlock').node).toBe('DOC');
    b.say({ t: 'history', topic });
    expect(b.last('history').messages).toEqual([
      expect.objectContaining({
        id: root.id,
        author: null,
        authorName: null,
        text: null,
        replies: 1,
      }),
    ]);
    b.say({ t: 'history', topic, thread: root.id });
    expect(b.last('history').messages.map((m) => m.text)).toEqual(['jawaban b']);
    expect(r.count('people', "user_id = 'a'")).toBe(0);
    expect(r.count('reads', "user_id = 'a'")).toBe(0);
  });

  it('holds so many topics, and a topic removed takes its messages', () => {
    const r = new Room({ maxChars: 100, maxTopics: 2 });
    const a = r.join('a', 'admin');
    const m = r.join('m', 'member');
    m.say({ t: 'topic.create', name: 'proyek' });
    const t = m.last('topic').topic;
    m.say({ t: 'topic.create', name: 'lagi' });
    expect(m.last('error').code).toBe('topics_full');
    m.say({ t: 'send', topic: t.id, text: 'isi' });
    // Its maker may remove it, like an admin; another member may not.
    const other = r.join('o', 'member');
    other.say({ t: 'topic.remove', id: t.id });
    expect(other.last('error').code).toBe('forbidden');
    m.say({ t: 'topic.remove', id: t.id });
    expect(a.last('topic.removed').id).toBe(t.id);
    expect(r.count('messages')).toBe(0);
  });
});

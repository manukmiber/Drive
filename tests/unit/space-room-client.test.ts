// W4 (ADR-098): the app's state of a Space's live room, built from what the room says.
import { describe, expect, it } from 'vitest';
import type { MessageDto, ServerFrame, TopicDto } from '../../src/shared/space-room';
import {
  emptyRoom,
  listKey,
  roomReduce,
  typistsIn,
  type RoomAction,
  type RoomState,
} from '../../src/web/lib/space-room-state';

const topic = (over: Partial<TopicDto> = {}): TopicDto => ({
  id: 'T1',
  name: 'umum',
  guests: true,
  createdBy: null,
  createdAt: 1,
  unread: 0,
  last: 0,
  ...over,
});

const msg = (over: Partial<MessageDto> = {}): MessageDto => ({
  id: 'M1',
  seq: 1,
  topic: 'T1',
  thread: null,
  author: 'ana',
  authorName: 'Ana',
  at: 1_000,
  editedAt: null,
  text: 'halo',
  mentions: [],
  replies: 0,
  ...over,
});

const frame = (f: ServerFrame, now = 10_000): RoomAction => ({ kind: 'frame', frame: f, now });

function run(...actions: RoomAction[]): RoomState {
  return actions.reduce(roomReduce, emptyRoom);
}

const hello = (over: Partial<Extract<ServerFrame, { t: 'hello' }>> = {}) =>
  frame({
    t: 'hello',
    me: 'me',
    role: 'member',
    readonly: false,
    topics: [topic({ id: 'T2', name: 'desain', createdAt: 5 }), topic()],
    online: ['ana'],
    locks: [],
    ...over,
  });

describe('Space room state in the app (ADR-098)', () => {
  it('opens on hello with the topics in the order they were made, and forgets loaded lists', () => {
    const s = run(
      hello(),
      frame({ t: 'history', topic: 'T1', thread: null, messages: [msg()], more: false }),
      hello(),
    );
    expect(s.status).toBe('open');
    expect(s.topics.map((x) => x.id)).toEqual(['T1', 'T2']);
    expect(s.online).toEqual(['ana']);
    // A new connection may have missed messages: the views ask again.
    expect(s.lists).toEqual({});
  });

  it('keeps history in order, oldest pages put in front, no repeats', () => {
    const s = run(
      hello(),
      frame({
        t: 'history',
        topic: 'T1',
        thread: null,
        messages: [msg({ id: 'M3', seq: 3 }), msg({ id: 'M4', seq: 4 })],
        more: true,
      }),
      frame({
        t: 'history',
        topic: 'T1',
        thread: null,
        messages: [msg({ id: 'M2', seq: 2 }), msg({ id: 'M3', seq: 3 })],
        more: false,
      }),
    );
    const l = s.lists[listKey('T1')]!;
    expect(l.messages.map((m) => m.id)).toEqual(['M2', 'M3', 'M4']);
    expect(l.more).toBe(false);
    expect(l.loading).toBe(false);
  });

  it('counts what others write as unread, not what the person writes, and clears it when read', () => {
    let s = run(
      hello(),
      frame({ t: 'history', topic: 'T1', thread: null, messages: [], more: false }),
      frame({ t: 'msg', message: msg({ id: 'M1', seq: 1, author: 'ana' }) }),
      frame({ t: 'msg', message: msg({ id: 'M2', seq: 2, author: 'ana' }) }),
    );
    expect(s.topics.find((x) => x.id === 'T1')).toMatchObject({ unread: 2, last: 2 });
    expect(s.lists.T1!.messages).toHaveLength(2);

    s = roomReduce(s, frame({ t: 'msg', message: msg({ id: 'M3', seq: 3, author: 'me' }) }));
    expect(s.topics.find((x) => x.id === 'T1')!.unread).toBe(0);

    s = roomReduce(s, frame({ t: 'msg', message: msg({ id: 'M4', seq: 4, author: 'ana' }) }));
    s = roomReduce(s, { kind: 'readLocal', topic: 'T1' });
    expect(s.topics.find((x) => x.id === 'T1')!.unread).toBe(0);

    // Read on another device of the person's: only up to what it had seen.
    s = roomReduce(s, frame({ t: 'msg', message: msg({ id: 'M5', seq: 5, author: 'ana' }) }));
    s = roomReduce(s, frame({ t: 'read', topic: 'T1', upto: 4 }));
    expect(s.topics.find((x) => x.id === 'T1')!.unread).toBe(1);
    s = roomReduce(s, frame({ t: 'read', topic: 'T1', upto: 5 }));
    expect(s.topics.find((x) => x.id === 'T1')!.unread).toBe(0);
  });

  it('puts a reply in its thread and counts it on the message it answers', () => {
    const s = run(
      hello(),
      frame({ t: 'history', topic: 'T1', thread: null, messages: [msg()], more: false }),
      frame({ t: 'history', topic: 'T1', thread: 'M1', messages: [], more: false }),
      frame({ t: 'msg', message: msg({ id: 'R1', seq: 2, thread: 'M1', author: 'budi' }) }),
    );
    expect(s.lists.T1!.messages).toEqual([expect.objectContaining({ id: 'M1', replies: 1 })]);
    expect(s.lists[listKey('T1', 'M1')]!.messages.map((m) => m.id)).toEqual(['R1']);
  });

  it('shows a message as pending until the room has it, and keeps it when refused', () => {
    let s = run(hello(), {
      kind: 'pending',
      pending: { nonce: 'n1', topic: 'T1', thread: null, text: 'hai', at: 1, failed: null },
    });
    s = roomReduce(s, {
      kind: 'pending',
      pending: { nonce: 'n2', topic: 'T1', thread: null, text: 'x'.repeat(9), at: 2, failed: null },
    });
    s = roomReduce(s, frame({ t: 'msg', message: msg({ author: 'me' }), nonce: 'n1' }));
    s = roomReduce(s, frame({ t: 'error', code: 'too_long', message: 'no', nonce: 'n2' }));
    expect(s.pending).toEqual([expect.objectContaining({ nonce: 'n2', failed: 'too_long' })]);
    expect(s.error).toBeNull();

    // A refusal of something else is said once, then dismissed.
    s = roomReduce(s, frame({ t: 'error', code: 'forbidden', message: 'no' }));
    expect(s.error?.code).toBe('forbidden');
    expect(roomReduce(s, { kind: 'dismiss' }).error).toBeNull();
    expect(roomReduce(s, { kind: 'unpend', nonce: 'n2' }).pending).toEqual([]);
  });

  it('changes and empties messages wherever they are loaded', () => {
    const s = run(
      hello(),
      frame({
        t: 'history',
        topic: 'T1',
        thread: null,
        messages: [msg(), msg({ id: 'M2', seq: 2, mentions: ['me'] })],
        more: false,
      }),
      frame({
        t: 'history',
        topic: 'T1',
        thread: 'M1',
        messages: [msg({ id: 'R1', seq: 3, thread: 'M1' })],
        more: false,
      }),
      frame({ t: 'edited', id: 'R1', text: 'baru', editedAt: 50 }),
      frame({ t: 'deleted', ids: ['M2'] }),
    );
    expect(s.lists['T1/M1']!.messages[0]).toMatchObject({ text: 'baru', editedAt: 50 });
    expect(s.lists.T1!.messages[1]).toMatchObject({ id: 'M2', text: null, mentions: [] });
  });

  it('adds, renames and removes topics, keeping what was unread', () => {
    let s = run(
      hello({ topics: [topic({ unread: 3, last: 9 })] }),
      frame({ t: 'history', topic: 'T1', thread: null, messages: [], more: false }),
      frame({ t: 'topic', topic: topic({ id: 'T3', name: 'baru', createdAt: 9 }), nonce: 'k' }),
      frame({ t: 'topic', topic: topic({ name: 'umum-2' }) }),
    );
    expect(s.made.k).toBe('T3');
    expect(s.topics.find((x) => x.id === 'T1')).toMatchObject({
      name: 'umum-2',
      unread: 3,
      last: 9,
    });
    s = roomReduce(s, frame({ t: 'topic.removed', id: 'T1' }));
    expect(s.topics.map((x) => x.id)).toEqual(['T3']);
    expect(s.lists.T1).toBeUndefined();
  });

  it('follows who is here, who is typing, locks and the person’s role', () => {
    let s = run(
      hello(),
      frame({ t: 'presence', user: 'budi', online: true }),
      frame({ t: 'presence', user: 'ana', online: false }),
      frame({ t: 'typing', topic: 'T1', user: 'budi', name: 'Budi' }, 1_000),
      frame({ t: 'lock', lock: { node: 'N1', user: 'budi', name: 'Budi', since: 1 } }),
      frame({ t: 'role', role: 'guest', readonly: true }),
    );
    expect(s.online).toEqual(['budi']);
    expect(typistsIn(s, 'T1', 2_000).map((x) => x.name)).toEqual(['Budi']);
    expect(typistsIn(s, 'T1', 7_000)).toEqual([]);
    expect(s.locks).toHaveLength(1);
    expect(s).toMatchObject({ role: 'guest', readonly: true });

    // Their message ends their typing; the lock goes when they let go.
    s = roomReduce(s, frame({ t: 'msg', message: msg({ author: 'budi' }) }, 1_500));
    expect(typistsIn(s, 'T1', 2_000)).toEqual([]);
    expect(roomReduce(s, frame({ t: 'unlock', node: 'N1' })).locks).toEqual([]);
  });
});

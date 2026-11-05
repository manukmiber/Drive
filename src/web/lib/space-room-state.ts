// What a Space's live room has told the app so far (W4, ADR-096, ADR-098), as one state object
// built by a pure reducer. No DOM here, so it is tested in Node; the socket is in space-room.ts.
import type {
  LockDto,
  MessageDto,
  RoomErrorCode,
  RoomRole,
  ServerFrame,
  TopicDto,
} from '../../shared/space-room';

export type RoomStatus =
  | 'connecting'
  | 'open'
  /** Lost; trying again on its own. */
  | 'retrying'
  /** Several tries in a row never opened (the room is full for today, or offline). */
  | 'unavailable'
  | 'removed'
  | 'gone'
  | 'signin';

export interface MessageList {
  messages: MessageDto[];
  /** Older messages are still on the server. */
  more: boolean;
  loading: boolean;
}

export interface Pending {
  nonce: string;
  topic: string;
  thread: string | null;
  text: string;
  at: number;
  failed: RoomErrorCode | null;
}

export interface Typist {
  user: string;
  name: string;
  until: number;
}

export interface RoomState {
  status: RoomStatus;
  me: string | null;
  role: RoomRole | null;
  readonly: boolean;
  topics: TopicDto[];
  online: string[];
  locks: LockDto[];
  /** Per topic (`topicId`) and per thread (`topicId/rootId`). */
  lists: Record<string, MessageList>;
  pending: Pending[];
  typing: Record<string, Typist[]>;
  /** The last refusal not tied to a message being sent. */
  error: { code: RoomErrorCode; message: string; at: number } | null;
  /** Topics this connection asked to make, by nonce, until the room answers. */
  made: Record<string, string>;
}

export const emptyRoom: RoomState = {
  status: 'connecting',
  me: null,
  role: null,
  readonly: false,
  topics: [],
  online: [],
  locks: [],
  lists: {},
  pending: [],
  typing: {},
  error: null,
  made: {},
};

export const listKey = (topic: string, thread: string | null = null) =>
  thread ? `${topic}/${thread}` : topic;

export type RoomAction =
  | { kind: 'frame'; frame: ServerFrame; now: number }
  | { kind: 'status'; status: RoomStatus }
  | { kind: 'pending'; pending: Pending }
  | { kind: 'loading'; key: string }
  | { kind: 'readLocal'; topic: string }
  | { kind: 'unpend'; nonce: string }
  | { kind: 'dismiss' };

const TYPING_SHOWN_MS = 5_000;

function bySeq(a: MessageDto, b: MessageDto) {
  return a.seq - b.seq;
}

/** Messages of a list with these merged in (by id, newest copy wins), in order. */
function merge(list: MessageDto[], add: MessageDto[]): MessageDto[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of add) byId.set(m.id, m);
  return [...byId.values()].sort(bySeq);
}

function mapMessages(
  lists: Record<string, MessageList>,
  f: (m: MessageDto) => MessageDto,
): Record<string, MessageList> {
  const out: Record<string, MessageList> = {};
  for (const [k, l] of Object.entries(lists)) out[k] = { ...l, messages: l.messages.map(f) };
  return out;
}

function sortTopics(topics: TopicDto[]): TopicDto[] {
  return [...topics].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export function roomReduce(s: RoomState, a: RoomAction): RoomState {
  switch (a.kind) {
    case 'status':
      return { ...s, status: a.status };
    case 'pending':
      return { ...s, pending: [...s.pending, a.pending] };
    case 'loading': {
      const l = s.lists[a.key] ?? { messages: [], more: true, loading: false };
      return { ...s, lists: { ...s.lists, [a.key]: { ...l, loading: true } } };
    }
    case 'readLocal':
      return {
        ...s,
        topics: s.topics.map((x) => (x.id === a.topic ? { ...x, unread: 0 } : x)),
      };
    case 'unpend':
      return { ...s, pending: s.pending.filter((p) => p.nonce !== a.nonce) };
    case 'dismiss':
      return { ...s, error: null };
    case 'frame':
      return frame(s, a.frame, a.now);
  }
}

function frame(s: RoomState, f: ServerFrame, now: number): RoomState {
  switch (f.t) {
    case 'hello':
      // A new connection: what was loaded may have missed messages, so the views load again.
      return {
        ...s,
        status: 'open',
        me: f.me,
        role: f.role,
        readonly: f.readonly,
        topics: sortTopics(f.topics),
        online: f.online,
        locks: f.locks,
        lists: {},
        typing: {},
        pending: s.pending.filter((p) => p.failed),
      };
    case 'presence': {
      const others = s.online.filter((u) => u !== f.user);
      return { ...s, online: f.online ? [...others, f.user] : others };
    }
    case 'msg': {
      const m = f.message;
      const key = listKey(m.topic, m.thread);
      let lists = s.lists;
      const l = lists[key];
      if (l) lists = { ...lists, [key]: { ...l, messages: merge(l.messages, [m]) } };
      if (m.thread) {
        const top = lists[m.topic];
        if (top)
          lists = {
            ...lists,
            [m.topic]: {
              ...top,
              messages: top.messages.map((x) =>
                x.id === m.thread ? { ...x, replies: x.replies + 1 } : x,
              ),
            },
          };
      }
      const mine = m.author !== null && m.author === s.me;
      const typing = s.typing[m.topic];
      return {
        ...s,
        lists,
        topics: s.topics.map((x) =>
          x.id === m.topic
            ? { ...x, last: Math.max(x.last, m.seq), unread: mine ? 0 : x.unread + 1 }
            : x,
        ),
        pending: f.nonce ? s.pending.filter((p) => p.nonce !== f.nonce) : s.pending,
        typing: typing
          ? { ...s.typing, [m.topic]: typing.filter((x) => x.user !== m.author) }
          : s.typing,
      };
    }
    case 'edited':
      return {
        ...s,
        lists: mapMessages(s.lists, (m) =>
          m.id === f.id ? { ...m, text: f.text, editedAt: f.editedAt } : m,
        ),
      };
    case 'deleted': {
      const ids = new Set(f.ids);
      return {
        ...s,
        lists: mapMessages(s.lists, (m) =>
          ids.has(m.id) ? { ...m, text: null, mentions: [] } : m,
        ),
      };
    }
    case 'read':
      return {
        ...s,
        topics: s.topics.map((x) =>
          x.id === f.topic && f.upto >= x.last ? { ...x, unread: 0 } : x,
        ),
      };
    case 'typing': {
      const list = (s.typing[f.topic] ?? []).filter((x) => x.user !== f.user && x.until > now);
      return {
        ...s,
        typing: {
          ...s.typing,
          [f.topic]: [...list, { user: f.user, name: f.name, until: now + TYPING_SHOWN_MS }],
        },
      };
    }
    case 'history': {
      const key = listKey(f.topic, f.thread);
      const l = s.lists[key];
      return {
        ...s,
        lists: {
          ...s.lists,
          [key]: {
            messages: merge(l?.messages ?? [], f.messages),
            more: f.more,
            loading: false,
          },
        },
      };
    }
    case 'topic': {
      const old = s.topics.find((x) => x.id === f.topic.id);
      const topic = old ? { ...f.topic, unread: old.unread, last: old.last } : f.topic;
      const made = { ...s.made };
      if (f.nonce) made[f.nonce] = f.topic.id;
      return {
        ...s,
        made,
        topics: sortTopics([...s.topics.filter((x) => x.id !== f.topic.id), topic]),
      };
    }
    case 'topic.removed': {
      const lists: Record<string, MessageList> = {};
      for (const [k, l] of Object.entries(s.lists))
        if (k !== f.id && !k.startsWith(`${f.id}/`)) lists[k] = l;
      return { ...s, lists, topics: s.topics.filter((x) => x.id !== f.id) };
    }
    case 'lock':
      return { ...s, locks: [...s.locks.filter((x) => x.node !== f.lock.node), f.lock] };
    case 'unlock':
      return { ...s, locks: s.locks.filter((x) => x.node !== f.node) };
    case 'role':
      return { ...s, role: f.role, readonly: f.readonly };
    case 'files':
      return s;
    case 'error': {
      if (f.nonce && s.pending.some((p) => p.nonce === f.nonce))
        return {
          ...s,
          pending: s.pending.map((p) => (p.nonce === f.nonce ? { ...p, failed: f.code } : p)),
        };
      return { ...s, error: { code: f.code, message: f.message, at: now } };
    }
  }
}

/** Who is typing in a topic now. */
export function typistsIn(s: RoomState, topic: string, now: number): Typist[] {
  return (s.typing[topic] ?? []).filter((x) => x.until > now);
}

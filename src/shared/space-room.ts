// W3/W4 (ADR-096): what a Space's live room and the app say to each other over the WebSocket. One
// JSON object per frame, `t` names it. Shared by the room (src/worker/rooms/) and the app.

export type RoomRole = 'admin' | 'member' | 'guest';

export interface TopicDto {
  id: string;
  name: string;
  /** Guests read and write here; other topics are the team's own. `#umum` starts open to guests. */
  guests: boolean;
  createdBy: string | null;
  createdAt: number;
  /** Messages after what this person last read, not their own. */
  unread: number;
  /** The newest message's order number, 0 when there is none. */
  last: number;
}

export interface MessageDto {
  id: string;
  /** Order in the room: higher is later. Paging and "read up to" use it. */
  seq: number;
  topic: string;
  /** The message this one answers, in a thread; null for a message in the topic itself. */
  thread: string | null;
  /** Null once the author's account is gone. */
  author: string | null;
  authorName: string | null;
  at: number;
  editedAt: number | null;
  /** Null once deleted: the row stays so replies keep their place ("message not available"). */
  text: string | null;
  mentions: string[];
  /** Replies in its thread (top-level messages only). */
  replies: number;
}

export interface LockDto {
  node: string;
  user: string;
  name: string;
  since: number;
}

export type ClientFrame =
  | { t: 'send'; topic: string; text: string; thread?: string | null; nonce?: string }
  | { t: 'edit'; id: string; text: string }
  | { t: 'delete'; id: string }
  | { t: 'read'; topic: string; upto: number }
  | { t: 'typing'; topic: string }
  | { t: 'history'; topic: string; before?: number; thread?: string | null; limit?: number }
  | { t: 'topic.create'; name: string; guests?: boolean; nonce?: string }
  | { t: 'topic.update'; id: string; name?: string; guests?: boolean }
  | { t: 'topic.remove'; id: string }
  | { t: 'lock'; node: string }
  | { t: 'unlock'; node: string };

export type ServerFrame =
  | {
      t: 'hello';
      me: string;
      role: RoomRole;
      readonly: boolean;
      topics: TopicDto[];
      /** Who else is here now (never told to guests). */
      online: string[];
      locks: LockDto[];
    }
  | { t: 'presence'; user: string; online: boolean }
  | { t: 'msg'; message: MessageDto; nonce?: string }
  | { t: 'edited'; id: string; text: string; editedAt: number }
  | { t: 'deleted'; ids: string[] }
  | { t: 'read'; topic: string; upto: number }
  | { t: 'typing'; topic: string; user: string; name: string }
  | {
      t: 'history';
      topic: string;
      thread: string | null;
      messages: MessageDto[];
      more: boolean;
    }
  | { t: 'topic'; topic: TopicDto; nonce?: string }
  | { t: 'topic.removed'; id: string }
  | { t: 'lock'; lock: LockDto }
  | { t: 'unlock'; node: string }
  /** Files in the Space changed: the app refetches them (replaces polling, ADR-096). */
  | { t: 'files'; ids: string[] }
  | { t: 'role'; role: RoomRole; readonly: boolean }
  | { t: 'error'; code: RoomErrorCode; message: string; nonce?: string };

export type RoomErrorCode =
  | 'bad_frame'
  | 'too_long'
  | 'not_found'
  | 'forbidden'
  | 'readonly'
  | 'rate_limited'
  | 'topics_full'
  | 'locked';

/** Close codes the app acts on: 4401 sign in again, 4403 no longer in the Space, 4410 Space gone. */
export const ROOM_CLOSE = { signIn: 4401, removed: 4403, gone: 4410, abuse: 1008 } as const;

/** A mention in a message's text: `<@userId>`. The app draws the name. */
export const MENTION = /<@([A-Za-z0-9_-]{1,64})>/g;

/** Frames a connection may send per window before it is told to slow down, and closed after twice. */
export const ROOM_RATE = { windowMs: 10_000, frames: 40 } as const;
/** Typing frames closer than this are dropped (not stored, not counted as a message). */
export const TYPING_EVERY_MS = 3_000;
/** The largest frame the room reads, in characters. */
export const MAX_FRAME_CHARS = 32_000;
/** Messages per history page. */
export const HISTORY_PAGE = 50;
/** A lock not refreshed by its holder's connection goes when that connection does. */
export const MAX_LOCKS_PER_CONNECTION = 20;

// The app's side of a Space's live room (W4, ADR-096, ADR-098): one WebSocket per open Space. The
// state is roomReduce's (space-room-state.ts); this file only owns the socket: it reconnects with
// backoff, pings so the connection stays up through proxies (the room's runtime answers pings
// without waking it), and stops for good when the room says the person is out (4403) or the Space
// is gone (4410).
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ROOM_CLOSE, type ClientFrame, type ServerFrame } from '../../shared/space-room';
import {
  emptyRoom,
  listKey,
  roomReduce,
  type Pending,
  type RoomState,
} from './space-room-state';

export {
  listKey,
  typistsIn,
  type MessageList,
  type Pending,
  type RoomState,
  type RoomStatus,
  type Typist,
} from './space-room-state';

const PING_EVERY_MS = 25_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Tries that never opened before the app says the chat cannot connect. */
const UNAVAILABLE_AFTER = 3;

let nonces = 0;
const nonce = () => `${Date.now().toString(36)}-${(nonces++).toString(36)}`;

export function liveUrl(spaceId: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/spaces/${spaceId}/live`;
}

export interface Room {
  state: RoomState;
  /** Sends a frame if connected; false when it could not go. */
  send: (f: ClientFrame) => boolean;
  /** A message, shown at once as pending until the room has it. */
  post: (topic: string, text: string, thread?: string | null) => void;
  /** Asks to make a topic; the nonce comes back in `state.made` with its id. */
  makeTopic: (name: string, guests: boolean) => string | null;
  loadHistory: (topic: string, thread?: string | null, before?: number) => void;
  markRead: (topic: string, upto: number) => void;
  /** A message that could not go: tried again, or let go. */
  resend: (p: Pending) => void;
  discard: (nonce: string) => void;
  dismiss: () => void;
  retry: () => void;
}

export function useSpaceRoom(spaceId: string, enabled: boolean): Room {
  const [state, dispatch] = useReducer(roomReduce, emptyRoom);
  const ws = useRef<WebSocket | null>(null);
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let fails = 0;
    let opened = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      clearTimeout(timer);
      if (stopped || ws.current) return;
      opened = false;
      const sock = new WebSocket(liveUrl(spaceId));
      ws.current = sock;
      sock.onopen = () => {
        opened = true;
        fails = 0;
        ping = setInterval(() => {
          if (sock.readyState === WebSocket.OPEN) sock.send('{"t":"ping"}');
        }, PING_EVERY_MS);
      };
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let f: ServerFrame | { t: 'pong' };
        try {
          f = JSON.parse(e.data) as ServerFrame | { t: 'pong' };
        } catch {
          return;
        }
        if (f.t === 'pong') return;
        dispatch({ kind: 'frame', frame: f, now: Date.now() });
      };
      sock.onclose = (e) => {
        clearInterval(ping);
        if (ws.current === sock) ws.current = null;
        if (stopped) return;
        if (e.code === ROOM_CLOSE.removed) return dispatch({ kind: 'status', status: 'removed' });
        if (e.code === ROOM_CLOSE.gone) return dispatch({ kind: 'status', status: 'gone' });
        if (e.code === ROOM_CLOSE.signIn) return dispatch({ kind: 'status', status: 'signin' });
        if (!opened) fails++;
        dispatch({
          kind: 'status',
          status: fails >= UNAVAILABLE_AFTER ? 'unavailable' : 'retrying',
        });
        const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length - 1)]!;
        timer = setTimeout(connect, e.code === ROOM_CLOSE.abuse ? 30_000 : wait);
      };
    };

    kick.current = () => {
      if (!ws.current) connect();
    };
    const wake = () => {
      if (document.visibilityState === 'visible' && !ws.current) {
        fails = Math.min(fails, 1);
        connect();
      }
    };
    dispatch({ kind: 'status', status: 'connecting' });
    connect();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      ws.current?.close(1000);
      ws.current = null;
    };
  }, [spaceId, enabled]);

  const send = useCallback((f: ClientFrame) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    sock.send(JSON.stringify(f));
    return true;
  }, []);

  const post = useCallback(
    (topic: string, text: string, thread: string | null = null) => {
      const n = nonce();
      dispatch({
        kind: 'pending',
        pending: { nonce: n, topic, thread, text, at: Date.now(), failed: null },
      });
      if (!send({ t: 'send', topic, text, thread, nonce: n }))
        dispatch({
          kind: 'frame',
          frame: { t: 'error', code: 'bad_frame', message: 'offline', nonce: n },
          now: Date.now(),
        });
    },
    [send],
  );

  const makeTopic = useCallback(
    (name: string, guests: boolean) => {
      const n = nonce();
      return send({ t: 'topic.create', name, guests, nonce: n }) ? n : null;
    },
    [send],
  );

  const loadHistory = useCallback(
    (topic: string, thread: string | null = null, before?: number) => {
      if (
        send({ t: 'history', topic, ...(thread ? { thread } : {}), ...(before ? { before } : {}) })
      )
        dispatch({ kind: 'loading', key: listKey(topic, thread) });
    },
    [send],
  );

  const markRead = useCallback(
    (topic: string, upto: number) => {
      dispatch({ kind: 'readLocal', topic });
      send({ t: 'read', topic, upto });
    },
    [send],
  );

  const discard = useCallback((n: string) => dispatch({ kind: 'unpend', nonce: n }), []);
  const resend = useCallback(
    (p: Pending) => {
      discard(p.nonce);
      post(p.topic, p.text, p.thread);
    },
    [discard, post],
  );
  const dismiss = useCallback(() => dispatch({ kind: 'dismiss' }), []);
  const retry = useCallback(() => kick.current(), []);

  return { state, send, post, makeTopic, loadHistory, markRead, resend, discard, dismiss, retry };
}

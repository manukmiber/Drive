// The SPACE_ROOM binding in Node (ADR-001, ADR-096): each Space's room is the same SpaceRoomCore the
// Durable Object wraps, on node:sqlite, with sockets the tests and the dev server drive. A
// connection is answered 200 with the socket's id instead of 101: Node's Response cannot carry one;
// the dev server then upgrades the browser's request itself and wires the two (dev/ws-bridge.ts).
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ServerFrame } from '../../src/shared/space-room';
import { createCtx } from '../../src/worker/context';
import type { Env } from '../../src/worker/env';
import {
  SpaceRoomCore,
  connState,
  defaultTopicName,
  internalCall,
  type Conn,
  type ConnState,
  type RoomSocket,
  type SqlValue,
} from '../../src/worker/rooms/space-room-core';
import { mentionNotices } from '../../src/worker/rooms/space-room-effects';
import { noteSeen } from '../../src/worker/services/space-room';

type FrameOf<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;

export class DevRoomSocket implements RoomSocket {
  /** What the room sent, kept for tests; once a browser listens, frames go to it instead. */
  readonly frames: ServerFrame[] = [];
  closed: { code: number | undefined; reason: string | undefined } | null = null;
  private sink: ((data: string) => void) | null = null;
  private onClose: ((code?: number, reason?: string) => void) | null = null;

  constructor(
    private room: DevRoom,
    readonly state: ConnState,
  ) {}

  send(data: string): void {
    if (this.closed) return;
    if (this.sink) this.sink(data);
    else this.frames.push(JSON.parse(data) as ServerFrame);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.room.drop(this);
    this.onClose?.(code, reason);
  }

  /** A real WebSocket takes over (dev server): what was sent so far first, then every frame. */
  attach(sink: (data: string) => void, onClose: (code?: number, reason?: string) => void): void {
    for (const f of this.frames.splice(0)) sink(JSON.stringify(f));
    this.sink = sink;
    this.onClose = onClose;
  }

  /** What the app would send. */
  say(frame: unknown): Promise<void> {
    return this.room.message(this, typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  of<T extends ServerFrame['t']>(t: T): FrameOf<T>[] {
    return this.frames.filter((f): f is FrameOf<T> => f.t === t);
  }

  last<T extends ServerFrame['t']>(t: T): FrameOf<T> | undefined {
    return this.of(t).at(-1);
  }

  clear(): void {
    this.frames.length = 0;
  }
}

export class DevRoom {
  private db = new DatabaseSync(':memory:');
  sockets: DevRoomSocket[] = [];
  readonly core: SpaceRoomCore;

  constructor(
    readonly spaceId: string,
    private env: () => Env,
    private now: () => number,
  ) {
    this.core = this.makeCore();
  }

  private makeCore(): SpaceRoomCore {
    const core = new SpaceRoomCore(
      {
        sql: {
          exec: (q, ...p) => this.db.prepare(q).all(...p) as Record<string, SqlValue>[],
        },
        now: this.now,
        connections: () => this.sockets.map((s) => this.conn(s)),
      },
      { maxChars: 4000, maxTopics: 100 },
    );
    core.migrate();
    return core;
  }

  private conn(s: DevRoomSocket): Conn {
    return { socket: s, state: s.state, save: () => {} };
  }

  drop(s: DevRoomSocket): void {
    // A browser may hang up after the dev server (or a test) closed the room's database.
    if (this.shut) return;
    this.core.closed(this.conn(s));
    this.sockets = this.sockets.filter((x) => x !== s);
  }

  async message(s: DevRoomSocket, raw: string): Promise<void> {
    if (s.closed) throw new Error('socket is closed');
    const cfg = await createCtx(this.env()).config();
    this.core.setLimits({ maxChars: cfg.space_message_max_chars, maxTopics: cfg.space_max_topics });
    const effects = this.core.message(this.conn(s), raw);
    if (effects.length) await mentionNotices(createCtx(this.env()), this.spaceId, effects);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/connect') {
      const state = connState(req.headers, this.now(), randomUUID());
      if (!state || req.headers.get('x-zk-space') !== this.spaceId)
        return new Response('bad request', { status: 400 });
      const s = new DevRoomSocket(this, state);
      this.sockets.push(s);
      if (this.core.open(this.conn(s), defaultTopicName(req.headers)))
        await noteSeen(this.env(), this.spaceId, state.user, this.now());
      return Response.json({ socket: state.id }, { headers: { 'x-dev-room-socket': state.id } });
    }
    if (!path.startsWith('/internal/')) return new Response('not found', { status: 404 });
    const out = internalCall(
      this.core,
      path.slice('/internal/'.length),
      (await req.json()) as Record<string, unknown>,
    );
    if (!out) return new Response('not found', { status: 404 });
    if (out.purge) this.purged = true;
    return Response.json(out.result);
  }

  /** True once the Space went and the room's storage was dropped. */
  purged = false;

  /** Rows in one of the room's tables (tests look inside). */
  count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  private shut = false;

  close(): void {
    if (this.shut) return;
    this.shut = true;
    this.db.close();
  }
}

export class DevSpaceRooms {
  private rooms = new Map<string, DevRoom>();

  constructor(
    private env: () => Env,
    private now: () => number,
  ) {}

  idFromName(name: string): DurableObjectId {
    return {
      name,
      toString: () => name,
      equals: (o: { name?: string }) => o.name === name,
    } as never;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = (id as unknown as { name: string }).name;
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        this.room(name).fetch(input instanceof Request ? input : new Request(input, init)),
    } as unknown as DurableObjectStub;
  }

  room(spaceId: string): DevRoom {
    let r = this.rooms.get(spaceId);
    if (!r || r.purged) {
      r?.close();
      r = new DevRoom(spaceId, this.env, this.now);
      this.rooms.set(spaceId, r);
    }
    return r;
  }

  /** A room as it is, without making one (null when none was ever opened or it was purged). */
  peek(spaceId: string): DevRoom | null {
    const r = this.rooms.get(spaceId);
    return r && !r.purged ? r : null;
  }

  wasPurged(spaceId: string): boolean {
    return this.rooms.get(spaceId)?.purged ?? false;
  }

  /** The socket a connection was given (its id is in the 200 the connection got). */
  socket(spaceId: string, socketId: string): DevRoomSocket {
    const s = this.rooms.get(spaceId)?.sockets.find((x) => x.state.id === socketId);
    if (!s) throw new Error(`no socket ${socketId} in ${spaceId}`);
    return s;
  }

  close(): void {
    for (const r of this.rooms.values()) r.close();
  }
}

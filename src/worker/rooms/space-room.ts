// W3 (ADR-096): the Durable Object around SpaceRoomCore, one per Space (`idFromName(spaceId)`), on
// SQLite storage (the only kind Workers Free has). Sockets are hibernatable: an idle room costs no
// duration, pings are answered without waking it, and a connection's state is its attachment. Kept
// out of index.ts, like the Containers, so the Node dev shims never import `cloudflare:workers`.
//
// Reached only through the SPACE_ROOM binding, by the Worker: `/connect` after routes/space-live.ts
// has checked the session and the role, and `/internal/*` from services/space-room.ts.
import { DurableObject } from 'cloudflare:workers';
import { CONFIG_DEFAULTS } from '../../shared/config-defaults';
import { createCtx } from '../context';
import type { Env } from '../env';
import { log } from '../lib/log';
import { noteSeen } from '../services/space-room';
import { mentionNotices } from './space-room-effects';
import {
  SpaceRoomCore,
  connState,
  defaultTopicName,
  internalCall,
  type Conn,
  type ConnState,
  type Effect,
  type SqlValue,
} from './space-room-core';

const LIMITS_FOR_MS = 60_000;

export class SpaceRoom extends DurableObject<Env> {
  private core: SpaceRoomCore;
  private limitsAt = 0;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.core = new SpaceRoomCore(
      {
        sql: {
          exec: (q, ...p) =>
            state.storage.sql.exec(q, ...p).toArray() as Record<string, SqlValue>[],
        },
        now: () => Date.now(),
        connections: () => state.getWebSockets().map((ws) => this.conn(ws)),
      },
      {
        maxChars: CONFIG_DEFAULTS.space_message_max_chars,
        maxTopics: CONFIG_DEFAULTS.space_max_topics,
      },
    );
    void state.blockConcurrencyWhile(async () => this.core.migrate());
    // Keep-alive pings are answered by the runtime: no wake, no duration (ADR-096).
    state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'),
    );
  }

  private conn(ws: WebSocket): Conn {
    const state = ws.deserializeAttachment() as ConnState;
    return { socket: ws, state, save: () => ws.serializeAttachment(state) };
  }

  /** The business numbers, read again at most once a minute. */
  private async limits(): Promise<void> {
    if (Date.now() - this.limitsAt < LIMITS_FOR_MS) return;
    try {
      const cfg = await createCtx(this.env).config();
      this.core.setLimits({
        maxChars: cfg.space_message_max_chars,
        maxTopics: cfg.space_max_topics,
      });
      this.limitsAt = Date.now();
    } catch (e) {
      log.warn('space_room_config', { error: String(e) });
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/connect') return this.accept(req);
    if (req.method !== 'POST' || !url.pathname.startsWith('/internal/'))
      return new Response('not found', { status: 404 });
    const out = internalCall(
      this.core,
      url.pathname.slice('/internal/'.length),
      (await req.json()) as Record<string, unknown>,
    );
    if (!out) return new Response('not found', { status: 404 });
    if (out.purge) await this.ctx.storage.deleteAll();
    return Response.json(out.result);
  }

  private async accept(req: Request): Promise<Response> {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return new Response('expected a WebSocket', { status: 426 });
    const space = req.headers.get('x-zk-space');
    const now = Date.now();
    const state = connState(req.headers, now, crypto.randomUUID());
    if (!space || !state) return new Response('bad request', { status: 400 });
    await this.limits();
    if (!this.core.meta('space')) this.core.setMeta('space', space);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [state.user]);
    server.serializeAttachment(state);
    const first = this.core.open(
      { socket: server, state, save: () => server.serializeAttachment(state) },
      defaultTopicName(req.headers),
    );
    if (first)
      await noteSeen(this.env, space, state.user, now).catch((e: unknown) =>
        log.warn('space_seen', { error: String(e) }),
      );
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    await this.limits();
    await this.apply(this.core.message(this.conn(ws), message));
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.core.closed(this.conn(ws));
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.core.closed(this.conn(ws));
  }

  private async apply(effects: Effect[]): Promise<void> {
    const space = this.core.meta('space');
    if (space && effects.length) await mentionNotices(createCtx(this.env), space, effects);
  }
}

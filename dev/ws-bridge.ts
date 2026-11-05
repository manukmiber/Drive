// The browser's WebSocket to a Space's live room, in dev (ADR-096, ADR-098). On Cloudflare the room
// answers 101 itself; Node's Response cannot carry one, so here the Worker's answer to the handshake
// is the dev room's 200 with a socket id (dev/shims/space-room.ts), and this file upgrades the
// browser's request and joins the two. Everything the Worker checks (Origin, session, role, team
// status) is still checked by the Worker: the bridge only forwards its verdict.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData } from 'ws';
import { liveSpaceOf } from '../src/worker/routes/space-live';
import type { DevSpaceRooms } from './shims/space-room';

/** Answered here like the Durable Object's runtime does, without waking the room. */
const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';

function requestOf(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  return new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
    headers,
  });
}

async function refuse(socket: Duplex, res: Response): Promise<void> {
  const body = await res.text().catch(() => '');
  socket.end(
    `HTTP/1.1 ${res.status} ${res.statusText || 'Refused'}\r\n` +
      `content-type: ${res.headers.get('content-type') ?? 'text/plain'}\r\n` +
      `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

export function bridgeRooms(
  server: Pick<Server, 'on'>,
  rooms: DevSpaceRooms,
  fetch: (req: Request) => Promise<Response>,
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const request = requestOf(req);
    const spaceId = liveSpaceOf(request);
    if (!spaceId) {
      socket.destroy();
      return;
    }
    void (async () => {
      const res = await fetch(request);
      const id = res.headers.get('x-dev-room-socket');
      if (res.status !== 200 || !id) return refuse(socket, res);
      const room = rooms.socket(spaceId, id);
      wss.handleUpgrade(req, socket, head, (ws) => {
        room.attach(
          (data) => ws.send(data),
          (code, reason) => ws.close(code ?? 1000, reason),
        );
        if (room.closed) ws.close(room.closed.code ?? 1000, room.closed.reason);
        ws.on('message', (data: RawData) => {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
          if (text === PING) return ws.send(PONG);
          room.say(text).catch((e: unknown) => console.error('[room]', e));
        });
        ws.on('close', () => room.close());
        ws.on('error', () => room.close());
      });
    })().catch((e: unknown) => {
      console.error('[room] upgrade failed', e);
      socket.destroy();
    });
  });
}

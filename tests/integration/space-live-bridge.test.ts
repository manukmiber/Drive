// W4 (ADR-098): the dev server's WebSocket bridge to a Space's live room, over a real socket — the
// path the app takes in dev. The Worker's checks still decide who gets in (ADR-096).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { bridgeRooms } from '../../dev/ws-bridge';
import type { ServerFrame } from '../../src/shared/space-room';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

// Sockets and the server go before the runtime does (tests/helpers/runtime.ts closes it after).
const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x();
});

async function json<T>(s: Session, method: string, path: string, body?: unknown) {
  const res = await s.req(method, path, body);
  expect(res.ok, `${method} ${path}: ${await res.clone().text()}`).toBe(true);
  return (await res.json()) as T;
}

async function setup() {
  const rt = await makeRuntime({ rooms: true });
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES ('spaces_open', 'true', 'test', 0)`,
    )
    .run();
  invalidateConfigMemo(rt.env);
  const owner = await signIn(rt, 'pemilik-ws@example.com');
  const member = await signIn(rt, 'anggota-ws@example.com');
  const stranger = await signIn(rt, 'orang-ws@example.com');
  const { team } = await json<{ team: { id: string } }>(owner, 'POST', '/api/teams', {
    name: 'Studio',
  });
  await json(owner, 'POST', `/api/teams/${team.id}/members`, { email: 'anggota-ws@example.com' });
  const { space } = await json<{ space: { id: string } }>(
    owner,
    'POST',
    `/api/teams/${team.id}/spaces`,
    { name: 'Klien' },
  );
  await json(owner, 'POST', `/api/spaces/${space.id}/members`, {
    email: 'anggota-ws@example.com',
    role: 'member',
  });

  const server: Server = createServer((_, res) => res.writeHead(404).end());
  bridgeRooms(server, rt.rooms!, (req) => rt.fetch(req));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  return { rt, owner, member, stranger, team, space, port };
}

/** A browser-like socket: the app's Origin and the person's cookies. */
class Client {
  readonly frames: Array<ServerFrame | { t: 'pong' }> = [];
  readonly ws: WebSocket;
  private waiters: Array<() => void> = [];
  closed: { code: number } | null = null;

  constructor(port: number, spaceId: string, s: Session | null, origin = APP) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/spaces/${spaceId}/live`, {
      headers: { origin, ...(s ? { cookie: s.jar.header() } : {}) },
    });
    this.ws.on('message', (d) => {
      this.frames.push(JSON.parse(String(d)) as ServerFrame);
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on('close', (code) => {
      this.closed = { code };
      this.waiters.splice(0).forEach((w) => w());
    });
    open.push(async () => {
      if (this.ws.readyState === WebSocket.CLOSED) return;
      const gone = new Promise<void>((r) => this.ws.once('close', () => r()));
      this.ws.terminate();
      await gone;
    });
  }

  /** Waits for a frame of this kind (the first one not yet taken). */
  async next<T extends string>(t: T): Promise<Extract<ServerFrame | { t: 'pong' }, { t: T }>> {
    for (let i = 0; i < 100; i++) {
      const at = this.frames.findIndex((f) => f.t === t);
      if (at >= 0) return this.frames.splice(at, 1)[0] as never;
      if (this.closed) throw new Error(`closed ${this.closed.code} before ${t}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
    throw new Error(`no ${t}`);
  }

  async closedWith(): Promise<number> {
    for (let i = 0; i < 100 && !this.closed; i++) await new Promise((r) => setTimeout(r, 20));
    return this.closed?.code ?? -1;
  }

  send(f: unknown) {
    this.ws.send(typeof f === 'string' ? f : JSON.stringify(f));
  }
}

/** The status the handshake was refused with. */
function refused(port: number, spaceId: string, s: Session | null, origin = APP) {
  return new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/spaces/${spaceId}/live`, {
      headers: { origin, ...(s ? { cookie: s.jar.header() } : {}) },
    });
    ws.on('unexpected-response', (_, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => {});
  });
}

describe('dev WebSocket bridge to Space rooms (ADR-098)', () => {
  it('carries frames both ways between two people, and answers pings itself', async () => {
    const { owner, member, space, port } = await setup();
    const a = new Client(port, space.id, owner);
    const b = new Client(port, space.id, member);
    const hi = await a.next('hello');
    expect(hi).toMatchObject({ role: 'admin', readonly: false });
    const topic = hi.topics[0]!.id;
    await b.next('hello');
    await a.next('presence');

    a.send({ t: 'send', topic, text: 'Halo <@' + member.userId + '>', nonce: 'n1' });
    const mine = await a.next('msg');
    expect(mine.nonce).toBe('n1');
    const theirs = await b.next('msg');
    expect(theirs.message).toMatchObject({
      text: `Halo <@${member.userId}>`,
      author: owner.userId,
    });
    expect(theirs.nonce).toBeUndefined();

    b.send('{"t":"ping"}');
    expect(await b.next('pong')).toEqual({ t: 'pong' });

    b.send({ t: 'history', topic });
    const h = await b.next('history');
    expect(h.messages.map((m) => m.id)).toEqual([mine.message.id]);

    // Gone from one side: the other hears they left.
    b.ws.close();
    expect(await a.next('presence')).toEqual({ t: 'presence', user: member.userId, online: false });
  });

  it('refuses whoever the Worker refuses: strangers, signed-out people, other sites', async () => {
    const { stranger, owner, space, port } = await setup();
    expect(await refused(port, space.id, stranger)).toBe(404);
    expect(await refused(port, space.id, null)).toBe(401);
    expect(await refused(port, space.id, owner, 'https://elsewhere.example')).toBe(403);
    expect(await refused(port, space.id, owner)).toBe(101);
  });

  it('closes the socket of someone taken out of the Space', async () => {
    const { owner, member, space, port, rt } = await setup();
    const b = new Client(port, space.id, member);
    await b.next('hello');
    const res = await owner.req('DELETE', `/api/spaces/${space.id}/members/${member.userId}`);
    expect(res.status).toBe(204);
    await rt.settle();
    expect(await b.closedWith()).toBe(4403);
  });
});

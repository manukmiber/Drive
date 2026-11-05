// W3/W4 (ADR-096): a Space's live room through the Worker — who may connect, the room following
// membership, mentions as notices, and what goes when a Space or an account does.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import type { DevRoomSocket } from '../../dev/shims/space-room';
import { FakeClock } from '../../src/worker/adapters/clock';
import { DAY_MS } from '../../src/shared/constants';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { noticesOf } from '../helpers/notices';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

function setConfig(rt: DevRuntime, key: string, value: unknown) {
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES (?, ?, 'test', 0)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
  void rt.env.CONFIG_KV.delete('config:v1');
  invalidateConfigMemo(rt.env);
}

async function json<T>(s: Session, method: string, path: string, body?: unknown, want = 200) {
  const res = await s.req(method, path, body);
  expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(want);
  return (await res.json()) as T;
}

/** A team with one Space: its owner, a member and a guest (the client). */
async function setup(clock?: FakeClock) {
  const rt = await makeRuntime({ rooms: true, ...(clock ? { clock } : {}) });
  setConfig(rt, 'spaces_open', true);
  const owner = await signIn(rt, 'pemilik-live@example.com');
  const member = await signIn(rt, 'anggota-live@example.com');
  const guest = await signIn(rt, 'klien-live@example.com');
  const stranger = await signIn(rt, 'orang-lain-live@example.com');
  const team = (
    await json<{ team: { id: string } }>(owner, 'POST', '/api/teams', { name: 'Studio' }, 201)
  ).team;
  await json(owner, 'POST', `/api/teams/${team.id}/members`, { email: 'anggota-live@example.com' });
  const space = (
    await json<{ space: { id: string } }>(
      owner,
      'POST',
      `/api/teams/${team.id}/spaces`,
      { name: 'Klien' },
      201,
    )
  ).space;
  await json(owner, 'POST', `/api/spaces/${space.id}/members`, {
    email: 'anggota-live@example.com',
    role: 'member',
  });
  await json(owner, 'POST', `/api/spaces/${space.id}/members`, {
    email: 'klien-live@example.com',
    role: 'guest',
  });
  return { rt, owner, member, guest, stranger, team, space };
}

const live = (s: Session, spaceId: string) =>
  s.req('GET', `/api/spaces/${spaceId}/live`, undefined, { headers: { upgrade: 'websocket' } });

/** The handshake with headers of our own choosing (the session helper always writes its own). */
const handshake = (rt: DevRuntime, spaceId: string, headers: Record<string, string>) =>
  rt.fetch(
    new Request(`${APP}/api/spaces/${spaceId}/live`, {
      headers: { upgrade: 'websocket', origin: APP, ...headers },
    }),
  );

async function connect(rt: DevRuntime, s: Session, spaceId: string): Promise<DevRoomSocket> {
  const res = await live(s, spaceId);
  expect(res.status, await res.clone().text()).toBe(200);
  return rt.rooms!.socket(spaceId, ((await res.json()) as { socket: string }).socket);
}

describe('Spaces live room (W3/W4, ADR-096)', () => {
  it('lets in only people of the Space, from the app, signed in, over a WebSocket', async () => {
    const { rt, member, stranger, space } = await setup();
    expect((await member.req('GET', `/api/spaces/${space.id}/live`)).status).toBe(426);
    expect(
      (
        await handshake(rt, space.id, {
          origin: 'https://jahat.example',
          cookie: member.jar.header(),
        })
      ).status,
    ).toBe(403);
    expect((await live(stranger, space.id)).status).toBe(404);
    expect((await handshake(rt, space.id, {})).status).toBe(401);

    const sock = await connect(rt, member, space.id);
    expect(sock.state).toMatchObject({ user: member.userId, role: 'member', readonly: false });
    expect(sock.last('hello')?.topics.map((t) => t.name)).toEqual(['umum']);

    // A frozen team's rooms stay shut; a read-only one opens for reading.
    rt.access.sqlite.prepare(`UPDATE teams SET status = 'frozen'`).run();
    expect((await live(member, space.id)).status).toBe(403);
    rt.access.sqlite.prepare(`UPDATE teams SET status = 'readonly'`).run();
    expect((await connect(rt, member, space.id)).state.readonly).toBe(true);
  });

  it('remembers who was in the room, and its first topic speaks their language', async () => {
    const { rt, owner, space } = await setup();
    const res = await handshake(rt, space.id, { cookie: `${owner.jar.header()}; zk_lang=en` });
    expect(res.status).toBe(200);
    const sock = rt.rooms!.socket(space.id, ((await res.json()) as { socket: string }).socket);
    expect(sock.last('hello')?.topics[0]?.name).toBe('general');
    expect(
      rt.access.sqlite.prepare('SELECT user_id FROM space_seen WHERE space_id = ?').all(space.id),
    ).toEqual([{ user_id: owner.userId }]);
  });

  it('follows membership: whoever is taken out of the Space or the team is disconnected', async () => {
    const { rt, owner, member, guest, team, space } = await setup();
    const o = await connect(rt, owner, space.id);
    const g = await connect(rt, guest, space.id);
    const m = await connect(rt, member, space.id);
    await o.say({ t: 'topic.create', name: 'internal' });
    expect(m.last('topic')?.topic.name).toBe('internal');
    expect(g.of('topic')).toEqual([]);

    expect(
      (await owner.req('DELETE', `/api/spaces/${space.id}/members/${guest.userId}`)).status,
    ).toBe(204);
    await rt.settle();
    expect(g.closed?.code).toBe(4403);

    // Taken off the team, they are out of its Spaces, and out of the room.
    expect(
      (await owner.req('DELETE', `/api/teams/${team.id}/members/${member.userId}`)).status,
    ).toBe(204);
    await rt.settle();
    expect(m.closed?.code).toBe(4403);
  });

  it('turns a mention of someone away into a notice, never for a guest outside their topics', async () => {
    const { rt, owner, member, guest, space } = await setup();
    const o = await connect(rt, owner, space.id);
    const general = o.last('hello')!.topics[0]!.id;
    await o.say({ t: 'topic.create', name: 'internal' });
    const internal = o.last('topic')!.topic.id;

    await o.say({ t: 'send', topic: general, text: `tolong cek <@${member.userId}>` });
    await o.say({ t: 'send', topic: internal, text: `jangan bilang <@${guest.userId}>` });
    await o.say({ t: 'send', topic: general, text: `selamat datang <@${guest.userId}>` });
    await rt.settle();

    const toMember = (await noticesOf(rt, member.userId)).filter((n) => n.type === 'space_mention');
    expect(toMember).toHaveLength(1);
    expect(toMember[0]!.payload).toMatchObject({
      space: space.id,
      spaceName: 'Klien',
      topic: general,
      topicName: 'umum',
      excerpt: 'tolong cek @',
    });
    const toGuest = (await noticesOf(rt, guest.userId)).filter((n) => n.type === 'space_mention');
    expect(toGuest.map((n) => n.payload.topic)).toEqual([general]);

    // Someone in the room sees it there and gets no notice.
    const m = await connect(rt, member, space.id);
    await o.say({ t: 'send', topic: general, text: `sudah di sini <@${member.userId}>` });
    await rt.settle();
    expect(
      (await noticesOf(rt, member.userId)).filter((n) => n.type === 'space_mention'),
    ).toHaveLength(1);
    expect(m.last('msg')?.message.text).toBe(`sudah di sini <@${member.userId}>`);
  });

  it('empties the room when its Space goes', async () => {
    const { rt, owner, member, space } = await setup();
    const m = await connect(rt, member, space.id);
    await m.say({ t: 'send', topic: m.last('hello')!.topics[0]!.id, text: 'catatan' });
    expect(rt.rooms!.peek(space.id)?.count('messages')).toBe(1);
    expect((await owner.req('DELETE', `/api/spaces/${space.id}`)).status).toBe(204);
    await rt.settle();
    expect(rt.rooms!.wasPurged(space.id)).toBe(true);
    expect(m.closed?.code).toBe(4410);
    expect(rt.access.sqlite.prepare('SELECT COUNT(*) AS n FROM space_seen').get()).toEqual({
      n: 0,
    });
  });

  it("exports what a person wrote, and a deleted account's messages leave every room", async () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 5));
    const { rt, owner, member, space } = await setup(clock);
    const m = await connect(rt, member, space.id);
    const o = await connect(rt, owner, space.id);
    const topic = m.last('hello')!.topics[0]!.id;
    await m.say({ t: 'send', topic, text: 'dari anggota' });
    const root = m.last('msg')!.message;
    await o.say({ t: 'send', topic, text: 'jawaban pemilik', thread: root.id });
    await m.say({ t: 'send', topic, text: 'satu lagi' });

    const exported = await json<{
      spaceChat: { rooms: Array<{ spaceId: string; messages: Array<{ text: string }> }> };
    }>(member, 'GET', '/api/me/export');
    expect(exported.spaceChat.rooms).toEqual([
      {
        spaceId: space.id,
        messages: [
          expect.objectContaining({ text: 'dari anggota' }),
          expect.objectContaining({ text: 'satu lagi' }),
        ],
      },
    ]);

    // They leave the Space first; their messages still go when the account does (T15).
    expect(
      (await member.req('DELETE', `/api/spaces/${space.id}/members/${member.userId}`)).status,
    ).toBe(204);
    await json(member, 'POST', '/api/me/delete', { confirmEmail: 'anggota-live@example.com' });
    clock.advance(8 * DAY_MS);
    await rt.runCron('0 19 * * *');
    await rt.settle();

    await o.say({ t: 'history', topic });
    expect(o.last('history')?.messages).toEqual([
      expect.objectContaining({ id: root.id, author: null, text: null, replies: 1 }),
    ]);
    await o.say({ t: 'history', topic, thread: root.id });
    expect(o.last('history')?.messages.map((x) => x.text)).toEqual(['jawaban pemilik']);
    expect(
      rt.access.sqlite
        .prepare('SELECT COUNT(*) AS n FROM space_seen WHERE user_id = ?')
        .get(member.userId),
    ).toEqual({ n: 0 });
  });

  it('without the binding there is no room to connect to', async () => {
    const rt = await makeRuntime();
    setConfig(rt, 'spaces_open', true);
    const s = await signIn(rt, 'tanpa-ruang@example.com');
    const team = (await json<{ team: { id: string } }>(s, 'POST', '/api/teams', { name: 'T' }, 201))
      .team;
    const space = (
      await json<{ space: { id: string } }>(
        s,
        'POST',
        `/api/teams/${team.id}/spaces`,
        { name: 'S' },
        201,
      )
    ).space;
    expect((await live(s, space.id)).status).toBe(404);
  });
});

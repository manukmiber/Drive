// W6 (ADR-100): files edited together through a Space's live room — one live copy per file, one
// person seeds it, one saves it, and it goes when nobody has it open and the file holds it all.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import type { DevRoomSocket } from '../../dev/shims/space-room';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const NODE = '01JD00000000000000000D0C01';

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
  const owner = await signIn(rt, 'pemilik-doc@example.com');
  const member = await signIn(rt, 'anggota-doc@example.com');
  const guest = await signIn(rt, 'tamu-doc@example.com');
  const { team } = await json<{ team: { id: string } }>(owner, 'POST', '/api/teams', {
    name: 'Studio',
  });
  await json(owner, 'POST', `/api/teams/${team.id}/members`, { email: 'anggota-doc@example.com' });
  const { space } = await json<{ space: { id: string } }>(
    owner,
    'POST',
    `/api/teams/${team.id}/spaces`,
    { name: 'Klien' },
  );
  for (const [email, role] of [
    ['anggota-doc@example.com', 'member'],
    ['tamu-doc@example.com', 'guest'],
  ])
    await json(owner, 'POST', `/api/spaces/${space.id}/members`, { email, role });
  return { rt, owner, member, guest, space };
}

async function connect(rt: DevRuntime, s: Session, spaceId: string): Promise<DevRoomSocket> {
  const res = await s.req('GET', `/api/spaces/${spaceId}/live`, undefined, {
    headers: { upgrade: 'websocket' },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return rt.rooms!.socket(spaceId, ((await res.json()) as { socket: string }).socket);
}

type Any = Record<string, unknown> & { t: string };
const of = (s: DevRoomSocket, t: string) => (s.frames as unknown as Any[]).filter((f) => f.t === t);
const last = (s: DevRoomSocket, t: string) => of(s, t).at(-1);

describe('Editing a Space’s files together (W6, ADR-100)', () => {
  it('asks the first person to seed, shares every change in order, and names the saver', async () => {
    const { rt, owner, member, space } = await setup();
    const a = await connect(rt, owner, space.id);
    const b = await connect(rt, member, space.id);

    await a.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(a, 'doc.state')).toMatchObject({ items: [], seed: true, saver: true });
    await b.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(b, 'doc.state')).toMatchObject({ items: [], seed: false, saver: false });
    expect((last(a, 'doc.people')?.people as unknown[]).length).toBe(2);

    // Before the seed nobody can push; the wrong person cannot seed.
    await b.say({ t: 'doc.push', node: NODE, data: 'x', nonce: 'n0' });
    expect(last(b, 'error')).toMatchObject({ code: 'not_found', nonce: `doc:${NODE}` });
    await b.say({ t: 'doc.seed', node: NODE, data: 'SEED' });
    expect(last(b, 'error')).toMatchObject({ code: 'forbidden' });

    await a.say({ t: 'doc.seed', node: NODE, data: 'SEED' });
    expect(last(b, 'doc.push')).toMatchObject({ item: { data: 'SEED' }, user: owner.userId });
    await b.say({ t: 'doc.push', node: NODE, data: 'B1', nonce: 'n1' });
    const ack = last(b, 'doc.ack') as unknown as { seq: number; nonce: string };
    expect(ack.nonce).toBe('n1');
    expect(last(a, 'doc.push')).toMatchObject({ item: { seq: ack.seq, data: 'B1' } });

    // Cursors pass through and are not kept.
    await b.say({ t: 'doc.aware', node: NODE, data: 'cursor' });
    expect(last(a, 'doc.aware')).toMatchObject({ data: 'cursor', user: member.userId });

    // Someone joining late gets everything, in order.
    const c = await connect(rt, member, space.id);
    await c.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect((last(c, 'doc.state')?.items as Array<{ data: string }>).map((i) => i.data)).toEqual([
      'SEED',
      'B1',
    ]);

    // The saver leaves: the next oldest saves now.
    a.clear();
    b.clear();
    await a.say({ t: 'doc.leave', node: NODE });
    expect(of(b, 'doc.saver')).toHaveLength(1);
  });

  it('asks someone else to seed when the person asked left first', async () => {
    const { rt, owner, member, space } = await setup();
    const a = await connect(rt, owner, space.id);
    const b = await connect(rt, member, space.id);
    await a.say({ t: 'doc.join', node: NODE, kind: 'sheet' });
    await b.say({ t: 'doc.join', node: NODE, kind: 'sheet' });
    a.close();
    expect(of(b, 'doc.seedme')).toHaveLength(1);
    await b.say({ t: 'doc.seed', node: NODE, data: '{"snap":[]}' });
    expect(last(b, 'doc.ack')).toMatchObject({ nonce: 'seed' });
    // The same file cannot be opened as the other kind meanwhile.
    const c = await connect(rt, owner, space.id);
    await c.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(c, 'error')).toMatchObject({ code: 'bad_frame' });
  });

  it('keeps unsaved changes after everyone left, and lets go once the file holds them', async () => {
    const { rt, owner, space } = await setup();
    let a = await connect(rt, owner, space.id);
    await a.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    await a.say({ t: 'doc.seed', node: NODE, data: 'S' });
    await a.say({ t: 'doc.push', node: NODE, data: 'P', nonce: 'n' });
    const seq = (last(a, 'doc.ack') as unknown as { seq: number }).seq;
    a.close();

    a = await connect(rt, owner, space.id);
    await a.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(a, 'doc.state')).toMatchObject({
      seed: false,
      items: [{ data: 'S' }, { data: 'P' }],
    });

    // The saver's whole copy stands for everything so far.
    await a.say({ t: 'doc.compact', node: NODE, upto: seq, data: 'ALL' });
    await a.say({ t: 'doc.saved', node: NODE, upto: seq });
    a.close();
    expect(rt.rooms!.peek(space.id)!.count('doc_items')).toBe(0);

    a = await connect(rt, owner, space.id);
    await a.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(a, 'doc.state')).toMatchObject({ seed: true, items: [] });
  });

  it('keeps guests out, and read-only teams from changing anything', async () => {
    const { rt, owner, guest, space } = await setup();
    const g = await connect(rt, guest, space.id);
    await g.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    expect(last(g, 'error')).toMatchObject({ code: 'forbidden' });
    expect(of(g, 'doc.state')).toEqual([]);

    const a = await connect(rt, owner, space.id);
    await a.say({ t: 'doc.join', node: NODE, kind: 'doc' });
    await a.say({ t: 'doc.seed', node: NODE, data: 'S' });
    rt.rooms!.peek(space.id)!.core.setReadonly(true);
    await a.say({ t: 'doc.push', node: NODE, data: 'P', nonce: 'n' });
    expect(last(a, 'error')).toMatchObject({ code: 'readonly' });

    // At most five files open per connection; a frame too big is refused.
    rt.rooms!.peek(space.id)!.core.setReadonly(false);
    for (let i = 2; i <= 5; i++)
      await a.say({ t: 'doc.join', node: `01JD00000000000000000D0C0${i}`, kind: 'doc' });
    await a.say({ t: 'doc.join', node: '01JD00000000000000000D0C09', kind: 'doc' });
    expect(last(a, 'error')).toMatchObject({ code: 'bad_frame' });
    await a.say({ t: 'doc.push', node: NODE, data: 'x'.repeat(950_000), nonce: 'big' });
    expect(last(a, 'error')).toMatchObject({ code: 'too_long' });
  });
});

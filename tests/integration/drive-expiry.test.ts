// D12 (ADR-082): a day on which a file or folder goes to the Trash by itself, kept only in the index.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { parseIndex } from '../../src/shared/drive-index';
import { FakeClock } from '../../src/worker/adapters/clock';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { noticesOf } from '../helpers/notices';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const T0 = Date.UTC(2026, 10, 1, 3, 0); // 1 Nov 2026 10:00 WIB
const NIGHTLY = '0 19 * * *';
/** The nightly run at 02:00 WIB on a WIB date. */
const nightOf = (date: string) => Date.parse(`${date}T02:00:00+07:00`);

interface NodeJson {
  id: string;
  expiresAt: number | null;
  trashedAt: number | null;
}

async function setup() {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, 'jadwal@example.com');
  await grantPlan(rt, s.userId);
  return { rt, s, clock, root: await rootOf(s) };
}

const expire = (s: Session, id: string, date: string | null) =>
  s.req('PUT', `/api/nodes/${id}/expiry`, { date });

async function node(s: Session, id: string): Promise<NodeJson> {
  const res = await s.req('GET', `/api/nodes/${id}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { node: NodeJson }).node;
}

async function nightly(rt: DevRuntime, clock: FakeClock, date: string) {
  clock.set(nightOf(date));
  const out = await rt.runCron(NIGHTLY);
  expect(out.failed).toEqual([]);
  await rt.settle();
}

async function personalIndex(rt: DevRuntime, userId: string) {
  const obj = await rt.r2.get(`u/${userId}/index.txt`);
  return parseIndex(obj && 'text' in obj ? await obj.text() : '');
}

describe('Auto-delete date (D12, ADR-082)', () => {
  it('keeps the day through a rename and a move, reminds the day before, then trashes', async () => {
    const { rt, s, clock, root } = await setup();
    const archive = await createFolder(s, root, 'Arsip');
    const f = await uploadText(s, root, 'tagihan.txt', 'lunas');
    await rt.settle();

    const set = await expire(s, f.id, '2026-11-05');
    expect(set.status, await set.clone().text()).toBe(200);
    const at = Date.parse('2026-11-05T00:00:00+07:00');
    expect(((await set.json()) as { node: NodeJson }).node.expiresAt).toBe(at);
    expect((await node(s, f.id)).expiresAt).toBe(at);
    // Only the index keeps it.
    const entry = (await personalIndex(rt, s.userId)).entries.find((e) => e.legacy === f.id)!;
    expect(entry.expiresAt).toBe(at);

    // Renamed and moved (D1 changes the index re-projects): the day stays.
    expect((await s.req('PATCH', `/api/nodes/${f.id}`, { name: 'tagihan-lama.txt' })).status).toBe(
      200,
    );
    expect(
      (await s.req('POST', '/api/nodes/move', { ids: [f.id], targetId: archive.id })).status,
    ).toBe(200);
    await rt.settle();
    expect((await node(s, f.id)).expiresAt).toBe(at);
    const listed = (await (await s.req('GET', `/api/nodes/${archive.id}/children`)).json()) as {
      items: NodeJson[];
    };
    expect(listed.items.map((n) => n.expiresAt)).toEqual([at]);

    // Two nights before: nothing. The night before: a reminder, and the file stays.
    await nightly(rt, clock, '2026-11-03');
    expect((await noticesOf(rt, s.userId)).filter((n) => n.type === 'file_expiring')).toEqual([]);
    await nightly(rt, clock, '2026-11-04');
    const reminders = (await noticesOf(rt, s.userId)).filter((n) => n.type === 'file_expiring');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.payload).toMatchObject({
      names: ['tagihan-lama.txt'],
      count: 1,
      date: at,
    });
    expect((await node(s, f.id)).trashedAt).toBeNull();

    // The day itself: in the Trash, the day forgotten (a restore keeps it), the marker gone.
    await nightly(rt, clock, '2026-11-05');
    const gone = await node(s, f.id);
    expect(gone.trashedAt).not.toBeNull();
    expect(gone.expiresAt).toBeNull();
    const trash = (await (await s.req('GET', '/api/trash')).json()) as { items: NodeJson[] };
    expect(trash.items.map((n) => n.id)).toEqual([f.id]);
    expect((await rt.r2.list({ prefix: 'sys/expiry/' })).objects).toEqual([]);
    expect((await s.req('POST', '/api/nodes/restore', { ids: [f.id] })).status).toBe(200);
    await nightly(rt, clock, '2026-11-06');
    expect((await node(s, f.id)).trashedAt).toBeNull();
  });

  it('takes a whole folder, and a cleared day does nothing', async () => {
    const { rt, s, clock, root } = await setup();
    const folder = await createFolder(s, root, 'Sementara');
    const inside = await uploadText(s, folder.id, 'a.txt', 'a');
    const kept = await uploadText(s, root, 'b.txt', 'b');
    await rt.settle();
    // A folder made a moment ago may not be in the stored index yet: the day still lands.
    expect((await expire(s, folder.id, '2026-11-02')).status).toBe(200);
    expect((await expire(s, kept.id, '2026-11-02')).status).toBe(200);
    expect((await expire(s, kept.id, null)).status).toBe(200);
    expect((await node(s, kept.id)).expiresAt).toBeNull();

    await nightly(rt, clock, '2026-11-02');
    expect((await node(s, folder.id)).trashedAt).not.toBeNull();
    expect((await node(s, inside.id)).trashedAt).not.toBeNull();
    expect((await node(s, kept.id)).trashedAt).toBeNull();
  });

  it('asks for the right to remove, a day from tomorrow, and a live item', async () => {
    const { rt, s, root } = await setup();
    const f = await uploadText(s, root, 'x.txt', 'x');
    const other = await signIn(rt, 'orang-lain@example.com');
    await rt.settle();

    expect((await expire(other, f.id, '2026-11-05')).status).toBe(404);
    expect((await expire(s, root, '2026-11-05')).status).toBe(403);
    for (const date of ['2026-11-01', '2026-10-30', '2026-02-30', '2046-11-05'])
      expect((await expire(s, f.id, date)).status, date).toBe(400);
    expect((await expire(s, f.id, '2026-11-02')).status).toBe(200);
    expect((await s.req('POST', '/api/nodes/trash', { ids: [f.id] })).status).toBe(200);
    expect((await expire(s, f.id, '2026-11-03')).status).toBe(400);
  });

  it('in a family, only those who may remove an item set its day; the maker is reminded', async () => {
    const clock = new FakeClock(T0);
    const rt = await makeRuntime({ clock });
    rt.d1.sqlite
      .prepare(
        "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
      )
      .run();
    const owner = await signIn(rt, 'ibu-jadwal@example.com');
    const member = await signIn(rt, 'kakak-jadwal@example.com');
    rt.d1.sqlite
      .prepare('INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, 100000, 0)')
      .run(owner.userId);
    for (const code of ['mini', 'family'])
      expect(
        (await owner.req('POST', '/api/billing/checkout', { item: { kind: 'plan', code } })).status,
      ).toBe(200);
    const invite = (
      (await (await owner.req('POST', '/api/family/invites', { channel: 'link' })).json()) as {
        url: string;
      }
    ).url
      .split('/')
      .pop()!;
    expect((await member.req('POST', `/api/family/invites/${invite}/accept`, {})).status).toBe(200);
    const famRoot = (
      (await (await owner.req('GET', '/api/me')).json()) as { space: { familyRootId: string } }
    ).space.familyRootId;
    const ownersFile = await uploadText(owner, famRoot, 'ibu.txt', 'i');
    const membersFile = await uploadText(member, famRoot, 'kakak.txt', 'k');
    await rt.settle();

    expect((await expire(member, ownersFile.id, '2026-11-03')).status).toBe(403);
    expect((await expire(member, membersFile.id, '2026-11-03')).status).toBe(200);
    // The family's owner may remove everything, so may set a day on it too.
    expect((await expire(owner, ownersFile.id, '2026-11-03')).status).toBe(200);
    expect((await node(owner, membersFile.id)).expiresAt).not.toBeNull();

    await nightly(rt, clock, '2026-11-02');
    const told = async (s: Session) =>
      (await noticesOf(rt, s.userId))
        .filter((n) => n.type === 'file_expiring')
        .map((n) => (n.payload as { names: string[] }).names);
    expect(await told(member)).toEqual([['kakak.txt']]);
    expect(await told(owner)).toEqual([['ibu.txt']]);

    await nightly(rt, clock, '2026-11-03');
    // Each item lands in the Trash of the member who made it.
    const trash = async (s: Session) =>
      ((await (await s.req('GET', '/api/trash')).json()) as { items: NodeJson[] }).items.map(
        (n) => n.id,
      );
    expect(await trash(member)).toEqual([membersFile.id]);
    expect(await trash(owner)).toEqual([ownersFile.id]);
  });
});

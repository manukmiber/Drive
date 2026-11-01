// D4 (ADR-083): the Activity panel, from a log per space and month in R2 (no D1 table).
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import type { ActivityItem } from '../../src/shared/activity';
import { DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { createFolder, grantPlan, rootOf, simpleUpload, uploadText } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

const T0 = Date.UTC(2026, 10, 10, 3, 0); // 10 Nov 2026 10:00 WIB

async function items(s: Session, path: string): Promise<ActivityItem[]> {
  const res = await s.req('GET', path);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { items: ActivityItem[] }).items;
}

const recent = (s: Session) => items(s, '/api/activity');
const of = (s: Session, id: string) => items(s, `/api/nodes/${id}/activity`);

async function setup(clock = new FakeClock(T0)) {
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, 'aktivitas@example.com');
  await grantPlan(rt, s.userId);
  return { rt, s, clock, root: await rootOf(s) };
}

async function family(rt: DevRuntime) {
  rt.d1.sqlite
    .prepare(
      "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
    )
    .run();
  const owner = await signIn(rt, 'ibu-aktivitas@example.com');
  const member = await signIn(rt, 'kakak-aktivitas@example.com');
  rt.d1.sqlite.prepare("UPDATE users SET name = 'Kakak' WHERE id = ?").run(member.userId);
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
  return { owner, member, famRoot };
}

describe('Activity (D4, ADR-083)', () => {
  it('logs every kind of change, newest first, in R2 and not in D1', async () => {
    const { rt, s, clock, root } = await setup();
    const tick = () => clock.advance(1000);
    const docs = await createFolder(s, root, 'Dokumen');
    tick();
    const f = await uploadText(s, docs.id, 'surat.txt', 'isi');
    await rt.settle();
    tick();
    expect((await s.req('PATCH', `/api/nodes/${f.id}`, { name: 'surat-final.txt' })).status).toBe(
      200,
    );
    tick();
    expect((await s.req('POST', '/api/nodes/move', { ids: [f.id], targetId: root })).status).toBe(
      200,
    );
    tick();
    const copy = await s.req('POST', `/api/nodes/${f.id}/copy`, { targetId: docs.id });
    expect(copy.status).toBe(201);
    const copied = ((await copy.json()) as { node: { id: string } }).node;
    tick();
    expect((await s.req('POST', '/api/nodes/decor', { ids: [docs.id], color: 'red' })).status).toBe(
      200,
    );
    tick();
    const share = await s.req('POST', '/api/shares', { nodeIds: [f.id] });
    expect(share.status).toBe(201);
    const shareId = ((await share.json()) as { share: { id: string } }).share.id;
    tick();
    expect((await s.req('DELETE', `/api/shares/${shareId}`)).status).toBe(204);
    tick();
    const again = await simpleUpload(s, root, 'surat-final.txt', 'isi baru', {
      onConflict: 'replace',
    });
    expect(again.status).toBe(201);
    const replaced = ((await again.json()) as { node: { id: string } }).node;
    // D1 (ADR-084): the same file, its old content a version.
    expect(replaced.id).toBe(f.id);
    await rt.settle();
    tick();
    const versions = (await (await s.req('GET', `/api/nodes/${f.id}/versions`)).json()) as {
      items: Array<{ id: string }>;
    };
    expect(
      (await s.req('POST', `/api/nodes/${f.id}/versions/${versions.items[0]!.id}/restore`)).status,
    ).toBe(200);
    tick();
    expect((await s.req('POST', '/api/nodes/trash', { ids: [copied.id] })).status).toBe(200);
    tick();
    expect((await s.req('POST', '/api/nodes/delete', { ids: [copied.id] })).status).toBe(200);
    await rt.settle();

    const all = await recent(s);
    expect(all.map((e) => e.action)).toEqual([
      'delete',
      'trash',
      'revert',
      'replace',
      'unshare',
      'share',
      'decor',
      'copy',
      'move',
      'rename',
      'upload',
      'create',
    ]);
    expect(all.every((e) => e.actorId === s.userId && e.actorName === null)).toBe(true);
    expect(all.find((e) => e.action === 'rename')).toMatchObject({
      nodeId: f.id,
      from: 'surat.txt',
      to: 'surat-final.txt',
    });
    expect(all.find((e) => e.action === 'move')).toMatchObject({
      from: 'Dokumen',
      to: 'Drive Saya',
    });
    expect(all.find((e) => e.action === 'replace')!.nodeId).toBe(replaced.id);
    expect(all.find((e) => e.action === 'copy')).toMatchObject({
      nodeId: copied.id,
      from: 'surat-final.txt',
    });

    // A file: only its own events. A folder: its own and its direct contents', including what left.
    expect((await of(s, f.id)).map((e) => e.action)).toEqual([
      'revert',
      'replace',
      'unshare',
      'share',
      'move',
      'rename',
      'upload',
    ]);
    expect((await of(s, docs.id)).map((e) => e.action)).toEqual([
      'delete',
      'trash',
      'decor',
      'copy',
      'move',
      'rename',
      'upload',
      'create',
    ]);

    // The log is a month's object next to the index; D1 has no such table.
    const month = await rt.r2.get(`u/${s.userId}/log/2026-11.txt`);
    expect(month && 'text' in month ? (await month.text()).split('\n').length : 0).toBe(13);
    const tables = rt.d1.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%event%'")
      .all();
    expect(tables).toEqual([]);
    const exported = (await (await s.req('GET', '/api/me/export')).json()) as {
      activity: ActivityItem[];
    };
    expect(exported.activity).toHaveLength(12);
  });

  it('shows a node only to who may see it; a family sees its space, with names', async () => {
    const rt = await makeRuntime();
    const { owner, member, famRoot } = await family(rt);
    const outsider = await signIn(rt, 'luar-aktivitas@example.com');
    const shared = await uploadText(member, famRoot, 'resep.txt', 'r');
    const secret = await uploadText(owner, await rootOf(owner), 'pribadi.txt', 'p');
    await rt.settle();

    const seen = await of(owner, shared.id);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      action: 'upload',
      actorId: member.userId,
      actorName: 'Kakak',
      space: 'family',
    });
    expect((await of(member, famRoot)).map((e) => e.nodeId)).toEqual([shared.id]);
    // Personal activity stays personal, and nobody outside reaches either.
    expect((await member.req('GET', `/api/nodes/${secret.id}/activity`)).status).toBe(404);
    for (const id of [shared.id, secret.id])
      expect((await outsider.req('GET', `/api/nodes/${id}/activity`)).status).toBe(404);
    expect((await recent(member)).map((e) => e.nodeId)).toEqual([shared.id]);
    expect((await recent(owner)).map((e) => e.nodeId).sort()).toEqual(
      [shared.id, secret.id].sort(),
    );
    expect(await recent(outsider)).toEqual([]);

    // Ending the family drops its log.
    expect((await member.req('POST', '/api/family/leave')).status).toBe(204);
    expect((await owner.req('POST', '/api/family/dissolve')).status).toBe(200);
    await rt.settle();
    const famId = (
      rt.d1.sqlite.prepare('SELECT family_id FROM nodes WHERE id = ?').get(shared.id) as {
        family_id: string | null;
      }
    ).family_id;
    expect(famId).toBeNull();
    const left = await rt.r2.list({ prefix: 'f/' });
    expect(left.objects.filter((o) => o.key.includes('/log/'))).toEqual([]);
  });

  it('looks back activity_keep_days, and the nightly run drops older months', async () => {
    const { rt, s, clock, root } = await setup();
    await createFolder(s, root, 'Lama');
    await rt.settle();
    expect(await recent(s)).toHaveLength(1);
    expect((await rt.r2.list({ prefix: 'sys/activity/' })).objects).toHaveLength(1);

    // Past retention the panel no longer shows it; the month goes once all of it is that old.
    clock.advance(91 * DAY_MS);
    expect(await recent(s)).toEqual([]);
    expect((await rt.runCron('0 19 * * *')).failed).toEqual([]);
    expect(await rt.r2.get(`u/${s.userId}/log/2026-11.txt`)).not.toBeNull();
    clock.advance(30 * DAY_MS);
    expect((await rt.runCron('0 19 * * *')).failed).toEqual([]);
    expect(await rt.r2.get(`u/${s.userId}/log/2026-11.txt`)).toBeNull();
    expect((await rt.r2.list({ prefix: 'sys/activity/' })).objects).toEqual([]);
  });
});

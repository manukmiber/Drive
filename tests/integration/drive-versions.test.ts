// D1 (ADR-084): version history. Replacing a file keeps its old content as a version, counted in
// the quota, for at most version_keep_days, as many as the person chose.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { parseIndex } from '../../src/shared/drive-index';
import { DAY_MS } from '../../src/shared/constants';
import { FakeClock } from '../../src/worker/adapters/clock';
import { downloadPath, grantPlan, pool, rootOf, simpleUpload, uploadText } from '../helpers/files';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface Version {
  id: string;
  number: number;
  size: number;
  kept: boolean;
}

const T0 = Date.UTC(2026, 10, 1, 3, 0);

async function setup() {
  const clock = new FakeClock(T0);
  const rt = await makeRuntime({ clock });
  const s = await signIn(rt, 'versi@example.com');
  const poolId = await grantPlan(rt, s.userId);
  return { rt, s, clock, poolId, root: await rootOf(s) };
}

async function replace(rt: DevRuntime, s: Session, parentId: string, name: string, text: string) {
  const res = await simpleUpload(s, parentId, name, text, { onConflict: 'replace' });
  expect(res.status, await res.clone().text()).toBe(201);
  await rt.settle();
  return ((await res.json()) as { node: { id: string } }).node;
}

async function versions(s: Session, id: string) {
  const res = await s.req('GET', `/api/nodes/${id}/versions`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { items: Version[]; keep: number; days: number };
}

async function content(rt: DevRuntime, s: Session, path: string) {
  const res = await s.req('GET', path);
  expect(res.status, await res.clone().text()).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return (await rt.fetch(new Request(`${APP}${url}`))).text();
}

const read = async (rt: DevRuntime, s: Session, id: string) =>
  (await rt.fetch(new Request(`${APP}${await downloadPath(s, id)}`))).text();

describe('Version history (D1, ADR-084)', () => {
  it('keeps the file and its links; the old content becomes a version counted in the quota', async () => {
    const { rt, s, poolId, root } = await setup();
    const f = await uploadText(s, root, 'catatan.txt', 'satu');
    await rt.settle();
    const share = await s.req('POST', '/api/shares', { nodeIds: [f.id] });
    const link = ((await share.json()) as { share: { url: string } }).share.url;

    const again = await replace(rt, s, root, 'catatan.txt', 'dua!!');
    expect(again.id).toBe(f.id);
    expect(await read(rt, s, f.id)).toBe('dua!!');
    // The link gives the latest content.
    const viaLink = await rt.fetch(new Request(link.replace(/^https?:\/\/[^/]+/, APP)));
    expect(await viaLink.text()).toBe('dua!!');
    // Both contents count: 4 + 5 bytes.
    expect(pool(rt, poolId).used_bytes).toBe(9);

    const list = await versions(s, f.id);
    expect(list).toMatchObject({ keep: 10, days: 30 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ number: 1, size: 4, kept: false });
    const v1 = list.items[0]!.id;
    expect(await content(rt, s, `/api/nodes/${f.id}/versions/${v1}/download`)).toBe('satu');

    // The index shows it as the file's column, not as an entry of its own.
    const idx = parseIndex(await (await s.req('GET', '/api/drive/index')).text());
    expect(idx.entries.map((e) => e.legacy)).toEqual([f.id]);
    expect(idx.entries[0]!.versions.map((v) => v.id)).toEqual([v1]);
    // And it never shows in the Trash, search or Recent.
    const trash = (await (await s.req('GET', '/api/trash')).json()) as { items: unknown[] };
    expect(trash.items).toEqual([]);
    const recent = (await (await s.req('GET', '/api/recent')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(recent.items.map((n) => n.id)).not.toContain(v1);

    // Restore swaps: the file reads "satu" again, "dua!!" became a version; bytes unchanged.
    const back = await s.req('POST', `/api/nodes/${f.id}/versions/${v1}/restore`);
    expect(back.status, await back.clone().text()).toBe(200);
    await rt.settle();
    expect(await read(rt, s, f.id)).toBe('satu');
    const after = await versions(s, f.id);
    expect(after.items.map((v) => [v.number, v.size])).toEqual([[2, 5]]);
    expect(pool(rt, poolId).used_bytes).toBe(9);

    // Deleting a version gives its bytes back; the nightly reconcile agrees with every number.
    expect(
      (await s.req('DELETE', `/api/nodes/${f.id}/versions/${after.items[0]!.id}`)).status,
    ).toBe(204);
    await rt.settle();
    expect(pool(rt, poolId).used_bytes).toBe(4);
    await replace(rt, s, root, 'catatan.txt', 'tiga');
    expect((await rt.runCron('0 19 * * *')).failed).toEqual([]);
    expect(pool(rt, poolId).used_bytes).toBe(8);

    // Deleting the file for good takes its versions and their bytes.
    await s.req('POST', '/api/nodes/trash', { ids: [f.id] });
    expect((await s.req('POST', '/api/nodes/delete', { ids: [f.id] })).status).toBe(200);
    await rt.settle();
    expect(pool(rt, poolId).used_bytes).toBe(0);
    expect(
      rt.d1.sqlite.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind = 'version'").get(),
    ).toEqual({ n: 0 });
  });

  it('keeps as many as the person chose (kept ones aside), for at most 30 days', async () => {
    const { rt, s, clock, poolId, root } = await setup();
    const settings = await s.req('PUT', '/api/drive/settings', {
      space: 'personal',
      keepVersions: 2,
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const f = await uploadText(s, root, 'a.txt', 'v1');
    await rt.settle();
    await replace(rt, s, root, 'a.txt', 'v2');
    const first = (await versions(s, f.id)).items[0]!;
    expect(
      (await s.req('PUT', `/api/nodes/${f.id}/versions/${first.id}/keep`, { kept: true })).status,
    ).toBe(204);
    for (const text of ['v3', 'v4', 'v5']) await replace(rt, s, root, 'a.txt', text);
    const list = await versions(s, f.id);
    expect(list.keep).toBe(2);
    expect(list.items.map((v) => [v.number, v.kept])).toEqual([
      [4, false],
      [3, false],
      [1, true],
    ]);
    expect(pool(rt, poolId).used_bytes).toBe(8);

    // Lowering the count drops what is now past it.
    await s.req('PUT', '/api/drive/settings', { space: 'personal', keepVersions: 1 });
    expect((await versions(s, f.id)).items.map((v) => v.number)).toEqual([4, 1]);

    // After 30 days every version goes, kept or not.
    clock.advance(31 * DAY_MS);
    expect((await rt.runCron('0 19 * * *')).failed).toEqual([]);
    await rt.settle();
    expect((await versions(s, f.id)).items).toEqual([]);
    expect(pool(rt, poolId).used_bytes).toBe(2);

    // 0 turns history off: replacing works as before (the old file to the Trash, a new file).
    await s.req('PUT', '/api/drive/settings', { space: 'personal', keepVersions: 0 });
    const fresh = await replace(rt, s, root, 'a.txt', 'v6');
    expect(fresh.id).not.toBe(f.id);
    const trash = (await (await s.req('GET', '/api/trash')).json()) as {
      items: Array<{ id: string }>;
    };
    expect(trash.items.map((n) => n.id)).toEqual([f.id]);
  });

  it('is reached only through its file, with the file’s rights', async () => {
    const { rt, s, root } = await setup();
    const other = await signIn(rt, 'bukan-pemilik@example.com');
    await grantPlan(rt, other.userId);
    const f = await uploadText(s, root, 'rahasia.txt', 'lama');
    const g = await uploadText(s, root, 'lain.txt', 'x');
    await rt.settle();
    await replace(rt, s, root, 'rahasia.txt', 'baru');
    const v = (await versions(s, f.id)).items[0]!.id;

    for (const [method, path] of [
      ['GET', `/api/nodes/${f.id}/versions`],
      ['GET', `/api/nodes/${f.id}/versions/${v}/download`],
      ['POST', `/api/nodes/${f.id}/versions/${v}/restore`],
      ['DELETE', `/api/nodes/${f.id}/versions/${v}`],
    ] as const)
      expect((await other.req(method, path)).status, path).toBe(404);
    // A version under another file, or a version used as a node, is not found.
    expect((await s.req('GET', `/api/nodes/${g.id}/versions/${v}/download`)).status).toBe(404);
    for (const [method, path, body] of [
      ['GET', `/api/nodes/${v}`, undefined],
      ['GET', `/api/files/${v}/download`, undefined],
      ['PATCH', `/api/nodes/${v}`, { name: 'x.txt' }],
      ['POST', '/api/nodes/trash', { ids: [v] }],
      ['POST', '/api/shares', { nodeIds: [v] }],
      ['POST', `/api/nodes/${v}/copy`, {}],
    ] as const)
      expect((await s.req(method, path, body)).status, path).toBe(404);
    expect((await versions(s, f.id)).items).toHaveLength(1);
  });

  it('in a family: members see versions; only who may edit restores, only who may remove deletes', async () => {
    const rt = await makeRuntime();
    rt.d1.sqlite
      .prepare(
        "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
      )
      .run();
    const owner = await signIn(rt, 'ibu-versi@example.com');
    const member = await signIn(rt, 'kakak-versi@example.com');
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
    const f = await uploadText(owner, famRoot, 'jadwal.txt', 'senin');
    await rt.settle();
    await replace(rt, owner, famRoot, 'jadwal.txt', 'selasa');
    const v = (await versions(member, f.id)).items[0]!.id;
    expect(await content(rt, member, `/api/nodes/${f.id}/versions/${v}/download`)).toBe('senin');
    expect((await member.req('POST', `/api/nodes/${f.id}/versions/${v}/restore`)).status).toBe(403);
    expect((await member.req('DELETE', `/api/nodes/${f.id}/versions/${v}`)).status).toBe(403);
    // Only the family's owner sets the family's count.
    expect(
      (await member.req('PUT', '/api/drive/settings', { space: 'family', keepVersions: 3 })).status,
    ).toBe(403);
    expect(
      (await owner.req('PUT', '/api/drive/settings', { space: 'family', keepVersions: 3 })).status,
    ).toBe(200);
    expect((await versions(member, f.id)).keep).toBe(3);
  });
});

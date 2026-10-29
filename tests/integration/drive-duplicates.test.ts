// D11 (ADR-081): files with the same content, only ever inside the person's own pool.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { ENDPOINTS } from '../../src/worker/routes/v1';
import { createFolder, grantPlan, rootOf, uploadText } from '../helpers/files';
import { APP, makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface Found {
  groups: Array<{
    size: number;
    saving: number;
    items: Array<{ id: string; name: string; canRemove: boolean; path: Array<{ name: string }> }>;
  }>;
  saving: number;
}

async function duplicates(s: Session, path = '/api/drive/duplicates'): Promise<Found> {
  const res = await s.req('GET', path);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Found;
}

const ids = (g: Found['groups'][number]) => g.items.map((n) => n.id).sort();

async function person(rt: DevRuntime, email: string) {
  const s = await signIn(rt, email);
  await grantPlan(rt, s.userId);
  return { s, root: await rootOf(s) };
}

describe('Duplicate files (D11, ADR-081)', () => {
  it('groups the same content, and a "Make a copy" costs nothing extra', async () => {
    const rt = await makeRuntime();
    const { s, root } = await person(rt, 'kembar@example.com');
    const photos = await createFolder(s, root, 'Foto');
    const a = await uploadText(s, root, 'a.txt', 'sama persis');
    const b = await uploadText(s, photos.id, 'b.txt', 'sama persis');
    // Same size, other content: not a duplicate.
    await uploadText(s, root, 'c.txt', 'beda persis');
    const solo = await uploadText(s, root, 'd.txt', 'sendirian');
    await rt.settle();
    const copy = await s.req('POST', `/api/nodes/${a.id}/copy`, {});
    expect(copy.status).toBe(201);
    const copied = ((await copy.json()) as { node: { id: string } }).node;
    const soloCopy = await s.req('POST', `/api/nodes/${solo.id}/copy`, {});
    expect(soloCopy.status).toBe(201);
    await rt.settle();

    const found = await duplicates(s);
    expect(found.groups).toHaveLength(1);
    const [g] = found.groups;
    expect(ids(g!)).toEqual([a.id, b.id, copied.id].sort());
    // Two content objects: one copy's worth comes back.
    expect(g!.size).toBe(11);
    expect(g!.saving).toBe(11);
    expect(found.saving).toBe(11);
    expect(g!.items.find((n) => n.id === b.id)!.path.map((c) => c.name)).toEqual([
      'Drive Saya',
      'Foto',
    ]);
    expect(g!.items.every((n) => n.canRemove)).toBe(true);

    // The v1 API gives the same answer, in the shape it documents.
    const tok = await s.req('POST', '/api/tokens', {
      name: 'kembar',
      scopes: ['drive.read'],
      expiresInDays: null,
    });
    expect(tok.status).toBe(201);
    const { token } = (await tok.json()) as { token: string };
    const v1 = await rt.fetch(
      new Request(`${APP}/api/v1/drive/duplicates`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(v1.status, await v1.clone().text()).toBe(200);
    const body = await v1.json();
    ENDPOINTS.find((e) => e.def.path === '/drive/duplicates')!.def.responses[200]!.parse(body);
    expect((body as Found).groups.map(ids)).toEqual([ids(g!)]);

    // Trashing the extra object ends the group; the copy sharing the kept one is no waste.
    expect((await s.req('POST', '/api/nodes/trash', { ids: [b.id] })).status).toBe(200);
    expect((await duplicates(s)).groups).toEqual([]);
  });

  it('never groups across people, nor shows what anyone else keeps', async () => {
    const rt = await makeRuntime();
    const me = await person(rt, 'saya@example.com');
    const other = await person(rt, 'orang@example.com');
    await uploadText(me.s, me.root, 'rahasia.txt', 'isi yang sama');
    await uploadText(other.s, other.root, 'rahasia.txt', 'isi yang sama');
    await uploadText(other.s, other.root, 'salinan.txt', 'isi yang sama');
    await rt.settle();

    expect(await duplicates(me.s)).toEqual({ groups: [], saving: 0 });
    const theirs = await duplicates(other.s);
    expect(theirs.groups).toHaveLength(1);
    expect(theirs.groups[0]!.items.map((n) => n.name).sort()).toEqual([
      'rahasia.txt',
      'salinan.txt',
    ]);
  });

  it("puts a member's own copy next to the family's, and only lets them trash their own", async () => {
    const rt = await makeRuntime();
    rt.d1.sqlite
      .prepare(
        "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
      )
      .run();
    const owner = await signIn(rt, 'ibu-kembar@example.com');
    const member = await signIn(rt, 'adik-kembar@example.com');
    const outsider = await signIn(rt, 'luar-kembar@example.com');
    await grantPlan(rt, outsider.userId);
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
    const space = (
      (await (await owner.req('GET', '/api/me')).json()) as { space: { familyRootId: string } }
    ).space;

    const family = await uploadText(owner, space.familyRootId, 'resep.txt', 'resep nenek');
    const mine = await uploadText(member, await rootOf(member), 'resep.txt', 'resep nenek');
    // The owner's personal copy is in the same family pool, yet the member can't see it.
    const hidden = await uploadText(owner, await rootOf(owner), 'resep-ibu.txt', 'resep nenek');
    await uploadText(outsider, await rootOf(outsider), 'resep.txt', 'resep nenek');
    await rt.settle();

    const seen = await duplicates(member);
    expect(seen.groups).toHaveLength(1);
    const g = seen.groups[0]!;
    expect(ids(g)).toEqual([family.id, mine.id].sort());
    expect(g.items.find((n) => n.id === family.id)!.canRemove).toBe(false);
    expect(g.items.find((n) => n.id === mine.id)!.canRemove).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(hidden.id);
    // What the page offers is what the server allows.
    expect((await member.req('POST', '/api/nodes/trash', { ids: [family.id] })).status).not.toBe(
      200,
    );

    // The owner sees their own copy and the family's, never the member's.
    const theirs = await duplicates(owner);
    expect(theirs.groups.map(ids)).toEqual([[family.id, hidden.id].sort()]);
    expect(await duplicates(outsider)).toEqual({ groups: [], saving: 0 });
  });
});

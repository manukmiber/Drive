import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { createFolder, rootOf, uploadText, type NodeJson } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const GB = 2 ** 30;

async function fund(rt: DevRuntime, s: Session, idr: number) {
  rt.d1.sqlite
    .prepare(
      'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, ?, 0) ON CONFLICT (user_id) DO UPDATE SET balance_idr = excluded.balance_idr',
    )
    .run(s.userId, idr);
}

async function setupFamily() {
  const rt = await makeRuntime();
  rt.d1.sqlite
    .prepare(
      "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
    )
    .run();
  const owner = await signIn(rt, 'ayah@example.com');
  const member = await signIn(rt, 'anak@example.com');
  const other = await signIn(rt, 'adik@example.com');
  await fund(rt, owner, 100_000);
  // Owner already has a personal plan and private files before creating the family
  expect((await owner.req('POST', '/api/billing/plan', { planCode: 'mini' })).status).toBe(200);
  const ownerPrivate = await uploadText(
    owner,
    await rootOf(owner),
    'pajak-ayah.pdf',
    'rahasia ayah',
  );
  await rt.settle();
  const buy = await owner.req('POST', '/api/billing/plan', { planCode: 'family' });
  expect(buy.status).toBe(200);
  const invite = async () =>
    (
      (await (await owner.req('POST', '/api/family/invites', { channel: 'link' })).json()) as {
        url: string;
      }
    ).url
      .split('/')
      .pop()!;
  for (const s of [member, other]) {
    const r = await s.req('POST', `/api/family/invites/${await invite()}/accept`, {});
    expect(r.status).toBe(200);
  }
  const me = async (s: Session) =>
    (await (await s.req('GET', '/api/me')).json()) as {
      space: { familyId: string | null; familyRootId: string; personalRootId: string; poolId: string };
    };
  return { rt, owner, member, other, invite, me, ownerPrivate };
}

describe('family plan (SPEC §9)', () => {
  it("creates one shared pool and moves the owner's files into it", async () => {
    const { rt, owner, me, ownerPrivate } = await setupFamily();
    const o = await me(owner);
    expect(o.space.familyRootId).toBeTruthy();
    const pool = rt.d1.sqlite
      .prepare('SELECT owner_type, limit_bytes, used_bytes FROM storage_pools WHERE id = ?')
      .get(o.space.poolId) as { owner_type: string; limit_bytes: number; used_bytes: number };
    expect(pool).toMatchObject({ owner_type: 'family', limit_bytes: 250 * GB, used_bytes: 12 });
    expect(
      rt.d1.sqlite.prepare('SELECT pool_id FROM nodes WHERE id = ?').get(ownerPrivate.id),
    ).toEqual({ pool_id: o.space.poolId });
    const fam = (await (await owner.req('GET', '/api/family')).json()) as {
      family: { members: Array<{ role: string }> };
    };
    expect(fam.family.members.map((m) => m.role)).toEqual(['owner', 'member', 'member']);
  });

  it('permission matrix: owner / creator / other member × Pribadi / Keluarga × view / edit / delete / share', async () => {
    const { rt, owner, member, other, me, ownerPrivate } = await setupFamily();
    const m = await me(member);
    const famFile = await uploadText(member, m.space.familyRootId, 'foto-liburan.jpg', 'liburan');
    const privFile = await uploadText(member, m.space.personalRootId, 'diary.txt', 'rahasia anak');
    await rt.settle();

    const can = async (s: Session, n: NodeJson) => ({
      view: (await s.req('GET', `/api/nodes/${n.id}`)).status === 200,
      edit: (await s.req('PATCH', `/api/nodes/${n.id}`, { name: `${n.name}` })).status === 200,
      share: (await s.req('POST', '/api/shares', { nodeIds: [n.id] })).status === 201,
    });
    // Drive Keluarga: everyone sees & shares; only creator + family owner edit
    expect(await can(member, famFile)).toEqual({ view: true, edit: true, share: true });
    expect(await can(owner, famFile)).toEqual({ view: true, edit: true, share: true });
    expect(await can(other, famFile)).toEqual({ view: true, edit: false, share: true });
    expect((await other.req('POST', '/api/nodes/trash', { ids: [famFile.id] })).status).toBe(403);
    // Pribadi: nobody else, not even the family owner
    expect(await can(owner, privFile)).toEqual({ view: false, edit: false, share: false });
    expect(await can(other, privFile)).toEqual({ view: false, edit: false, share: false });
    expect(await can(member, ownerPrivate)).toEqual({ view: false, edit: false, share: false });
    expect((await owner.req('POST', '/api/nodes/trash', { ids: [privFile.id] })).status).toBe(404);
    expect((await owner.req('GET', `/api/files/${privFile.id}/download`)).status).toBe(404);
    // family_can_edit lets other members edit
    rt.d1.sqlite.prepare('UPDATE nodes SET family_can_edit = 1 WHERE id = ?').run(famFile.id);
    expect((await can(other, famFile)).edit).toBe(true);
    // Creator and owner may delete
    expect((await owner.req('POST', '/api/nodes/trash', { ids: [famFile.id] })).status).toBe(200);
  });

  it('the owner never sees private file names: not in search, recent, starred, family overview or export', async () => {
    const { rt, owner, member, me } = await setupFamily();
    const m = await me(member);
    await uploadText(member, m.space.personalRootId, 'surat-rahasia-anak.txt', 'x');
    await rt.settle();
    const hay = JSON.stringify([
      await (await owner.req('GET', '/api/search?q=surat')).json(),
      await (await owner.req('GET', '/api/recent')).json(),
      await (await owner.req('GET', '/api/starred')).json(),
      await (await owner.req('GET', '/api/family')).json(),
      await (await owner.req('GET', '/api/me/export')).json(),
    ]);
    expect(hay).not.toContain('surat-rahasia-anak');
    // …but totals per member are visible
    const fam = (await (await owner.req('GET', '/api/family')).json()) as {
      family: { members: Array<{ email: string; usedBytes: number }> };
    };
    expect(fam.family.members.find((x) => x.email === 'anak@example.com')?.usedBytes).toBe(1);
  });

  it('moving Pribadi → Keluarga needs confirmation; Keluarga → Pribadi only for own items', async () => {
    const { rt, member, other, me } = await setupFamily();
    const m = await me(member);
    const f = await uploadText(member, m.space.personalRootId, 'resep.txt', 'resep');
    await rt.settle();
    const need = await member.req('POST', '/api/nodes/move', {
      ids: [f.id],
      targetId: m.space.familyRootId,
    });
    expect(need.status).toBe(409);
    expect(((await need.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe(
      'SPACE_CHANGE',
    );
    expect(
      (
        await member.req('POST', '/api/nodes/move', {
          ids: [f.id],
          targetId: m.space.familyRootId,
          confirmSpaceChange: true,
        })
      ).status,
    ).toBe(200);
    expect((await other.req('GET', `/api/nodes/${f.id}`)).status).toBe(200);
    const folder = await createFolder(member, m.space.familyRootId, 'Campur');
    await uploadText(other, folder.id, 'punya-adik.txt', 'a');
    await rt.settle();
    const back = await member.req('POST', '/api/nodes/move', {
      ids: [folder.id],
      targetId: m.space.personalRootId,
      confirmSpaceChange: true,
    });
    expect(back.status).toBe(403);
    expect(
      (
        await member.req('POST', '/api/nodes/move', {
          ids: [f.id],
          targetId: m.space.personalRootId,
          confirmSpaceChange: true,
        })
      ).status,
    ).toBe(200);
    expect((await other.req('GET', `/api/nodes/${f.id}`)).status).toBe(404);
  });

  it('leaving: private files go home, family items pass to the owner, account becomes read-only', async () => {
    const { rt, owner, member, other, me } = await setupFamily();
    const m = await me(member);
    const mine = await uploadText(member, m.space.personalRootId, 'pribadi.txt', '12345');
    const shared = await uploadText(member, m.space.familyRootId, 'bersama.txt', 'abc');
    await rt.settle();
    // A copy of a private file inside Drive Keluarga shares the blob → must be split on leave
    const famCopy = (
      (await (
        await member.req('POST', `/api/nodes/${mine.id}/copy`, { targetId: m.space.familyRootId })
      ).json()) as { node: NodeJson }
    ).node;
    expect((await member.req('POST', '/api/family/leave')).status).toBe(204);
    const after = await me(member);
    expect(after.space.familyId).toBeNull();
    const mineRow = rt.d1.sqlite
      .prepare('SELECT pool_id, blob_id FROM nodes WHERE id = ?')
      .get(mine.id) as { pool_id: string; blob_id: string };
    expect(mineRow.pool_id).toBe(after.space.poolId);
    const copyRow = rt.d1.sqlite
      .prepare('SELECT pool_id, blob_id FROM nodes WHERE id = ?')
      .get(famCopy.id) as { pool_id: string; blob_id: string };
    expect(copyRow.blob_id).not.toBe(mineRow.blob_id);
    const blobPools = rt.d1.sqlite
      .prepare('SELECT pool_id FROM blobs WHERE id IN (?, ?)')
      .all(mineRow.blob_id, copyRow.blob_id) as Array<{ pool_id: string }>;
    expect(new Set(blobPools.map((b) => b.pool_id)).size).toBe(2);
    expect(
      await (
        await member.req(
          'GET',
          (
            (await (await member.req('GET', `/api/files/${mine.id}/download`)).json()) as {
              url: string;
            }
          ).url,
        )
      ).text(),
    ).toBe('12345');
    expect(rt.d1.sqlite.prepare('SELECT owner_id FROM nodes WHERE id = ?').get(shared.id)).toEqual({
      owner_id: owner.userId,
    });
    expect((await other.req('GET', `/api/nodes/${shared.id}`)).status).toBe(200);
    expect((await member.req('GET', `/api/nodes/${shared.id}`)).status).toBe(404);
    const sub = (await (await member.req('GET', '/api/billing')).json()) as {
      subscription: { status: string };
    };
    expect(sub.subscription.status).toBe('readonly');
    // Cooldown: can't hop straight into another family
    const token = (
      (await (await owner.req('POST', '/api/family/invites', { channel: 'link' })).json()) as {
        url: string;
      }
    ).url
      .split('/')
      .pop()!;
    const back = await member.req('POST', `/api/family/invites/${token}/accept`, {});
    expect(((await back.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe(
      'FAMILY_COOLDOWN',
    );
  });

  it('invites: single-use, expire, family size limit, personal plan conversion', async () => {
    const { rt, owner, invite } = await setupFamily();
    const t = await invite();
    const extra = await signIn(rt, 'keempat@example.com');
    const full = await extra.req('POST', `/api/family/invites/${t}/accept`, {});
    expect(((await full.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe(
      'FAMILY_FULL',
    );
    rt.d1.sqlite.prepare("UPDATE plans SET max_members = 6 WHERE code = 'family'").run();
    // Has an active personal plan → must confirm conversion to Saldo
    await fund(rt, extra, 10_000);
    await extra.req('POST', '/api/billing/plan', { planCode: 'basic' });
    const needs = await extra.req('POST', `/api/family/invites/${t}/accept`, {});
    expect(
      ((await needs.json()) as { error: { data: { reason: string } } }).error.data.reason,
    ).toBe('NEEDS_CONVERT');
    const ok = await extra.req('POST', `/api/family/invites/${t}/accept`, { convertPlan: true });
    expect(((await ok.json()) as { convertedIdr: number }).convertedIdr).toBeGreaterThan(4_900);
    const fifth = await signIn(rt, 'kelima@example.com');
    expect((await fifth.req('POST', `/api/family/invites/${t}/accept`, {})).status).toBe(404); // used
    // Member caps
    const fam = (await (await owner.req('GET', '/api/family')).json()) as {
      family: { members: Array<{ id: string; email: string }> };
    };
    const ex = fam.family.members.find((x) => x.email === 'keempat@example.com')!;
    await owner.req('PATCH', `/api/family/members/${ex.id}`, { capBytes: 10 });
    const me = (await (await extra.req('GET', '/api/me')).json()) as {
      space: { familyRootId: string };
    };
    const big = await extra.req('POST', '/api/uploads', {
      parentId: me.space.familyRootId,
      name: 'besar.bin',
      size: 11,
    });
    expect(((await big.json()) as { error: { data: { reason: string } } }).error.data.reason).toBe(
      'MEMBER_CAP',
    );
  });

  it('dissolving returns everything to the owner as a normal folder', async () => {
    const { rt, owner, member, other, me } = await setupFamily();
    await member.req('POST', '/api/family/leave');
    await owner.req('DELETE', `/api/family/members/${other.userId}`);
    const o = await me(owner);
    const f = await uploadText(owner, o.space.familyRootId, 'album.txt', 'a');
    await rt.settle();
    const r = await owner.req('POST', '/api/family/dissolve');
    expect(r.status).toBe(200);
    const after = await me(owner);
    expect(after.space.familyId).toBeNull();
    const node = rt.d1.sqlite
      .prepare('SELECT space, pool_id FROM nodes WHERE id = ?')
      .get(f.id) as { space: string; pool_id: string };
    expect(node).toEqual({ space: 'personal', pool_id: after.space.poolId });
    expect(
      ((await (await owner.req('GET', '/api/billing')).json()) as { balanceIdr: number })
        .balanceIdr,
    ).toBeGreaterThan(49_000);
  });
});

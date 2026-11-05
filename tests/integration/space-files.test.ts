// W1e (ADR-099): a Space's files — one top folder per Space, counted on the team owner's storage,
// opened by the Space's admins and members, closed to guests and everyone else.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { invalidateConfigMemo } from '../../src/worker/services/config';
import { purgeExpiredTrash } from '../../src/worker/services/nodes';
import { createCtx } from '../../src/worker/context';
import { createFolder, grantPlan, pool, rootOf, uploadText, type NodeJson } from '../helpers/files';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

async function json<T>(s: Session, method: string, path: string, body?: unknown, want = 200) {
  const res = await s.req(method, path, body);
  expect(res.status, `${method} ${path}: ${await res.clone().text()}`).toBe(want);
  return (await res.json()) as T;
}

async function setup() {
  const rt = await makeRuntime();
  rt.d1.sqlite
    .prepare(
      `INSERT INTO app_config (key, value_json, updated_by, updated_at) VALUES ('spaces_open', 'true', 'test', 0)`,
    )
    .run();
  invalidateConfigMemo(rt.env);
  const owner = await signIn(rt, 'pemilik-file@example.com');
  const member = await signIn(rt, 'anggota-file@example.com');
  const guest = await signIn(rt, 'tamu-file@example.com');
  const stranger = await signIn(rt, 'orang-file@example.com');
  const ownerPool = await grantPlan(rt, owner.userId);
  const { team } = await json<{ team: { id: string } }>(
    owner,
    'POST',
    '/api/teams',
    { name: 'Studio' },
    201,
  );
  await json(owner, 'POST', `/api/teams/${team.id}/members`, { email: 'anggota-file@example.com' });
  const { space } = await json<{ space: { id: string } }>(
    owner,
    'POST',
    `/api/teams/${team.id}/spaces`,
    { name: 'Klien A' },
    201,
  );
  await json(owner, 'POST', `/api/spaces/${space.id}/members`, {
    email: 'anggota-file@example.com',
    role: 'member',
  });
  await json(owner, 'POST', `/api/spaces/${space.id}/members`, {
    email: 'tamu-file@example.com',
    role: 'guest',
  });
  return { rt, owner, member, guest, stranger, team, space, ownerPool };
}

const node = (rt: DevRuntime, id: string) =>
  rt.d1.sqlite.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
    | {
        pool_id: string;
        owner_id: string;
        space: string;
        created_by: string;
        trashed_at: number | null;
      }
    | undefined;

describe('Space files (W1e, ADR-099)', () => {
  it('makes one top folder on first open, on the team owner’s storage', async () => {
    const { rt, owner, member, space, ownerPool } = await setup();
    const before = await json<{ files: { rootId: string | null } }>(
      member,
      'GET',
      `/api/spaces/${space.id}`,
    );
    expect(before.files).toEqual({ rootId: null });

    const [a, b] = await Promise.all([
      json<{ rootId: string }>(member, 'POST', `/api/spaces/${space.id}/files`),
      json<{ rootId: string }>(owner, 'POST', `/api/spaces/${space.id}/files`),
    ]);
    expect(a.rootId).toBe(b.rootId);
    expect(node(rt, a.rootId)).toMatchObject({
      pool_id: ownerPool,
      owner_id: owner.userId,
      space: 'team',
    });
    expect(
      (
        rt.d1.sqlite.prepare(`SELECT COUNT(*) AS n FROM nodes WHERE space = 'team'`).get() as {
          n: number;
        }
      ).n,
    ).toBe(1);

    // A member's upload belongs to the Space (its owner) and counts on the owner's storage.
    const f = await uploadText(member, a.rootId, 'brief.txt', 'halo tim');
    await rt.settle();
    expect(node(rt, f.id)).toMatchObject({ owner_id: owner.userId, created_by: member.userId });
    expect(pool(rt, ownerPool).used_bytes).toBe(8);
    const list = await json<{ items: NodeJson[]; path: Array<{ id: string; name: string }> }>(
      owner,
      'GET',
      `/api/nodes/${a.rootId}/children`,
    );
    expect(list.items.map((i) => i.name)).toEqual(['brief.txt']);
    expect(list.path.map((p) => p.name)).toEqual(['Klien A']);
  });

  it('is closed to guests and to people outside the Space', async () => {
    const { owner, guest, stranger, space } = await setup();
    const { rootId } = await json<{ rootId: string }>(
      owner,
      'POST',
      `/api/spaces/${space.id}/files`,
    );
    const f = await uploadText(owner, rootId, 'rahasia.txt', 'x');
    expect(
      (await json<{ files: unknown }>(guest, 'GET', `/api/spaces/${space.id}`)).files,
    ).toBeNull();
    expect((await guest.req('POST', `/api/spaces/${space.id}/files`)).status).toBe(403);
    expect((await stranger.req('POST', `/api/spaces/${space.id}/files`)).status).toBe(404);
    for (const s of [guest, stranger]) {
      expect((await s.req('GET', `/api/nodes/${rootId}/children`)).status).toBe(404);
      expect((await s.req('GET', `/api/nodes/${f.id}`)).status).toBe(404);
      expect((await s.req('GET', `/api/files/${f.id}/download`)).status).toBe(404);
    }
  });

  it('lets members change everything but remove only their own; admins remove anything', async () => {
    const { owner, member, space } = await setup();
    const { rootId } = await json<{ rootId: string }>(
      owner,
      'POST',
      `/api/spaces/${space.id}/files`,
    );
    const mine = await uploadText(member, rootId, 'catatan.txt', 'a');
    const theirs = await uploadText(owner, rootId, 'kontrak.txt', 'b');
    expect(
      (await member.req('PATCH', `/api/nodes/${theirs.id}`, { name: 'kontrak-v2.txt' })).status,
    ).toBe(200);
    expect((await member.req('POST', '/api/nodes/trash', { ids: [theirs.id] })).status).toBe(403);
    expect((await member.req('POST', '/api/nodes/trash', { ids: [mine.id] })).status).toBe(200);
    expect((await owner.req('POST', '/api/nodes/trash', { ids: [theirs.id] })).status).toBe(200);
    // The top folder itself stays.
    expect((await owner.req('POST', '/api/nodes/trash', { ids: [rootId] })).status).toBe(403);
    expect((await owner.req('PATCH', `/api/nodes/${rootId}`, { name: 'lain' })).status).toBe(403);
    // What they trashed is in their own Trash.
    const trash = await json<{ items: NodeJson[] }>(member, 'GET', '/api/trash');
    expect(trash.items.map((i) => i.name)).toContain('catatan.txt');
  });

  it('keeps items inside their Space: no moves to a personal Drive or another Space', async () => {
    const { owner, team, space } = await setup();
    const { rootId } = await json<{ rootId: string }>(
      owner,
      'POST',
      `/api/spaces/${space.id}/files`,
    );
    const { space: other } = await json<{ space: { id: string } }>(
      owner,
      'POST',
      `/api/teams/${team.id}/spaces`,
      { name: 'Klien B' },
      201,
    );
    const otherRoot = (
      await json<{ rootId: string }>(owner, 'POST', `/api/spaces/${other.id}/files`)
    ).rootId;
    const f = await uploadText(owner, rootId, 'a.txt', 'a');
    const sub = await createFolder(owner, rootId, 'Desain');
    const personal = await rootOf(owner);
    const own = await uploadText(owner, personal, 'pribadi.txt', 'p');
    for (const [ids, to] of [
      [[f.id], personal],
      [[f.id], otherRoot],
      [[own.id], rootId],
    ] as const) {
      const res = await owner.req('POST', '/api/nodes/move', { ids, targetId: to });
      expect(res.status, await res.clone().text()).toBe(403);
    }
    expect(
      (await owner.req('POST', '/api/nodes/move', { ids: [f.id], targetId: sub.id })).status,
    ).toBe(200);
  });

  it('goes with its Space, and changes hands with its team', async () => {
    const { rt, owner, member, team, space, ownerPool } = await setup();
    const memberPool = await grantPlan(rt, member.userId);
    const { rootId } = await json<{ rootId: string }>(
      owner,
      'POST',
      `/api/spaces/${space.id}/files`,
    );
    const f = await uploadText(owner, rootId, 'laporan.txt', 'isi laporan');
    await rt.settle();
    expect(pool(rt, ownerPool).used_bytes).toBe(11);

    await json(owner, 'POST', `/api/teams/${team.id}/owner`, { userId: member.userId });
    expect(node(rt, f.id)).toMatchObject({ pool_id: memberPool, owner_id: member.userId });
    expect(pool(rt, ownerPool).used_bytes).toBe(0);
    expect(pool(rt, memberPool).used_bytes).toBe(11);

    expect((await member.req('DELETE', `/api/spaces/${space.id}`)).status).toBe(204);
    expect(node(rt, f.id)?.trashed_at).not.toBeNull();
    // Nobody's Trash shows it, and the purge frees the storage.
    for (const s of [owner, member])
      expect((await json<{ items: NodeJson[] }>(s, 'GET', '/api/trash')).items).toEqual([]);
    await purgeExpiredTrash(createCtx(rt.env));
    await rt.settle();
    expect(node(rt, f.id)).toBeUndefined();
    expect(node(rt, rootId)).toBeUndefined();
    expect(pool(rt, memberPool).used_bytes).toBe(0);
  });
});

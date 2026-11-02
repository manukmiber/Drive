// D10 (ADR-093): albums are references to files, kept next to the space's index in R2. A family
// album shows each member only what they may see; files that are gone drop out; nobody reaches
// another person's album.
import { describe, expect, it } from 'vitest';
import type { DevRuntime } from '../../dev/env';
import { createFolder, grantPlan, rootOf, simpleUpload, uploadText } from '../helpers/files';
import { jpeg, tiff } from '../helpers/media';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';

interface AlbumJson {
  id: string;
  name: string;
  space: 'personal' | 'family';
  count: number;
  coverId: string | null;
  canManage: boolean;
}

const photo = (date: string) => jpeg(tiff({ date, offset: '+07:00' }), 400, 300);

async function upload(s: Session, parent: string, name: string, date: string) {
  const res = await simpleUpload(s, parent, name, photo(date), { mime: 'image/jpeg' });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { node: { id: string } }).node.id;
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (status === 204 ? undefined : await res.json()) as T;
}

function fund(rt: DevRuntime, s: Session, idr: number) {
  rt.d1.sqlite
    .prepare(
      'INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, ?, 0) ON CONFLICT (user_id) DO UPDATE SET balance_idr = excluded.balance_idr',
    )
    .run(s.userId, idr);
}

async function family() {
  const rt = await makeRuntime();
  rt.d1.sqlite
    .prepare(
      "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
    )
    .run();
  const owner = await signIn(rt, 'ibu@example.com');
  const member = await signIn(rt, 'kakak@example.com');
  const outsider = await signIn(rt, 'tetangga@example.com');
  fund(rt, owner, 100_000);
  const buy = (code: string) =>
    owner.req('POST', '/api/billing/checkout', { item: { kind: 'plan', code } });
  expect((await buy('mini')).status).toBe(200);
  expect((await buy('family')).status).toBe(200);
  const invite = (
    (await (await owner.req('POST', '/api/family/invites', { channel: 'link' })).json()) as {
      url: string;
    }
  ).url
    .split('/')
    .pop()!;
  expect((await member.req('POST', `/api/family/invites/${invite}/accept`, {})).status).toBe(200);
  const me = (await (await owner.req('GET', '/api/me')).json()) as {
    space: { familyRootId: string };
  };
  return { rt, owner, member, outsider, famRoot: me.space.familyRootId };
}

describe('Albums (D10, ADR-093)', () => {
  it('holds references in its own order, takes only photos and videos, and adds no storage', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'album@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const a = await upload(s, root, 'a.jpg', '2024:01:01 10:00:00');
    const b = await upload(s, root, 'b.jpg', '2024:06:01 10:00:00');
    const note = await uploadText(s, root, 'catatan.txt', 'bukan foto');
    await rt.settle();
    const used = () =>
      rt.d1.sqlite.prepare('SELECT used_bytes AS u FROM storage_pools').get() as { u: number };
    const before = used().u;
    const { album } = await ok<{ album: AlbumJson }>(
      await s.req('POST', '/api/albums', { name: 'Liburan', nodeIds: [b, a, note.id] }),
      201,
    );
    expect(album).toMatchObject({ name: 'Liburan', count: 2, coverId: b, canManage: true });
    expect(used().u).toBe(before);
    const one = await ok<{ items: Array<{ id: string }> }>(
      await s.req('GET', `/api/albums/${album.id}`),
    );
    expect(one.items.map((i) => i.id)).toEqual([b, a]);
    // Sorted by when they were taken, renamed, a cover, then rearranged by hand.
    await ok(await s.req('PATCH', `/api/albums/${album.id}`, { sort: 'oldest', name: 'Bali' }));
    expect(
      (
        await ok<{ items: Array<{ id: string }> }>(await s.req('GET', `/api/albums/${album.id}`))
      ).items.map((i) => i.id),
    ).toEqual([a, b]);
    const covered = await ok<{ album: AlbumJson }>(
      await s.req('PATCH', `/api/albums/${album.id}`, { coverId: a, order: [b] }),
    );
    expect(covered.album).toMatchObject({ name: 'Bali', coverId: a });
    expect(
      (
        await ok<{ items: Array<{ id: string }> }>(await s.req('GET', `/api/albums/${album.id}`))
      ).items.map((i) => i.id),
    ).toEqual([b, a]);
    // A file that isn't in it can't be its cover.
    expect((await s.req('PATCH', `/api/albums/${album.id}`, { coverId: note.id })).status).toBe(
      400,
    );
    const list = await ok<{ items: AlbumJson[] }>(await s.req('GET', '/api/albums'));
    expect(list.items.map((x) => x.name)).toEqual(['Bali']);
    // Kept in R2 next to the index, and in the data export.
    expect(await rt.r2.head(`u/${s.userId}/albums.json`)).not.toBeNull();
  });

  it('files in the Trash leave the view, files deleted for good leave the album', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'sampah@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const folder = await createFolder(s, root, 'Foto');
    const a = await upload(s, folder.id, 'a.jpg', '2024:01:01 10:00:00');
    const b = await upload(s, root, 'b.jpg', '2024:01:02 10:00:00');
    await rt.settle();
    const { album } = await ok<{ album: AlbumJson }>(
      await s.req('POST', '/api/albums', { name: 'Semua', nodeIds: [a, b] }),
      201,
    );
    // The folder goes to the Trash: its photo is out of sight, and back when restored.
    expect((await s.req('POST', '/api/nodes/trash', { ids: [folder.id] })).status).toBe(200);
    await rt.settle();
    const count = async () =>
      (await ok<{ album: AlbumJson }>(await s.req('GET', `/api/albums/${album.id}`))).album.count;
    expect(await count()).toBe(1);
    expect((await s.req('POST', '/api/nodes/restore', { ids: [folder.id] })).status).toBe(200);
    await rt.settle();
    expect(await count()).toBe(2);
    // Deleted for good: gone from the album the next time it is written.
    expect((await s.req('POST', '/api/nodes/trash', { ids: [b] })).status).toBe(200);
    expect((await s.req('POST', '/api/nodes/delete', { ids: [b] })).status).toBe(200);
    await rt.settle();
    await ok(await s.req('PATCH', `/api/albums/${album.id}`, { name: 'Sisa' }));
    const stored = JSON.parse(
      await ((await rt.r2.get(`u/${s.userId}/albums.json`)) as R2ObjectBody).text(),
    ) as {
      albums: Array<{ items: string[] }>;
    };
    expect(stored.albums[0]!.items).toEqual([a]);
  });

  it('a family album shows each member what they may see; outsiders reach nothing', async () => {
    const { rt, owner, member, outsider, famRoot } = await family();
    const ownRoot = await rootOf(owner);
    const shared = await upload(owner, famRoot, 'keluarga.jpg', '2024:03:03 10:00:00');
    const mine = await upload(owner, ownRoot, 'pribadi.jpg', '2024:03:04 10:00:00');
    const theirs = await upload(member, famRoot, 'kakak.jpg', '2024:03:05 10:00:00');
    await rt.settle();
    const { album } = await ok<{ album: AlbumJson }>(
      await owner.req('POST', '/api/albums', {
        name: 'Lebaran',
        space: 'family',
        nodeIds: [shared, mine, theirs],
      }),
      201,
    );
    expect(album.count).toBe(3);
    const seen = await ok<{ album: AlbumJson; items: Array<{ id: string }> }>(
      await member.req('GET', `/api/albums/${album.id}`),
    );
    expect(seen.items.map((i) => i.id)).toEqual([shared, theirs]);
    expect(seen.album.canManage).toBe(false);
    // A member adds and removes photos, but may not rename someone else's album.
    expect((await member.req('PATCH', `/api/albums/${album.id}`, { name: 'Punyaku' })).status).toBe(
      403,
    );
    await ok(await member.req('PATCH', `/api/albums/${album.id}`, { remove: [theirs, mine] }));
    // What the member could not see stays for the owner.
    const after = await ok<{ items: Array<{ id: string }> }>(
      await owner.req('GET', `/api/albums/${album.id}`),
    );
    expect(after.items.map((i) => i.id)).toEqual([shared, mine]);
    // Nobody else reaches it, whatever they try.
    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', { name: 'x' }],
      ['DELETE', undefined],
    ] as const)
      expect((await outsider.req(method, `/api/albums/${album.id}`, body)).status).toBe(404);
    expect(
      (await ok<{ items: AlbumJson[] }>(await outsider.req('GET', '/api/albums'))).items,
    ).toEqual([]);
    // Outsiders can't slip their own files into it either, nor someone else's into theirs.
    const own = await ok<{ album: AlbumJson }>(
      await outsider.req('POST', '/api/albums', { name: 'Coba', nodeIds: [shared, mine] }),
      201,
    );
    expect(own.album.count).toBe(0);
    await ok(await owner.req('DELETE', `/api/albums/${album.id}`), 204);
    expect((await member.req('GET', `/api/albums/${album.id}`)).status).toBe(404);
  });
});

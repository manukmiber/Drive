// Folder decoration (ADR-058): colour, icon, cover; who may change it; a cover never shows an image
// the viewer may not see, and falls back when the image goes.
import { describe, expect, it } from 'vitest';
import { makeRuntime } from '../helpers/runtime';
import { signIn, type Session } from '../helpers/session';
import { createFolder, grantPlan, rootOf, simpleUpload, type NodeJson } from '../helpers/files';
import type { DevRuntime } from '../../dev/env';

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
]);
const WEBP = (() => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(b.buffer).setUint32(4, b.length - 8, true);
  b.set(new TextEncoder().encode('WEBPVP8X'), 8);
  return b;
})();

type Decor = { color: string | null; icon: string | null; coverId: string | null } | null;

async function image(
  rt: DevRuntime,
  s: Session,
  parentId: string,
  name = 'sampul.png',
  thumb = true,
) {
  const res = await simpleUpload(s, parentId, name, PNG);
  expect(res.status, await res.clone().text()).toBe(201);
  const node = ((await res.json()) as { node: NodeJson }).node;
  await rt.settle();
  if (thumb) {
    const t = await s.req('PUT', `/api/files/${node.id}/thumbnail`, undefined, {
      body: WEBP,
      headers: { 'content-type': 'image/webp', 'content-length': String(WEBP.length) },
    });
    expect(t.status).toBe(204);
  }
  return node;
}

const decorate = (s: Session, ids: string[], patch: Record<string, unknown>) =>
  s.req('POST', '/api/nodes/decor', { ids, ...patch });

async function decorOf(s: Session, parentId: string, id: string): Promise<Decor> {
  const res = await s.req('GET', `/api/nodes/${parentId}/children`);
  const { items } = (await res.json()) as { items: Array<{ id: string; decor: Decor }> };
  return items.find((i) => i.id === id)!.decor;
}

describe('folder decoration (ADR-058)', () => {
  it('sets colour, icon and cover on several folders, keeps what is left out, and clears', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'rapi@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const a = await createFolder(s, root, 'Kuliah');
    const b = await createFolder(s, root, 'Kerja');
    const pic = await image(rt, s, a.id);

    const res = await decorate(s, [a.id, b.id], { color: 'teal', icon: 'graduation-cap' });
    expect(res.status).toBe(200);
    expect(await decorOf(s, root, b.id)).toEqual({
      color: 'teal',
      icon: 'graduation-cap',
      coverId: null,
    });

    expect((await decorate(s, [a.id], { coverId: pic.id, icon: '📚' })).status).toBe(200);
    expect(await decorOf(s, root, a.id)).toEqual({ color: 'teal', icon: '📚', coverId: pic.id });
    // The open folder carries it too (the banner), and the breadcrumb its colour and icon.
    const open = (await (await s.req('GET', `/api/nodes/${a.id}`)).json()) as {
      node: { decor: Decor };
      path: Array<{ id: string; color: string | null; icon: string | null }>;
    };
    expect(open.node.decor?.coverId).toBe(pic.id);
    const inside = (await (await s.req('GET', `/api/nodes/${a.id}/children`)).json()) as {
      folder: { decor: Decor };
    };
    expect(inside.folder.decor?.coverId).toBe(pic.id);
    expect(open.path.at(-1)).toMatchObject({ id: a.id, color: 'teal', icon: '📚' });

    expect(
      (await decorate(s, [a.id, b.id], { color: null, icon: null, coverId: null })).status,
    ).toBe(200);
    expect(await decorOf(s, root, a.id)).toBeNull();
    expect(await decorOf(s, root, b.id)).toBeNull();
  });

  it('refuses colours, icons and covers outside the rules', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'aturan@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const f = await createFolder(s, root, 'Folder');
    const noThumb = await image(rt, s, f.id, 'mentah.png', false);
    const text = (
      (await (await simpleUpload(s, f.id, 'catatan.txt', 'teks')).json()) as { node: NodeJson }
    ).node;
    await rt.settle();
    for (const bad of [
      { color: '#ff0000' },
      { icon: 'skull' },
      { icon: 'ab' },
      { icon: '😀😀' },
      { coverId: text.id },
    ])
      expect((await decorate(s, [f.id], bad)).status, JSON.stringify(bad)).toBe(400);
    const pending = await decorate(s, [f.id], { coverId: noThumb.id });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toMatchObject({ error: { data: { reason: 'NO_THUMBNAIL' } } });
    // A file is not a folder, and the root is not decorated.
    expect((await decorate(s, [text.id], { color: 'red' })).status).toBe(400);
    expect((await decorate(s, [root], { color: 'red' })).status).toBe(403);
  });

  it('falls back to icon and colour when the cover goes to the trash', async () => {
    const rt = await makeRuntime();
    const s = await signIn(rt, 'sampul@example.com');
    await grantPlan(rt, s.userId);
    const root = await rootOf(s);
    const f = await createFolder(s, root, 'Liburan');
    const pic = await image(rt, s, f.id);
    await decorate(s, [f.id], { color: 'sky', coverId: pic.id });
    expect((await s.req('POST', '/api/nodes/trash', { ids: [pic.id] })).status).toBe(200);
    expect(await decorOf(s, root, f.id)).toEqual({ color: 'sky', icon: null, coverId: null });
    await s.req('POST', '/api/nodes/restore', { ids: [pic.id] });
    expect((await decorOf(s, root, f.id))?.coverId).toBe(pic.id);
  });

  it('in a family: members who may edit decorate; a private photo never becomes a shared cover', async () => {
    const rt = await makeRuntime();
    rt.d1.sqlite
      .prepare(
        "UPDATE plans SET active = 1, price_idr = 50000, max_members = 3 WHERE code = 'family'",
      )
      .run();
    const owner = await signIn(rt, 'bunda@example.com');
    const member = await signIn(rt, 'kakak@example.com');
    rt.d1.sqlite
      .prepare('INSERT INTO wallets (user_id, balance_idr, updated_at) VALUES (?, 100000, 0)')
      .run(owner.userId);
    expect(
      (await owner.req('POST', '/api/billing/checkout', { item: { kind: 'plan', code: 'family' } }))
        .status,
    ).toBe(200);
    const { url } = (await (
      await owner.req('POST', '/api/family/invites', { channel: 'link' })
    ).json()) as { url: string };
    expect(
      (await member.req('POST', `/api/family/invites/${url.split('/').pop()}/accept`, {})).status,
    ).toBe(200);
    const space = (await (await owner.req('GET', '/api/me')).json()) as {
      space: { familyRootId: string; personalRootId: string };
    };
    const famRoot = space.space.familyRootId;
    const shared = await createFolder(owner, famRoot, 'Foto Keluarga');
    const sharedPic = await image(rt, owner, shared.id, 'bersama.png');
    const privatePic = await image(rt, owner, space.space.personalRootId, 'pribadi.png');

    // Someone else's folder, not editable by members: no.
    expect((await decorate(member, [shared.id], { color: 'pink' })).status).toBe(403);
    // A photo from the owner's own space would show to the whole family: no.
    const leak = await decorate(owner, [shared.id], { coverId: privatePic.id });
    expect(leak.status).toBe(400);
    expect(await leak.json()).toMatchObject({ error: { data: { reason: 'COVER_OTHER_SPACE' } } });
    expect(
      (await decorate(owner, [shared.id], { coverId: sharedPic.id, color: 'pink' })).status,
    ).toBe(200);
    expect((await decorOf(member, famRoot, shared.id))?.coverId).toBe(sharedPic.id);
    expect((await member.req('GET', `/api/files/${sharedPic.id}/thumbnail`)).status).toBe(200);

    // A cover set long ago that has since moved out of the family's space is not shown, and its
    // thumbnail stays out of reach.
    rt.d1.sqlite
      .prepare('UPDATE nodes SET decor_cover_id = ? WHERE id = ?')
      .run(privatePic.id, shared.id);
    expect(await decorOf(member, famRoot, shared.id)).toEqual({
      color: 'pink',
      icon: null,
      coverId: null,
    });
    expect((await member.req('GET', `/api/files/${privatePic.id}/thumbnail`)).status).toBe(404);

    // Members may decorate the folders they made.
    const mine = await createFolder(member, famRoot, 'Tugas');
    expect((await decorate(member, [mine.id], { icon: 'book-open' })).status).toBe(200);
  });
});
